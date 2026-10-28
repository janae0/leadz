import { query, type Queryable, pool } from "./db/pool.js";

export type EventType =
  | "reply" | "auto_reply" | "bounce" | "unsubscribe" | "call_booked" | "proposal_sent" | "signed" | "paid"
  | "not_interested" | "do_not_contact" | "sent" | "approved" | "rejected" | "walk_in_visit";

export async function recordEvent(
  leadId: number | null,
  type: EventType,
  detail: Record<string, unknown> | null = null,
  db: Queryable = pool,
): Promise<void> {
  await query("INSERT INTO events (lead_id, type, detail) VALUES ($1, $2, $3)", [leadId, type, detail], db);
}

export async function raiseAlert(kind: string, message: string, db: Queryable = pool): Promise<void> {
  await query("INSERT INTO alerts (kind, message) VALUES ($1, $2)", [kind, message], db);
}
