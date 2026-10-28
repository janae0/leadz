import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "../src/db/pool.js";
import { ingestCandidate } from "../src/pipeline/ingest.js";
import { approveDraft, recordManualOutcome, rejectDraft } from "../src/send/sequence.js";
import { runScheduler } from "../src/send/scheduler.js";
import { readUnsubscribeToken } from "../src/send/mime.js";
import { runWatcher, unsubscribeLead } from "../src/watch/watcher.js";
import { getSettings, setSetting } from "../src/settings.js";
import { isSuppressed } from "../src/suppression.js";
import { signatureAndFooter } from "../src/draft/templates.js";
import { zonedTimeToUtc } from "../src/util/time.js";
import { closeDb, FakeTransport, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(closeDb);

const et = (m: number, d: number, h: number, min = 0) => zonedTimeToUtc(2026, m, d, h, min, "America/New_York");

// A clock the scheduler's sleeps advance, so spacing can be tested without waiting.
function clockAt(start: Date) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
    set: (d: Date) => { t = d.getTime(); },
  };
}

async function approvedLead(name: string, email: string, approvedAt: Date): Promise<{ leadId: number; draftId: number }> {
  const s = await getSettings();
  const r = await ingestCandidate({ source: "places", placeId: `P-${name}`, businessName: name, email, category: "salon_barber" }, s);
  const leadId = (r as any).leadId;
  await query("UPDATE leads SET stage = 'drafted', score = 70 WHERE id = $1", [leadId]);
  const body = `Hi ${name} team,\n\nYou don't have a website yet. Could I show you a simple one?` + signatureAndFooter(s, { name: "Maria Lopez" });
  const d = await one<{ id: number }>(
    "INSERT INTO drafts (lead_id, template, subject, body, facts_json) VALUES ($1, 'no_website', $2, $3, '{}') RETURNING id",
    [leadId, `A site for ${name}`, body],
  );
  await approveDraft(d!.id, "Outreach Lead", undefined, approvedAt);
  return { leadId, draftId: d!.id };
}

describe("approval and scheduling", () => {
  it("schedules step 1 in the next sending slot and logs rejections", async () => {
    const { leadId } = await approvedLead("Shop A", "a@shopa.com", et(10, 30, 18)); // Friday evening
    const msg = await one("SELECT m.* FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.lead_id = $1", [leadId]);
    expect(new Date(msg.scheduled_at).toISOString()).toBe(et(11, 2, 9, 30).toISOString());
    expect((await one("SELECT stage FROM leads WHERE id = $1", [leadId])).stage).toBe("approved");

    const s = await getSettings();
    const r = await ingestCandidate({ source: "manual", businessName: "Shop R", email: "r@shopr.com" }, s);
    const d = await one("INSERT INTO drafts (lead_id, template, subject, body, facts_json) VALUES ($1, 'general', 's', 'b', '{}') RETURNING id", [(r as any).leadId]);
    await rejectDraft(d.id, "Outreach Lead", "Wrong facts: they have a site");
    const ev = await one("SELECT * FROM events WHERE type = 'rejected'");
    expect(ev.detail.reason).toBe("Wrong facts: they have a site");
  });

  it("sends within the window, spaced 3 to 8 minutes apart, under the daily cap", async () => {
    for (let i = 0; i < 18; i++) await approvedLead(`Shop ${i}`, `owner@shop${i}.com`, et(11, 1, 12));
    const t = new FakeTransport();
    const clock = clockAt(et(11, 2, 8, 0));
    expect((await runScheduler({ transport: t, ...clock })).skippedReason).toBe("outside sending window");

    clock.set(et(11, 2, 9, 30));
    const r1 = await runScheduler({ transport: t, ...clock, random: () => 0.5 }); // 5.5 minute gaps
    // A 10-minute tick fits two sends 5.5 minutes apart.
    expect(r1.sent).toBe(2);
    const times = (await query("SELECT sent_at FROM messages WHERE status = 'sent' ORDER BY sent_at")).map((r) => new Date(r.sent_at).getTime());
    expect((times[1] - times[0]) / 60_000).toBeCloseTo(5.5, 5);

    // Run ticks all day: the cap (15 in week 1) stops sending.
    for (let i = 0; i < 60; i++) {
      clock.set(new Date(et(11, 2, 9, 40).getTime() + i * 10 * 60_000));
      await runScheduler({ transport: t, ...clock });
    }
    expect(t.sent.length).toBe(15);
    const last = await runScheduler({ transport: t, ...clock, now: () => et(11, 2, 15, 0) });
    expect(last.skippedReason).toMatch(/daily cap of 15/);
  });

  it("checks suppression and stage at send time", async () => {
    const { leadId } = await approvedLead("Shop S", "s@shops.com", et(11, 1, 12));
    await approvedLead("Shop T", "t@shopt.com", et(11, 1, 12));
    await unsubscribeLead(null, "s@shops.com", "test"); // suppressed after approval, before sending
    await recordManualOutcome((await one("SELECT id FROM leads WHERE business_name = 'Shop T'")).id, "not_interested", "test");
    const t = new FakeTransport();
    const clock = clockAt(et(11, 2, 10));
    const r = await runScheduler({ transport: t, ...clock, tickMs: 60 * 60_000 });
    expect(t.sent.length).toBe(0);
    expect(r.cancelled).toBe(1); // Shop T's message was cancelled when the outcome was recorded
    const m = await one("SELECT m.status, m.last_error FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.lead_id = $1", [leadId]);
    expect(m).toEqual({ status: "cancelled", last_error: "suppressed" });
  });
});

describe("the full sequence", () => {
  it("sends day 0, day 4, day 10 in one thread, then hands off to a call", async () => {
    const { leadId } = await approvedLead("Shop F", "f@shopf.com", et(11, 1, 12));
    const t = new FakeTransport();
    const clock = clockAt(et(11, 2, 10));
    await runScheduler({ transport: t, ...clock });
    expect(t.sent).toHaveLength(1);
    const first = t.sent[0];
    expect(first.subject).toBe("A site for Shop F");
    expect(first.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const body1 = Buffer.from(first.raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
    const url = body1.match(/https:\/\/leadz\.test\/u\/(\S+)/)![1];
    expect(readUnsubscribeToken(url)).toEqual({ leadId, email: "f@shopf.com" });
    expect((await one("SELECT stage FROM leads WHERE id = $1", [leadId])).stage).toBe("contacted");

    const step2 = await one("SELECT * FROM messages WHERE step = 2");
    expect(new Date(step2.scheduled_at).toISOString()).toBe(et(11, 6, 10).toISOString()); // day 4, a Friday, same time
    clock.set(et(11, 6, 10, 1));
    await runScheduler({ transport: t, ...clock });
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1].threadId).toBe("t1");
    expect(t.sent[1].subject).toBe("Re: A site for Shop F");
    expect(t.sent[1].raw).toContain(`In-Reply-To: ${first.messageId}`);
    const body2 = Buffer.from(t.sent[1].raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
    expect(body2).toContain("Just floating my note");
    expect(body2).toContain("PO Box 123, Bronx, NY 10463");
    expect(body2).toContain("https://leadz.test/u/");

    const step3 = await one("SELECT * FROM messages WHERE step = 3");
    // Day 10 is Nov 12 (Thursday).
    expect(new Date(step3.scheduled_at).toISOString()).toBe(et(11, 12, 10).toISOString());
    clock.set(et(11, 12, 10, 1));
    await runScheduler({ transport: t, ...clock });
    expect(t.sent).toHaveLength(3);
    expect(await one("SELECT * FROM messages WHERE step = 4")).toBeUndefined();

    clock.set(et(11, 13, 11));
    await runScheduler({ transport: t, ...clock });
    expect((await one("SELECT status FROM enrollments WHERE lead_id = $1", [leadId])).status).toBe("finished");
    expect((await one("SELECT next_action FROM leads WHERE id = $1", [leadId])).next_action).toBe("walk-in visit");
  });
});

describe("the reply watcher", () => {
  async function sentLead(name: string) {
    const { leadId } = await approvedLead(name, `owner@${name.toLowerCase().replace(/\s/g, "")}.com`, et(11, 1, 12));
    return leadId;
  }

  it("stops the sequence on a reply and notifies", async () => {
    const leadId = await sentLead("Reply Co");
    const t = new FakeTransport();
    await runScheduler({ transport: t, ...clockAt(et(11, 2, 10)) });
    await runWatcher({ transport: t }); // first run sets the cursor
    t.receive({ from: "owner@replyco.com", threadId: "t1", text: "Sounds interesting, call me Tuesday?\n\nOn Mon, Maria wrote:\n> Hi" });
    const r = await runWatcher({ transport: t });
    expect(r.byKind).toEqual({ reply: 1 });
    expect((await one("SELECT stage FROM leads WHERE id = $1", [leadId])).stage).toBe("replied");
    expect((await one("SELECT status, stop_reason FROM enrollments WHERE lead_id = $1", [leadId]))).toEqual({ status: "stopped", stop_reason: "reply" });
    expect((await one("SELECT status FROM messages WHERE step = 2")).status).toBe("cancelled");
    const inbound = await one("SELECT * FROM inbound");
    expect(inbound.snippet).toBe("Sounds interesting, call me Tuesday?");
    // Same message again is ignored.
    expect((await runWatcher({ transport: t })).matched).toBe(0);
  });

  it("handles bounces, opt-outs, and out-of-office", async () => {
    const bounceId = await sentLead("Bounce Co");
    const unsubId = await sentLead("Unsub Co");
    const oooId = await sentLead("Away Co");
    const t = new FakeTransport();
    await runScheduler({ transport: t, ...clockAt(et(11, 2, 10)), tickMs: 60 * 60_000 });
    expect(t.sent).toHaveLength(3);
    await runWatcher({ transport: t });
    const threadOf = async (id: number) => (await one("SELECT m.gmail_thread_id FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.lead_id = $1", [id])).gmail_thread_id;

    t.receive({ from: "mailer-daemon@googlemail.com", threadId: "bounce-thread", subject: "Delivery Status Notification (Failure)", headers: { "x-failed-recipients": "owner@bounceco.com" } });
    t.receive({ from: "owner@unsubco.com", threadId: await threadOf(unsubId), text: "Please take me off your list" });
    t.receive({ from: "owner@awayco.com", threadId: await threadOf(oooId), subject: "Automatic reply: A site for Away Co", headers: { "auto-submitted": "auto-replied" }, text: "Back on November 30.", receivedAt: et(11, 2, 11) });
    const r = await runWatcher({ transport: t });
    expect(r.byKind).toEqual({ bounce: 1, unsubscribe: 1, auto_reply: 1 });

    expect((await one("SELECT stage FROM leads WHERE id = $1", [bounceId])).stage).toBe("bounced");
    expect(await isSuppressed({ email: "owner@bounceco.com" })).toBe(true);
    expect((await one("SELECT stage FROM leads WHERE id = $1", [unsubId])).stage).toBe("unsubscribed");
    expect(await isSuppressed({ email: "owner@unsubco.com" })).toBe(true);
    // Out-of-office pauses: step 2 moves to the return date, sequence stays active.
    const oooStep2 = await one("SELECT m.scheduled_at FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.lead_id = $1 AND m.step = 2", [oooId]);
    expect(new Date(oooStep2.scheduled_at).toISOString()).toBe(et(11, 30, 9, 30).toISOString());
    expect((await one("SELECT status FROM enrollments WHERE lead_id = $1", [oooId])).status).toBe("active");
  });

  it("suppression entries are permanent", async () => {
    await unsubscribeLead(null, "x@y.com", "test");
    await query("DELETE FROM suppression");
    expect(await isSuppressed({ email: "x@y.com" })).toBe(true);
  });
});

describe("failures and idempotency", () => {
  it("retries with backoff up to 3 times, then alerts", async () => {
    await approvedLead("Fail Co", "f@failco.com", et(11, 1, 12));
    const t = new FakeTransport();
    t.failNext = 3;
    const clock = clockAt(et(11, 2, 10));
    await runScheduler({ transport: t, ...clock, tickMs: 60_000 });
    let m = await one("SELECT * FROM messages");
    expect(m.status).toBe("scheduled");
    expect(m.attempts).toBe(1);
    expect(new Date(m.scheduled_at).getTime()).toBeGreaterThanOrEqual(et(11, 2, 10, 5).getTime());
    clock.set(et(11, 2, 10, 30));
    await runScheduler({ transport: t, ...clock });
    clock.set(et(11, 2, 11, 30));
    const r = await runScheduler({ transport: t, ...clock });
    expect(r.failed).toBe(1);
    m = await one("SELECT * FROM messages");
    expect(m.status).toBe("failed");
    expect((await one("SELECT * FROM alerts")).kind).toBe("send_failed");
  });

  it("does not send twice after a crash mid-send", async () => {
    await approvedLead("Crash Co", "c@crashco.com", et(11, 1, 12));
    const t = new FakeTransport();
    // Simulate: the message went out, then the process died before recording it.
    const m = await one("SELECT * FROM messages");
    await t.send(`To: c@crashco.com\r\nSubject: x\r\nMessage-ID: ${m.rfc_message_id}\r\n\r\nbody`);
    await query("UPDATE messages SET status = 'sending', attempts = 1 WHERE id = $1", [m.id]);
    await runScheduler({ transport: t, ...clockAt(et(11, 2, 10)) });
    expect(t.sent).toHaveLength(1);
    expect((await one("SELECT status, gmail_message_id FROM messages WHERE id = $1", [m.id]))).toEqual({ status: "sent", gmail_message_id: "m1" });
  });

  it("honors a manual cap override and holidays", async () => {
    await setSetting("dailyCapOverride", 1);
    await approvedLead("H1", "h1@h1.com", et(11, 1, 12));
    await approvedLead("H2", "h2@h2.com", et(11, 1, 12));
    const t = new FakeTransport();
    await runScheduler({ transport: t, ...clockAt(et(11, 2, 10)), tickMs: 60 * 60_000 });
    expect(t.sent).toHaveLength(1);
    await setSetting("dailyCapOverride", null);
    const r = await runScheduler({ transport: t, ...clockAt(et(11, 25, 10)) }); // Thanksgiving week
    expect(r.skippedReason).toBe("outside sending window");
  });
});
