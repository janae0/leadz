import { query, type Queryable, pool } from "../db/pool.js";
import type { Settings } from "../settings.js";

export interface Template {
  name: string;
  kind: "first" | "followup";
  description: string; // for first emails: guidance Claude follows
  subject: string; // for follow-ups: fixed subject ("" = reply in thread with "Re: <first subject>")
  body: string; // for follow-ups: pre-approved text with {{placeholders}}
}

// First-email templates give Claude the angle; Claude writes the words from the
// facts. Follow-ups are pre-approved text filled with the same facts.
export const DEFAULT_TEMPLATES: Template[] = [
  {
    name: "no_website",
    kind: "first",
    description:
      "The business has no website of its own. Point out, kindly, that people searching for them online find only a listing. Offer a simple site that shows hours, services, and how to reach them.",
    subject: "",
    body: "",
  },
  {
    name: "outdated_site",
    kind: "first",
    description:
      "The site exists but has one concrete, measured problem (slow on phones, not secure, broken, an old copyright year, or no mobile layout). Name the single most striking measured problem and offer to fix it.",
    subject: "",
    body: "",
  },
  {
    name: "no_booking",
    kind: "first",
    description:
      "An appointment business without online booking. Note that customers can't book online and offer to add booking to their site so they fill slots without phone tag.",
    subject: "",
    body: "",
  },
  {
    name: "weak_google",
    kind: "first",
    description:
      "Their Google presence is thin (few reviews or a lower rating). Offer to help them collect more reviews and tighten up their Google listing.",
    subject: "",
    body: "",
  },
  {
    name: "general",
    kind: "first",
    description: "No single problem stands out. Offer the free one-page Google and website check-up.",
    subject: "",
    body: "",
  },
  {
    name: "bump",
    kind: "followup",
    description: "Day 4: a short, friendly bump referencing the first email.",
    subject: "",
    body: "Hi again,\n\nJust floating my note from last week back to the top of your inbox in case it got buried. Happy to answer any questions about {{business_name}}'s site.\n\nWould a quick call this week be useful?",
  },
  {
    name: "checkup",
    kind: "followup",
    description: "Day 10: a useful extra, offering the free one-page Google and website check-up.",
    subject: "",
    body: "Hi,\n\nOne last note from me. If it would help, I can put together a free one-page check-up of {{business_name}}'s Google listing and website, with the few fixes that would matter most. No cost and no obligation.\n\nWant me to send it over?",
  },
];

export async function seedTemplates(db: Queryable = pool): Promise<void> {
  for (const t of DEFAULT_TEMPLATES) {
    await query(
      `INSERT INTO templates (name, kind, description, subject, body) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO NOTHING`,
      [t.name, t.kind, t.description, t.subject, t.body],
      db,
    );
  }
}

export async function getTemplate(name: string, db: Queryable = pool): Promise<Template | undefined> {
  const rows = await query<Template>("SELECT name, kind, description, subject, body FROM templates WHERE name = $1", [name], db);
  return rows[0] ?? DEFAULT_TEMPLATES.find((t) => t.name === name);
}

export async function listTemplates(db: Queryable = pool): Promise<Template[]> {
  return query<Template>("SELECT name, kind, description, subject, body FROM templates ORDER BY kind, name", [], db);
}

export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in values ? values[key] : m));
}

export const FOOTER_MARKER = "\n\n-- \n";
export const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";

// Signature and CAN-SPAM footer, appended by the system to every email so
// Claude never writes them. The validator rejects drafts without it.
export function signatureAndFooter(settings: Settings, sender: { name: string }): string {
  const sig = [sender.name, settings.senderTitle ? `${settings.senderTitle}, ${settings.companyName}` : settings.companyName]
    .filter(Boolean)
    .join("\n");
  return (
    `\n\n${sig}` +
    FOOTER_MARKER +
    `${settings.companyName} · ${settings.mailingAddress}\n` +
    `This is a message from ${settings.companyName} about our web and local-visibility services. ` +
    `To stop hearing from us, reply "stop" or unsubscribe here: ${UNSUBSCRIBE_PLACEHOLDER}`
  );
}

export function splitFooter(body: string): { main: string; footer: string | null } {
  const i = body.lastIndexOf(FOOTER_MARKER);
  if (i < 0) return { main: body, footer: null };
  return { main: body.slice(0, i), footer: body.slice(i + FOOTER_MARKER.length) };
}
