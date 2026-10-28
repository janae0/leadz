import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export interface OutgoingEmail {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  messageId: string; // "<...@...>"
  inReplyTo?: string | null;
  references?: string[];
  unsubscribeUrl?: string | null;
  unsubscribeMailto?: string | null;
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for anything outside printable ASCII.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function quoteName(name: string): string {
  if (!/^[\x20-\x7e]*$/.test(name)) return encodeHeader(name);
  return `"${name.replace(/["\\]/g, "\\$&")}"`;
}

function stripCrlf(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

export function buildMime(e: OutgoingEmail): string {
  const headers: string[] = [
    `From: ${quoteName(stripCrlf(e.fromName))} <${stripCrlf(e.fromEmail)}>`,
    `To: ${stripCrlf(e.to)}`,
    `Subject: ${encodeHeader(stripCrlf(e.subject))}`,
    `Message-ID: ${stripCrlf(e.messageId)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (e.inReplyTo) headers.push(`In-Reply-To: ${stripCrlf(e.inReplyTo)}`);
  if (e.references?.length) headers.push(`References: ${e.references.map(stripCrlf).join(" ")}`);
  if (e.unsubscribeUrl) {
    const targets = [`<${e.unsubscribeUrl}>`];
    if (e.unsubscribeMailto) targets.push(`<mailto:${e.unsubscribeMailto}?subject=unsubscribe>`);
    headers.push(`List-Unsubscribe: ${targets.join(", ")}`);
    // One-click unsubscribe (RFC 8058), required by Gmail and Yahoo sender rules.
    headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  const body = Buffer.from(e.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Stateless unsubscribe tokens, so opt-out links work indefinitely.
export function unsubscribeToken(leadId: number, email: string): string {
  const payload = Buffer.from(JSON.stringify([leadId, email.toLowerCase()])).toString("base64url");
  const sig = createHmac("sha256", config.unsubscribeSecret).update(payload).digest("base64url").slice(0, 22);
  return `${payload}.${sig}`;
}

export function readUnsubscribeToken(token: string): { leadId: number; email: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", config.unsubscribeSecret).update(payload).digest("base64url").slice(0, 22);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const [leadId, email] = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof leadId === "number" && typeof email === "string" ? { leadId, email } : null;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(leadId: number, email: string): string {
  return `${config.appBaseUrl}/u/${unsubscribeToken(leadId, email)}`;
}
