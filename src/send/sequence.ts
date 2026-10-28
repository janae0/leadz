import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { one, query, withTx, type Queryable, pool } from "../db/pool.js";
import { recordEvent } from "../events.js";
import { suppressDomain, suppressEmail } from "../suppression.js";
import { getSettings } from "../settings.js";
import { nextSendSlot } from "../util/time.js";
import { domainOf, isOwnedSiteDomain } from "../util/normalize.js";

export interface SequenceStep {
  day: number;
  template: string; // "first" = the approved draft
}

// Day 0 approved email, day 4 bump, day 10 check-up offer; day 11 the lead
// moves to a phone or walk-in follow-up.
export const DEFAULT_SEQUENCE = {
  name: "local-business",
  steps: [
    { day: 0, template: "first" },
    { day: 4, template: "bump" },
    { day: 10, template: "checkup" },
  ] as SequenceStep[],
  endDay: 11,
};

export async function seedSequence(db: Queryable = pool): Promise<void> {
  await query(
    "INSERT INTO sequences (name, steps) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
    [DEFAULT_SEQUENCE.name, JSON.stringify(DEFAULT_SEQUENCE.steps)],
    db,
  );
}

export function idempotencyKey(): string {
  return randomUUID();
}

export function rfcMessageIdFor(key: string): string {
  const domain = domainOf(config.senderEmail) ?? "leadz.local";
  return `<${key}@${domain}>`;
}

export class ReviewError extends Error {}

// Approving the first email enrolls the lead and schedules step 1 for the
// next sending slot. Only the first email in a sequence needs approval.
export async function approveDraft(
  draftId: number,
  reviewer: string,
  edits?: { subject: string; body: string },
  now: Date = new Date(),
): Promise<{ enrollmentId: number; messageId: number }> {
  const settings = await getSettings();
  return withTx(async (db) => {
    const draft = await one<{ id: number; lead_id: number; subject: string; body: string; status: string }>(
      "SELECT * FROM drafts WHERE id = $1 FOR UPDATE",
      [draftId],
      db,
    );
    if (!draft) throw new ReviewError("Draft not found");
    if (draft.status !== "pending") throw new ReviewError(`Draft is already ${draft.status}`);
    const lead = await one<{ id: number; email: string | null; stage: string }>(
      "SELECT id, email, stage FROM leads WHERE id = $1 FOR UPDATE",
      [draft.lead_id],
      db,
    );
    if (!lead?.email) throw new ReviewError("Lead has no email address");
    if (["unsubscribed", "bounced", "lost"].includes(lead.stage)) throw new ReviewError(`Lead is ${lead.stage}`);

    const edited = !!edits && (edits.subject !== draft.subject || edits.body !== draft.body);
    const subject = edits?.subject ?? draft.subject;
    const body = edits?.body ?? draft.body;
    await query(
      `UPDATE drafts SET status = $2, subject = $3, body = $4, reviewed_by = $5, reviewed_at = now() WHERE id = $1`,
      [draftId, edited ? "edited" : "approved", subject, body, reviewer],
      db,
    );

    const seq = await one<{ id: number }>("SELECT id FROM sequences WHERE name = $1", [DEFAULT_SEQUENCE.name], db);
    if (!seq) throw new Error("Default sequence is not seeded; run the migrate command");
    const active = await one("SELECT 1 FROM enrollments WHERE lead_id = $1 AND status = 'active'", [lead.id], db);
    if (active) throw new ReviewError("Lead already has an active sequence");
    const enrollment = await one<{ id: number }>(
      "INSERT INTO enrollments (lead_id, sequence_id, draft_id) VALUES ($1, $2, $3) RETURNING id",
      [lead.id, seq.id, draftId],
      db,
    );
    const key = idempotencyKey();
    const msg = await one<{ id: number }>(
      `INSERT INTO messages (enrollment_id, step, to_email, subject, body, scheduled_at, idempotency_key, rfc_message_id)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [enrollment!.id, lead.email, subject, body, nextSendSlot(now, settings), key, rfcMessageIdFor(key)],
      db,
    );
    await query("UPDATE leads SET stage = 'approved', updated_at = now() WHERE id = $1", [lead.id], db);
    await recordEvent(lead.id, "approved", { draft_id: draftId, edited }, db);
    return { enrollmentId: enrollment!.id, messageId: msg!.id };
  });
}

export async function rejectDraft(draftId: number, reviewer: string, reason: string): Promise<void> {
  await withTx(async (db) => {
    const draft = await one<{ lead_id: number; template: string; status: string }>(
      "SELECT lead_id, template, status FROM drafts WHERE id = $1 FOR UPDATE",
      [draftId],
      db,
    );
    if (!draft) throw new ReviewError("Draft not found");
    if (draft.status !== "pending") throw new ReviewError(`Draft is already ${draft.status}`);
    await query(
      "UPDATE drafts SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1",
      [draftId, reason, reviewer],
      db,
    );
    await query("UPDATE leads SET stage = 'qualified', updated_at = now() WHERE id = $1 AND stage = 'drafted'", [draft.lead_id], db);
    // Rejection reasons are logged and used to improve templates and scoring.
    await recordEvent(draft.lead_id, "rejected", { draft_id: draftId, template: draft.template, reason }, db);
  });
}

export async function moveToWalkIn(leadId: number): Promise<void> {
  await withTx(async (db) => {
    await query(
      "UPDATE drafts SET status = 'rejected', reject_reason = 'moved to walk-in list', reviewed_at = now() WHERE lead_id = $1 AND status = 'pending'",
      [leadId],
      db,
    );
    await query(
      `UPDATE leads SET walk_in = true, next_action = 'walk-in visit', updated_at = now(),
         stage = CASE WHEN stage = 'drafted' THEN 'qualified' ELSE stage END
       WHERE id = $1`,
      [leadId],
      db,
    );
  });
}

// Stops the lead's active sequence and cancels anything not yet sent.
export async function stopEnrollment(leadId: number, reason: string, db: Queryable = pool): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE enrollments SET status = 'stopped', stop_reason = $2, ended_at = now()
     WHERE lead_id = $1 AND status = 'active' RETURNING id`,
    [leadId, reason],
    db,
  );
  if (rows.length === 0) return false;
  await query(
    `UPDATE messages SET status = 'cancelled' WHERE enrollment_id = ANY($1::int[]) AND status IN ('scheduled', 'failed')`,
    [rows.map((r) => r.id)],
    db,
  );
  return true;
}

export type ManualOutcome = "call_booked" | "not_interested" | "do_not_contact" | "proposal_sent" | "signed" | "paid" | "replied";

const MANUAL_STAGE: Record<ManualOutcome, string> = {
  call_booked: "call",
  not_interested: "lost",
  do_not_contact: "lost",
  proposal_sent: "proposal",
  signed: "signed",
  paid: "paid",
  replied: "replied",
};

// The outreach lead marks call booked, not interested, or do not contact:
// stop the sequence and set the matching stage.
export async function recordManualOutcome(leadId: number, outcome: ManualOutcome, by: string): Promise<void> {
  await withTx(async (db) => {
    const lead = await one<{ email: string | null; website: string | null }>("SELECT email, website FROM leads WHERE id = $1", [leadId], db);
    if (!lead) throw new ReviewError("Lead not found");
    await stopEnrollment(leadId, outcome, db);
    await query(
      "UPDATE leads SET stage = $2, next_action = NULL, next_action_at = NULL, updated_at = now() WHERE id = $1",
      [leadId, MANUAL_STAGE[outcome]],
      db,
    );
    if (outcome === "do_not_contact" && lead.email) await suppressEmail(lead.email, "do_not_contact", db);
    if (outcome === "signed" || outcome === "paid") {
      // Clients are never prospected again.
      if (lead.email) await suppressEmail(lead.email, "client", db);
      const domain = domainOf(lead.website);
      if (domain && isOwnedSiteDomain(domain)) await suppressDomain(domain, "client", db);
    }
    if (outcome !== "replied") await recordEvent(leadId, outcome, { by }, db);
  });
}
