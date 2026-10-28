import type { InboundMessage } from "../send/gmail.js";
import { addDays } from "../util/time.js";

export type Classification =
  | { kind: "own" }
  | { kind: "bounce"; failedRecipient: string | null }
  | { kind: "auto_reply"; returnDate: Date | null }
  | { kind: "unsubscribe" }
  | { kind: "reply" };

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const BOUNCE_SUBJECT = /(delivery status notification \(failure\)|undeliver(able|ed)|mail delivery (failed|subsystem)|returned mail|delivery failure|failure notice|could not be delivered|address not found)/i;
const AUTO_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|away from (the )?office|on vacation|on leave|\booo\b)/i;

// Text the person actually wrote, without the quoted original below it.
export function freshText(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length > 0) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// A first line that is only the request ("STOP", "Unsubscribe.", "remove me").
const UNSUB_LINE = /^\s*(stop|unsubscribe|remove|remove me|opt[- ]?out|take me off( (your|the) list)?)\s*[.!]*\s*$/i;
const UNSUB_ANY = /\b(unsubscribe|remove me|take (me|us) off (your|the|this) (mailing )?list|stop (emailing|contacting|sending|messaging)|do not (email|contact)|don[’']?t (email|contact) (me|us)|no more emails|opt[- ]?out)\b/i;

export function isUnsubscribeRequest(text: string): boolean {
  const fresh = freshText(text);
  const firstLine = fresh.split("\n").find((l) => l.trim()) ?? "";
  return UNSUB_LINE.test(firstLine) || UNSUB_ANY.test(fresh);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Reads a stated return date such as "back on Monday, November 3" or
// "returning 11/3". Returns null when none can be read.
export function parseReturnDate(text: string, received: Date): Date | null {
  const t = text.replace(/\s+/g, " ");
  const cue = /(back|return(ing)?|in the office|until|through|thru)\b[^.]{0,40}?/i;
  const monthName = new RegExp(`${cue.source}\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`, "i");
  const numeric = new RegExp(`${cue.source}\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?`, "i");
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  const m1 = t.match(monthName);
  if (m1) {
    month = MONTHS.indexOf(m1[m1.length - 2].slice(0, 3).toLowerCase()) + 1;
    day = Number(m1[m1.length - 1]);
  } else {
    const m2 = t.match(numeric);
    if (m2) {
      month = Number(m2[m2.length - 3]);
      day = Number(m2[m2.length - 2]);
      if (m2[m2.length - 1]) year = Number(m2[m2.length - 1].length === 2 ? `20${m2[m2.length - 1]}` : m2[m2.length - 1]);
    }
  }
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  let y = year ?? received.getUTCFullYear();
  let d = new Date(Date.UTC(y, month - 1, day, 14, 0));
  if (!year && d.getTime() < received.getTime() - 86_400_000) d = new Date(Date.UTC(++y, month - 1, day, 14, 0));
  // Ignore implausible dates more than three months out.
  if (d.getTime() > addDays(received, 92).getTime()) return null;
  return d;
}

export function failedRecipientOf(msg: InboundMessage): string | null {
  const header = msg.headers["x-failed-recipients"];
  if (header) return header.split(",")[0].trim().toLowerCase();
  const m = msg.text.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i)
    ?? msg.text.match(/Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i)
    ?? msg.text.match(/(?:wasn[’']t delivered to|delivery to the following recipient[s]? failed[^:]*:|could not be delivered to:?)\s*<?([^\s<>]+@[^\s<>]+?)>?[\s.]/i);
  return m ? m[1].toLowerCase() : null;
}

export function classifyInbound(msg: InboundMessage, ourAddress: string): Classification {
  if (ourAddress && msg.from === ourAddress.toLowerCase()) return { kind: "own" };
  const contentType = msg.headers["content-type"] ?? "";
  if (BOUNCE_FROM.test(msg.from) || /report-type="?delivery-status/i.test(contentType) || (BOUNCE_SUBJECT.test(msg.subject) && /mailer|postmaster|daemon|delivery/i.test(msg.from + msg.subject))) {
    return { kind: "bounce", failedRecipient: failedRecipientOf(msg) };
  }
  const autoSubmitted = msg.headers["auto-submitted"];
  const isAuto =
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
    "x-autoreply" in msg.headers ||
    "x-autorespond" in msg.headers ||
    /auto[_-]?reply/i.test(msg.headers["precedence"] ?? "") ||
    AUTO_SUBJECT.test(msg.subject);
  if (isAuto) return { kind: "auto_reply", returnDate: parseReturnDate(msg.text, msg.receivedAt) };
  if (isUnsubscribeRequest(msg.text) || /^\s*(unsubscribe|stop|remove me)\s*$/i.test(msg.subject)) return { kind: "unsubscribe" };
  return { kind: "reply" };
}
