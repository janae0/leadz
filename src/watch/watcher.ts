import { config } from "../config.js";
import { one, query, withAdvisoryLock, withTx, type Queryable, pool } from "../db/pool.js";
import { recordEvent } from "../events.js";
import { notifyAdmin } from "../send/scheduler.js";
import { getTransport, type InboundMessage, type MailTransport } from "../send/gmail.js";
import { stopEnrollment } from "../send/sequence.js";
import { suppressEmail } from "../suppression.js";
import { getSettings, getState, setState } from "../settings.js";
import { addDays, formatLocal, nextSendSlot } from "../util/time.js";
import { classifyInbound, freshText, type Classification } from "./classify.js";

export interface WatcherResult {
  seen: number;
  matched: number;
  byKind: Record<string, number>;
}

interface Match {
  leadId: number;
  enrollmentId: number | null;
  businessName: string;
}

async function matchLead(msg: InboundMessage, c: Classification): Promise<Match | undefined> {
  // Thread ID links replies to the lead.
  const byThread = await one<Match>(
    `SELECT e.lead_id AS "leadId", e.id AS "enrollmentId", l.business_name AS "businessName"
     FROM messages m JOIN enrollments e ON e.id = m.enrollment_id JOIN leads l ON l.id = e.lead_id
     WHERE m.gmail_thread_id = $1 ORDER BY m.id DESC LIMIT 1`,
    [msg.threadId],
  );
  if (byThread) return byThread;
  // Bounces often arrive in their own thread: match on the failed address.
  const address = c.kind === "bounce" ? c.failedRecipient : msg.from;
  if (!address) return undefined;
  return one<Match>(
    `SELECT l.id AS "leadId", e.id AS "enrollmentId", l.business_name AS "businessName"
     FROM messages m JOIN enrollments e ON e.id = m.enrollment_id JOIN leads l ON l.id = e.lead_id
     WHERE lower(m.to_email) = lower($1) AND m.status = 'sent' ORDER BY m.sent_at DESC LIMIT 1`,
    [address],
  );
}

// Opt-out from any path (reply, footer link, one-click header): stop, add to
// suppression within minutes, never contact again.
export async function unsubscribeLead(leadId: number | null, email: string, via: string, db: Queryable = pool): Promise<void> {
  await suppressEmail(email, "unsubscribe", db);
  if (leadId === null) return;
  await stopEnrollment(leadId, "unsubscribe", db);
  await query(
    `UPDATE leads SET stage = 'unsubscribed', next_action = NULL, next_action_at = NULL, walk_in = false, updated_at = now()
     WHERE id = $1 AND stage NOT IN ('signed', 'paid')`,
    [leadId],
    db,
  );
  await recordEvent(leadId, "unsubscribe", { via, email }, db);
}

async function applyClassification(msg: InboundMessage, c: Classification, match: Match, transport: MailTransport): Promise<void> {
  const snippet = freshText(msg.text).slice(0, 1000);
  await withTx(async (db) => {
    await query(
      `INSERT INTO inbound (lead_id, gmail_message_id, gmail_thread_id, from_email, subject, snippet, classification, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (gmail_message_id) DO NOTHING`,
      [match.leadId, msg.id, msg.threadId, msg.from, msg.subject, snippet, c.kind, msg.receivedAt],
      db,
    );
    switch (c.kind) {
      case "reply":
        await stopEnrollment(match.leadId, "reply", db);
        await query(
          "UPDATE leads SET stage = 'replied', next_action = 'answer reply', next_action_at = now(), updated_at = now() WHERE id = $1 AND stage IN ('approved', 'contacted')",
          [match.leadId],
          db,
        );
        await recordEvent(match.leadId, "reply", { gmail_message_id: msg.id }, db);
        break;
      case "auto_reply": {
        // Pause: push the next step back to the stated return date, or 7 days.
        const settings = await getSettings(db);
        const resumeAt = c.returnDate ?? addDays(msg.receivedAt, 7);
        if (match.enrollmentId) {
          const next = await one<{ id: number; scheduled_at: Date }>(
            "SELECT id, scheduled_at FROM messages WHERE enrollment_id = $1 AND status = 'scheduled' ORDER BY step LIMIT 1",
            [match.enrollmentId],
            db,
          );
          if (next && new Date(next.scheduled_at) < resumeAt) {
            await query("UPDATE messages SET scheduled_at = $2 WHERE id = $1", [next.id, nextSendSlot(resumeAt, settings)], db);
          }
        }
        await recordEvent(match.leadId, "auto_reply", { resume_at: resumeAt.toISOString(), stated: !!c.returnDate }, db);
        break;
      }
      case "bounce": {
        await stopEnrollment(match.leadId, "bounce", db);
        const lead = await one<{ email: string | null }>("SELECT email FROM leads WHERE id = $1", [match.leadId], db);
        const address = c.failedRecipient ?? lead?.email;
        if (address) await suppressEmail(address, "bounce", db);
        await query(
          "UPDATE leads SET stage = 'bounced', next_action = NULL, next_action_at = NULL, updated_at = now() WHERE id = $1 AND stage NOT IN ('signed', 'paid')",
          [match.leadId],
          db,
        );
        await recordEvent(match.leadId, "bounce", { address }, db);
        break;
      }
      case "unsubscribe": {
        const lead = await one<{ email: string | null }>("SELECT email FROM leads WHERE id = $1", [match.leadId], db);
        await unsubscribeLead(match.leadId, lead?.email ?? msg.from, "reply", db);
        if (lead?.email && lead.email.toLowerCase() !== msg.from) await suppressEmail(msg.from, "unsubscribe", db);
        break;
      }
    }
  });

  if (c.kind === "reply") {
    const settings = await getSettings();
    if (settings.notifyOnReply && config.replyNotifyEmail) {
      await notifyAdmin(
        transport,
        `Reply from ${match.businessName}`,
        `${match.businessName} replied (${formatLocal(msg.receivedAt)}). Their sequence has been stopped.\n\n${snippet}\n\nOpen the replies view: ${config.appBaseUrl}/replies`,
        config.replyNotifyEmail,
      );
    }
  }
}

export async function runWatcher(deps: { transport?: MailTransport } = {}): Promise<WatcherResult> {
  const transport = deps.transport ?? getTransport();
  const result = await withAdvisoryLock("watcher", async () => {
    const out: WatcherResult = { seen: 0, matched: 0, byKind: {} };
    // Poll the mailbox's change history from the last cursor.
    const cursor = await getState<string>("gmail_history_id");
    let ids: string[];
    let nextCursor: string;
    if (!cursor) {
      nextCursor = await transport.currentHistoryId();
      ids = await transport.recentInboxIds(3);
    } else {
      const h = await transport.history(cursor);
      if ("expired" in h) {
        nextCursor = await transport.currentHistoryId();
        ids = await transport.recentInboxIds(8);
      } else {
        ids = h.messageIds;
        nextCursor = h.historyId;
      }
    }

    for (const id of ids) {
      if (await one("SELECT 1 FROM inbound WHERE gmail_message_id = $1", [id])) continue;
      const msg = await transport.getMessage(id);
      if (msg.labelIds.includes("SENT")) continue;
      out.seen++;
      const c = classifyInbound(msg, config.senderEmail);
      if (c.kind === "own") continue;
      const match = await matchLead(msg, c);
      if (!match) continue;
      out.matched++;
      out.byKind[c.kind] = (out.byKind[c.kind] ?? 0) + 1;
      await applyClassification(msg, c, match, transport);
    }
    await setState("gmail_history_id", nextCursor);
    return out;
  });
  return result ?? { seen: 0, matched: 0, byKind: {} };
}
