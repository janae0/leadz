import { config } from "../config.js";
import { toBase64Url } from "./mime.js";

// The slice of the Gmail API the scheduler and watcher use. Tests swap in a
// fake; production uses GmailTransport against the outreach Workspace mailbox.

export interface InboundMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string>; // lower-cased header names
  from: string; // bare address, lower-cased
  subject: string;
  text: string; // plain-text body (best effort)
  receivedAt: Date;
}

export type HistoryResult = { messageIds: string[]; historyId: string } | { expired: true };

export interface MailTransport {
  send(raw: string, threadId?: string | null): Promise<{ id: string; threadId: string }>;
  messageIdHeader(id: string): Promise<string | null>;
  findByRfcMessageId(rfcMessageId: string): Promise<{ id: string; threadId: string } | null>;
  currentHistoryId(): Promise<string>;
  history(startHistoryId: string): Promise<HistoryResult>;
  recentInboxIds(newerThanDays: number): Promise<string[]>;
  getMessage(id: string): Promise<InboundMessage>;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function bareAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

function decodePart(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

export function extractText(part: GmailPart): string {
  if (part.mimeType === "text/plain") return decodePart(part.body?.data);
  // Delivery reports carry the useful text in message/delivery-status parts.
  if (part.mimeType === "message/delivery-status" || part.mimeType === "text/rfc822-headers") return decodePart(part.body?.data);
  if (part.parts) {
    const texts = part.parts.map(extractText).filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  if (part.mimeType === "text/html") return decodePart(part.body?.data).replace(/<[^>]+>/g, " ");
  return "";
}

export class GmailTransport implements MailTransport {
  private token: { value: string; expiresAt: number } | null = null;

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    if (!config.gmailRefreshToken) throw new Error("GMAIL_REFRESH_TOKEN is not set");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.gmailClientId,
        client_secret: config.gmailClientSecret,
        refresh_token: config.gmailRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new GmailError(`OAuth token refresh failed: ${await res.text()}`, res.status);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new GmailError(`Gmail ${path} failed (${res.status}): ${await res.text()}`, res.status);
    return (await res.json()) as T;
  }

  async send(raw: string, threadId?: string | null) {
    const body: Record<string, string> = { raw: toBase64Url(raw) };
    if (threadId) body.threadId = threadId;
    return this.call<{ id: string; threadId: string }>("/messages/send", { method: "POST", body: JSON.stringify(body) });
  }

  async messageIdHeader(id: string) {
    const msg = await this.call<{ payload?: GmailPart }>(`/messages/${id}?format=metadata&metadataHeaders=Message-ID`);
    return msg.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value ?? null;
  }

  async findByRfcMessageId(rfcMessageId: string) {
    const q = encodeURIComponent(`rfc822msgid:${rfcMessageId.replace(/[<>]/g, "")}`);
    const res = await this.call<{ messages?: { id: string; threadId: string }[] }>(`/messages?q=${q}&includeSpamTrash=true`);
    return res.messages?.[0] ?? null;
  }

  async currentHistoryId() {
    const profile = await this.call<{ historyId: string }>("/profile");
    return profile.historyId;
  }

  async history(startHistoryId: string): Promise<HistoryResult> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    try {
      do {
        const params = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
        if (pageToken) params.set("pageToken", pageToken);
        const res = await this.call<{
          history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
          historyId: string;
          nextPageToken?: string;
        }>(`/history?${params}`);
        for (const h of res.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            const labels = added.message.labelIds ?? [];
            if (!labels.includes("SENT") && !labels.includes("DRAFT")) ids.push(added.message.id);
          }
        }
        historyId = res.historyId;
        pageToken = res.nextPageToken;
      } while (pageToken);
    } catch (err) {
      // A history ID older than about a week returns 404; fall back to a scan.
      if (err instanceof GmailError && err.status === 404) return { expired: true };
      throw err;
    }
    return { messageIds: [...new Set(ids)], historyId };
  }

  async recentInboxIds(newerThanDays: number) {
    const q = encodeURIComponent(`in:inbox newer_than:${newerThanDays}d`);
    const res = await this.call<{ messages?: { id: string }[] }>(`/messages?q=${q}&maxResults=500`);
    return (res.messages ?? []).map((m) => m.id);
  }

  async getMessage(id: string): Promise<InboundMessage> {
    const msg = await this.call<{ id: string; threadId: string; labelIds?: string[]; internalDate: string; payload: GmailPart }>(
      `/messages/${id}?format=full`,
    );
    const headers: Record<string, string> = {};
    for (const h of msg.payload.headers ?? []) headers[h.name.toLowerCase()] = h.value;
    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: msg.labelIds ?? [],
      headers,
      from: bareAddress(headers.from ?? ""),
      subject: headers.subject ?? "",
      text: extractText(msg.payload).slice(0, 20_000),
      receivedAt: new Date(Number(msg.internalDate)),
    };
  }
}

// Logs instead of sending; used when DRY_RUN=1.
export class DryRunTransport implements MailTransport {
  private n = 0;
  async send(raw: string, threadId?: string | null) {
    this.n++;
    const id = `dry-${Date.now()}-${this.n}`;
    console.log(`[dry-run] would send (thread ${threadId ?? "new"}):\n${raw.split("\r\n\r\n")[0]}\n`);
    return { id, threadId: threadId ?? `dry-thread-${id}` };
  }
  async messageIdHeader() { return null; }
  async findByRfcMessageId() { return null; }
  async currentHistoryId() { return "0"; }
  async history() { return { messageIds: [], historyId: "0" }; }
  async recentInboxIds() { return []; }
  async getMessage(): Promise<InboundMessage> { throw new Error("dry run has no inbox"); }
}

let defaultTransport: MailTransport | null = null;
export function getTransport(): MailTransport {
  defaultTransport ??= config.dryRun ? new DryRunTransport() : new GmailTransport();
  return defaultTransport;
}
