import { bootstrap } from "../src/bootstrap.js";
import { pool, query } from "../src/db/pool.js";
import type { InboundMessage, MailTransport, HistoryResult } from "../src/send/gmail.js";
import { setSetting } from "../src/settings.js";

let migrated = false;

export async function resetDb(): Promise<void> {
  if (!migrated) {
    await bootstrap();
    migrated = true;
  }
  // suppression ignores DELETE by rule, so TRUNCATE it explicitly.
  await query(`TRUNCATE leads, lead_sources, checks, drafts, enrollments, messages, events, suppression, inbound, alerts,
    settings, job_runs, users RESTART IDENTITY CASCADE`);
  await bootstrap();
  await setSetting("mailingAddress", "PO Box 123, Bronx, NY 10463");
}

export async function closeDb(): Promise<void> {
  await pool.end();
}

// In-memory stand-in for the Gmail mailbox.
export class FakeTransport implements MailTransport {
  sent: { raw: string; threadId: string | null; id: string; to: string; subject: string; messageId: string }[] = [];
  inbox: InboundMessage[] = [];
  historyId = 100;
  failNext = 0;
  private n = 0;

  async send(raw: string, threadId?: string | null) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated Gmail 503");
    }
    const id = `m${++this.n}`;
    const header = (name: string) => raw.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";
    const thread = threadId ?? `t${this.n}`;
    this.sent.push({ raw, threadId: threadId ?? null, id, to: header("To"), subject: header("Subject"), messageId: header("Message-ID") });
    return { id, threadId: thread };
  }
  async messageIdHeader(id: string) {
    return this.sent.find((s) => s.id === id)?.messageId ?? null;
  }
  async findByRfcMessageId(rfc: string) {
    const s = this.sent.find((x) => x.messageId === rfc);
    return s ? { id: s.id, threadId: s.threadId ?? `t${s.id.slice(1)}` } : null;
  }
  async currentHistoryId() {
    return String(this.historyId);
  }
  private delivered = 0;
  async history(): Promise<HistoryResult> {
    const ids = this.inbox.slice(this.delivered).map((m) => m.id);
    this.delivered = this.inbox.length;
    this.historyId++;
    return { messageIds: ids, historyId: String(this.historyId) };
  }
  async recentInboxIds() {
    this.delivered = this.inbox.length;
    return this.inbox.map((m) => m.id);
  }
  async getMessage(id: string) {
    const m = this.inbox.find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
  receive(m: Partial<InboundMessage> & { from: string; threadId: string }) {
    const id = `in${this.inbox.length + 1}`;
    this.inbox.push({
      id, labelIds: ["INBOX"], headers: {}, subject: "Re: hello", text: "", receivedAt: new Date(), ...m,
    });
    return id;
  }
}

export function htmlResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, { status: init.status ?? 200, headers: { "content-type": "text/html", ...(init.headers ?? {}) } });
}
