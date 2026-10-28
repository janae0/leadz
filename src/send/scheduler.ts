import { config } from "../config.js";
import { one, query, withAdvisoryLock, withTx } from "../db/pool.js";
import { raiseAlert, recordEvent } from "../events.js";
import { fillPlaceholders, getTemplate, UNSUBSCRIBE_PLACEHOLDER } from "../draft/templates.js";
import { isSuppressed } from "../suppression.js";
import { getSettings, getState, setState, type Settings } from "../settings.js";
import { addDays, dailyCap, inSendWindow, localDateKey, nextSendSlot, randomBetween, startOfLocalDay } from "../util/time.js";
import { getTransport, type MailTransport } from "./gmail.js";
import { buildMime, unsubscribeUrl } from "./mime.js";
import { DEFAULT_SEQUENCE, idempotencyKey, rfcMessageIdFor, stopEnrollment, type SequenceStep } from "./sequence.js";

export interface SchedulerDeps {
  transport?: MailTransport;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  tickMs?: number; // how long one run may keep sending; the cron interval
}

export interface SchedulerResult {
  sent: number;
  failed: number;
  cancelled: number;
  skippedReason?: string;
}

const MAX_ATTEMPTS = 3;

interface DueMessage {
  id: number;
  enrollment_id: number;
  step: number;
  to_email: string;
  subject: string;
  body: string;
  idempotency_key: string;
  rfc_message_id: string;
  attempts: number;
  lead_id: number;
  stage: string;
  website: string | null;
  business_name: string;
  sequence_steps: SequenceStep[];
}

async function rampStart(settings: Settings): Promise<string | null> {
  if (settings.rampStartDate) return settings.rampStartDate;
  const first = await one<{ first: Date | null }>("SELECT MIN(sent_at) AS first FROM messages WHERE status = 'sent'");
  return first?.first ? localDateKey(first.first) : null;
}

export async function sentSince(since: Date): Promise<number> {
  const row = await one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent' AND sent_at >= $1", [since]);
  return row?.n ?? 0;
}

// A message left in 'sending' means a run died mid-send. Ask Gmail whether it
// went out (by the Message-ID we set) before allowing a retry, so a retry
// after a timeout can't send twice.
// Runs under the scheduler lock, so any 'sending' row belongs to a dead run.
async function recoverStuck(transport: MailTransport, now: Date): Promise<void> {
  const stuck = await query<{ id: number; rfc_message_id: string }>(
    "SELECT id, rfc_message_id FROM messages WHERE status = 'sending'",
  );
  for (const m of stuck) {
    const found = await transport.findByRfcMessageId(m.rfc_message_id).catch(() => null);
    if (found) {
      await markSent(m.id, found, now);
    } else {
      await query("UPDATE messages SET status = 'scheduled' WHERE id = $1 AND status = 'sending'", [m.id]);
    }
  }
}

async function claimNext(now: Date): Promise<DueMessage | undefined> {
  return withTx(async (db) => {
    const row = await one<{ id: number }>(
      `SELECT m.id FROM messages m
       JOIN enrollments e ON e.id = m.enrollment_id
       JOIN leads l ON l.id = e.lead_id
       WHERE m.status = 'scheduled' AND m.scheduled_at <= $1 AND e.status = 'active'
       ORDER BY (m.step > 1) DESC, l.priority DESC, m.scheduled_at, l.score DESC NULLS LAST
       LIMIT 1 FOR UPDATE OF m SKIP LOCKED`,
      [now],
      db,
    );
    if (!row) return undefined;
    await query("UPDATE messages SET status = 'sending', attempts = attempts + 1 WHERE id = $1", [row.id], db);
    return one<DueMessage>(
      `SELECT m.id, m.enrollment_id, m.step, m.to_email, m.subject, m.body, m.idempotency_key, m.rfc_message_id, m.attempts,
              l.id AS lead_id, l.stage, l.website, l.business_name, s.steps AS sequence_steps
       FROM messages m JOIN enrollments e ON e.id = m.enrollment_id JOIN leads l ON l.id = e.lead_id
       JOIN sequences s ON s.id = e.sequence_id
       WHERE m.id = $1`,
      [row.id],
      db,
    );
  });
}

async function markSent(messageId: number, ids: { id: string; threadId: string }, now: Date): Promise<void> {
  await withTx(async (db) => {
    const m = await one<{ enrollment_id: number; step: number; lead_id: number }>(
      `UPDATE messages SET status = 'sent', sent_at = $2, gmail_message_id = $3, gmail_thread_id = $4, last_error = NULL
       WHERE id = $1 RETURNING enrollment_id, step,
         (SELECT lead_id FROM enrollments WHERE id = enrollment_id) AS lead_id`,
      [messageId, now, ids.id, ids.threadId],
      db,
    );
    if (!m) return;
    if (m.step === 1) {
      await query(
        "UPDATE leads SET stage = 'contacted', updated_at = now() WHERE id = $1 AND stage = 'approved'",
        [m.lead_id],
        db,
      );
    }
    await recordEvent(m.lead_id, "sent", { message_id: messageId, step: m.step }, db);
  });
}

// Follow-ups use pre-approved templates filled with the same facts, sent as
// replies in the first email's thread.
async function scheduleNextStep(msg: DueMessage, settings: Settings): Promise<void> {
  const steps = msg.sequence_steps;
  const next = steps[msg.step]; // steps are 1-indexed by position
  if (!next) return;
  const first = await one<{ sent_at: Date; subject: string }>(
    "SELECT sent_at, subject FROM messages WHERE enrollment_id = $1 AND step = 1",
    [msg.enrollment_id],
  );
  if (!first?.sent_at) return;
  const template = await getTemplate(next.template);
  if (!template) {
    await raiseAlert("template_missing", `Follow-up template "${next.template}" not found; lead ${msg.lead_id} sequence stalled`);
    return;
  }
  const values = { business_name: msg.business_name, sender_name: config.senderName, company: settings.companyName };
  const body = fillPlaceholders(template.body, values) + extractTail(msg.body);
  const subject = template.subject ? fillPlaceholders(template.subject, values) : `Re: ${first.subject}`;
  const key = idempotencyKey();
  await query(
    `INSERT INTO messages (enrollment_id, step, to_email, subject, body, scheduled_at, idempotency_key, rfc_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (enrollment_id, step) DO NOTHING`,
    [msg.enrollment_id, msg.step + 1, msg.to_email, subject, body,
      nextSendSlot(addDays(new Date(first.sent_at), next.day), settings), key, rfcMessageIdFor(key)],
  );
}

// The signature and footer from the approved first email, reused on follow-ups.
export function extractTail(body: string): string {
  const footerAt = body.lastIndexOf("\n\n-- \n");
  if (footerAt < 0) return "";
  const beforeFooter = body.slice(0, footerAt);
  const sigAt = beforeFooter.lastIndexOf("\n\n");
  return body.slice(sigAt >= 0 ? sigAt : footerAt);
}

async function handleFailure(msg: DueMessage, error: Error, now: Date, transport: MailTransport): Promise<"failed" | "retry"> {
  if (msg.attempts >= MAX_ATTEMPTS) {
    await query("UPDATE messages SET status = 'failed', last_error = $2 WHERE id = $1", [msg.id, error.message]);
    const text = `Sending message ${msg.id} (lead ${msg.lead_id}, ${msg.business_name}, step ${msg.step}) failed ${msg.attempts} times: ${error.message}`;
    await raiseAlert("send_failed", text);
    await notifyAdmin(transport, "Leadz: a send failed 3 times", text);
    return "failed";
  }
  // Backoff: 5, 15 minutes.
  const delayMin = 5 * 3 ** (msg.attempts - 1);
  await query(
    "UPDATE messages SET status = 'scheduled', last_error = $2, scheduled_at = $3 WHERE id = $1",
    [msg.id, error.message, new Date(now.getTime() + delayMin * 60_000)],
  );
  return "retry";
}

export async function notifyAdmin(transport: MailTransport, subject: string, text: string, to = config.adminAlertEmail): Promise<void> {
  if (!to || !config.senderEmail) return;
  try {
    const key = idempotencyKey();
    await transport.send(buildMime({
      fromName: "Leadz", fromEmail: config.senderEmail, to, subject, text, messageId: rfcMessageIdFor(key),
    }));
  } catch (err) {
    console.error("Could not send admin notification:", (err as Error).message);
  }
}

// Ends sequences whose last step went out and whose end day has passed; the
// lead moves to a phone or walk-in follow-up.
export async function finishSequences(now: Date): Promise<number> {
  const rows = await query<{ id: number; lead_id: number }>(
    `UPDATE enrollments e SET status = 'finished', ended_at = $1
     WHERE e.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.enrollment_id = e.id AND m.status IN ('scheduled', 'sending'))
       AND EXISTS (SELECT 1 FROM messages m WHERE m.enrollment_id = e.id AND m.step = 1 AND m.sent_at <= $1::timestamptz - make_interval(days => $2::int))
     RETURNING e.id, e.lead_id`,
    [now, DEFAULT_SEQUENCE.endDay],
  );
  for (const r of rows) {
    await query(
      `UPDATE leads SET next_action = CASE WHEN phone IS NOT NULL THEN 'call' ELSE 'walk-in visit' END,
         next_action_at = $2, walk_in = walk_in OR (phone IS NULL AND walk_in_allowed), updated_at = now()
       WHERE id = $1 AND stage = 'contacted'`,
      [r.lead_id, now],
    );
  }
  return rows.length;
}

export async function runScheduler(deps: SchedulerDeps = {}): Promise<SchedulerResult> {
  const transport = deps.transport ?? getTransport();
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const tickMs = deps.tickMs ?? 10 * 60_000;

  const result = await withAdvisoryLock("scheduler", async () => {
    const out: SchedulerResult = { sent: 0, failed: 0, cancelled: 0 };
    const startedAt = clock();
    const deadline = startedAt.getTime() + tickMs - 30_000;
    await finishSequences(startedAt);
    const settings = await getSettings();
    if (!inSendWindow(startedAt, settings)) return { ...out, skippedReason: "outside sending window" };
    await recoverStuck(transport, startedAt);

    for (;;) {
      const now = clock();
      if (!inSendWindow(now, settings)) break;
      const cap = dailyCap(now, await rampStart(settings), settings.dailyCapOverride);
      if ((await sentSince(startOfLocalDay(now))) >= cap) {
        out.skippedReason = `daily cap of ${cap} reached`;
        break;
      }
      // Random spacing between sends, so mail goes out like a person sending it.
      const gate = await getState<string>("next_send_at");
      if (gate && new Date(gate).getTime() > now.getTime()) {
        const wait = new Date(gate).getTime() - now.getTime();
        if (now.getTime() + wait > deadline) break;
        await sleep(wait);
        continue;
      }

      const msg = await claimNext(now);
      if (!msg) break;

      // Check the suppression list and the lead's current stage at send time,
      // not just at scheduling time.
      const expectedStage = msg.step === 1 ? "approved" : "contacted";
      const suppressed = await isSuppressed({ email: msg.to_email, website: msg.website });
      if (suppressed || msg.stage !== expectedStage) {
        await query("UPDATE messages SET status = 'cancelled', last_error = $2 WHERE id = $1", [
          msg.id, suppressed ? "suppressed" : `lead stage is ${msg.stage}`,
        ]);
        await stopEnrollment(msg.lead_id, suppressed ? "suppressed" : `stage ${msg.stage}`);
        out.cancelled++;
        continue;
      }

      const first = msg.step > 1
        ? await one<{ gmail_thread_id: string; rfc_message_id: string }>(
          "SELECT gmail_thread_id, rfc_message_id FROM messages WHERE enrollment_id = $1 AND step = 1",
          [msg.enrollment_id],
        )
        : undefined;
      const unsubUrl = unsubscribeUrl(msg.lead_id, msg.to_email);
      const raw = buildMime({
        fromName: config.senderName,
        fromEmail: config.senderEmail,
        to: msg.to_email,
        subject: msg.subject,
        text: msg.body.split(UNSUBSCRIBE_PLACEHOLDER).join(unsubUrl),
        messageId: msg.rfc_message_id,
        inReplyTo: first?.rfc_message_id ?? null,
        references: first ? [first.rfc_message_id] : [],
        unsubscribeUrl: unsubUrl,
        unsubscribeMailto: config.senderEmail,
      });

      try {
        const sent = await transport.send(raw, first?.gmail_thread_id ?? null);
        await markSent(msg.id, sent, clock());
        // Gmail may rewrite Message-ID; keep the real one for threading follow-ups.
        const actualId = await transport.messageIdHeader(sent.id).catch(() => null);
        if (actualId && actualId !== msg.rfc_message_id) {
          await query("UPDATE messages SET rfc_message_id = $2 WHERE id = $1", [msg.id, actualId]);
        }
        await scheduleNextStep(msg, settings);
        out.sent++;
      } catch (err) {
        const r = await handleFailure(msg, err as Error, clock(), transport);
        if (r === "failed") out.failed++;
      }
      const spacing = randomBetween(settings.spacingMinutes.min, settings.spacingMinutes.max, random);
      await setState("next_send_at", new Date(clock().getTime() + spacing * 60_000).toISOString());
    }
    return out;
  });
  return result ?? { sent: 0, failed: 0, cancelled: 0, skippedReason: "another scheduler run is in progress" };
}
