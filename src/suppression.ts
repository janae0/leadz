import { one, query, type Queryable, pool } from "./db/pool.js";
import { domainOf, normalizeEmail } from "./util/normalize.js";

export type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "client" | "do_not_contact";

// Entries are permanent: the table has a rule that ignores DELETE.
export async function suppressEmail(email: string, reason: SuppressionReason, db: Queryable = pool): Promise<void> {
  const value = normalizeEmail(email);
  if (!value) return;
  await query(
    "INSERT INTO suppression (value, kind, reason) VALUES ($1, 'email', $2) ON CONFLICT (value) DO NOTHING",
    [value, reason],
    db,
  );
}

export async function suppressDomain(domain: string, reason: SuppressionReason, db: Queryable = pool): Promise<void> {
  const value = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!value) return;
  await query(
    "INSERT INTO suppression (value, kind, reason) VALUES ($1, 'domain', $2) ON CONFLICT (value) DO NOTHING",
    [value, reason],
    db,
  );
}

// True when the address, or the domain of the address or the lead's website, is suppressed.
export async function isSuppressed(
  target: { email?: string | null; website?: string | null },
  db: Queryable = pool,
): Promise<boolean> {
  const values: string[] = [];
  const email = normalizeEmail(target.email);
  if (email) values.push(email);
  const emailDomain = email ? domainOf(email) : null;
  const siteDomain = domainOf(target.website);
  // Mailbox-provider domains are never suppressed wholesale, only addresses on them.
  for (const d of [emailDomain, siteDomain]) if (d && !FREE_MAIL.has(d)) values.push(d);
  if (values.length === 0) return false;
  const row = await one("SELECT 1 FROM suppression WHERE value = ANY($1::text[]) LIMIT 1", [values], db);
  return !!row;
}

export const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com",
  "msn.com", "live.com", "verizon.net", "optonline.net", "comcast.net", "att.net", "protonmail.com",
]);
