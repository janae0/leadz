import { describe, expect, it } from "vitest";
import { normalizeAddress, normalizeName, normalizePhone, domainOf, streetOf, zipFromAddress } from "../src/util/normalize.js";
import { dailyCap, inSendWindow, isHoliday, nextSendSlot, thanksgivingWeek, zonedTimeToUtc } from "../src/util/time.js";
import { disposition, scoreLead, type CheckFacts } from "../src/score/scorer.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { validateDraft } from "../src/draft/validator.js";
import { buildFacts } from "../src/draft/facts.js";
import { signatureAndFooter } from "../src/draft/templates.js";
import { classifyInbound, parseReturnDate } from "../src/watch/classify.js";
import { analyzeHtml } from "../src/enrich/website.js";
import { buildMime, readUnsubscribeToken, unsubscribeToken } from "../src/send/mime.js";
import { isChainName } from "../src/pipeline/ingest.js";
import type { InboundMessage } from "../src/send/gmail.js";

const settings = { ...DEFAULT_SETTINGS, mailingAddress: "PO Box 123, Bronx, NY 10463" };
const et = (y: number, m: number, d: number, h: number, min = 0) => zonedTimeToUtc(y, m, d, h, min, "America/New_York");

describe("normalize", () => {
  it("normalizes names, addresses, phones, domains", () => {
    expect(normalizeName("Joe's Pizza & Pasta, LLC")).toBe("joes pizza and pasta");
    expect(normalizeAddress("123 West 238th Street, Bronx, NY 10463, USA")).toBe(normalizeAddress("123 W 238 St, Bronx NY 10463"));
    expect(normalizePhone("+1 (718) 555-0101")).toBe("7185550101");
    expect(normalizePhone("555-0101")).toBeNull();
    expect(domainOf("https://www.Example.com/about")).toBe("example.com");
    expect(domainOf("hello@shop.com")).toBe("shop.com");
    expect(zipFromAddress("5601 Riverdale Ave, Bronx, NY 10471, USA")).toBe("10471");
    expect(streetOf("5601 Riverdale Ave, Bronx")).toEqual({ street: "Riverdale Ave", number: 5601 });
  });
  it("spots chains", () => {
    expect(isChainName("Dunkin'", settings.chainNames)).toBe(true);
    expect(isChainName("Planet Fitness - Riverdale", settings.chainNames)).toBe(true);
    expect(isChainName("Riverdale Dance Studio", settings.chainNames)).toBe(false);
  });
});

describe("sending window and cap", () => {
  it("knows Thanksgiving week", () => {
    expect(thanksgivingWeek(2026)).toEqual({ start: "2026-11-23", end: "2026-11-29" });
    expect(isHoliday("2026-11-25", settings)).toBe(true);
    expect(isHoliday("2026-12-24", settings)).toBe(true);
    expect(isHoliday("2026-11-20", settings)).toBe(false);
    expect(isHoliday("2026-11-03", { ...settings, extraHolidays: ["2026-11-02..2026-11-03"] })).toBe(true);
  });
  it("sends weekdays 9:30 to 4:30 Eastern only", () => {
    expect(inSendWindow(et(2026, 11, 2, 9, 29), settings)).toBe(false);
    expect(inSendWindow(et(2026, 11, 2, 9, 30), settings)).toBe(true);
    expect(inSendWindow(et(2026, 11, 2, 16, 29), settings)).toBe(true);
    expect(inSendWindow(et(2026, 11, 2, 16, 30), settings)).toBe(false);
    expect(inSendWindow(et(2026, 10, 31, 12), settings)).toBe(false); // Saturday
  });
  it("finds the next slot across weekends and holidays", () => {
    // Friday evening -> Monday 9:30
    expect(nextSendSlot(et(2026, 10, 30, 18), settings).toISOString()).toBe(et(2026, 11, 2, 9, 30).toISOString());
    // Friday before Thanksgiving week, after hours -> Monday after it
    expect(nextSendSlot(et(2026, 11, 20, 17), settings).toISOString()).toBe(et(2026, 11, 30, 9, 30).toISOString());
    // across the DST change (Nov 1, 2026)
    expect(nextSendSlot(et(2026, 10, 31, 12), settings).toISOString()).toBe("2026-11-02T14:30:00.000Z");
  });
  it("ramps the daily cap", () => {
    expect(dailyCap(et(2026, 11, 2, 10), null, null)).toBe(15);
    expect(dailyCap(et(2026, 11, 6, 10), "2026-11-02", null)).toBe(15);
    expect(dailyCap(et(2026, 11, 10, 10), "2026-11-02", null)).toBe(25);
    expect(dailyCap(et(2026, 11, 17, 10), "2026-11-02", null)).toBe(40);
    expect(dailyCap(et(2026, 11, 17, 10), "2026-11-02", 15)).toBe(15);
  });
});

const blankCheck: CheckFacts = {
  has_site: true, https_ok: true, http_status: 200, mobile_score: 80, has_viewport: true, copyright_year: 2026,
  has_booking: true, rating: 4.6, review_count: 120, published_email: null,
};
const now = new Date("2026-10-28T12:00:00Z");

describe("scoring", () => {
  it("applies the design weights and caps at 100", () => {
    const r = scoreLead({ check: { ...blankCheck, has_site: false, https_ok: null, http_status: null, mobile_score: null, has_booking: null, review_count: 8, rating: 3.8 }, isChain: false, appointment: true, hasEmail: true, now }, settings.scoring);
    // 35 no site + 10 appt/no booking + 10 few reviews + 5 rating + 10 email = 70
    expect(r.score).toBe(70);
    expect(r.situation).toBe("no_website");
    expect(r.fit).toBe("core");
    const all = scoreLead({ check: { ...blankCheck, https_ok: false, mobile_score: 20, copyright_year: 2019, has_booking: false, review_count: 3, rating: 3 }, isChain: false, appointment: true, hasEmail: true, now }, { ...settings.scoring, noWebsite: 90 });
    expect(all.score).toBeLessThanOrEqual(100);
  });
  it("penalizes chains and handles a healthy site", () => {
    const r = scoreLead({ check: blankCheck, isChain: true, appointment: false, hasEmail: true, now }, settings.scoring);
    expect(r.score).toBe(0);
    expect(r.situation).toBeNull();
  });
  it("routes by threshold", () => {
    const t = settings.thresholds;
    expect(disposition(65, { hasEmail: true, priority: false, walkInAllowed: true, thresholds: t })).toBe("draft");
    expect(disposition(45, { hasEmail: true, priority: false, walkInAllowed: true, thresholds: t })).toBe("queue");
    expect(disposition(30, { hasEmail: true, priority: false, walkInAllowed: true, thresholds: t })).toBe("archive");
    expect(disposition(55, { hasEmail: false, priority: false, walkInAllowed: true, thresholds: t })).toBe("walk_in");
    expect(disposition(55, { hasEmail: false, priority: false, walkInAllowed: false, thresholds: t })).toBe("queue");
    expect(disposition(10, { hasEmail: true, priority: true, walkInAllowed: true, thresholds: t })).toBe("draft");
  });
});

describe("draft validator", () => {
  const check: CheckFacts = { ...blankCheck, mobile_score: 31, has_booking: false };
  const facts = buildFacts({ business_name: "Riverdale Cuts", category: "salon_barber", zip: "10471", fit: "growth" }, check, "outdated_site", true, settings, { name: "Maria Lopez" }, now);
  const tail = signatureAndFooter(settings, { name: "Maria Lopez" });
  const signature = tail.split("\n\n-- \n")[0];
  const good = {
    subject: "Riverdale Cuts on phones",
    body: "Hi Riverdale Cuts team,\n\nI ran your site through Google's mobile test and it scored 31 out of 100, so it loads slowly on phones, which is where most people look you up. I help Riverdale businesses fix exactly this.\n\nWould it help if I sent over the two or three changes that would speed it up?" + tail,
  };

  it("passes a draft that sticks to the facts", () => {
    const v = validateDraft(good, facts, settings, { signature });
    expect(v.errors).toEqual([]);
  });
  it("catches a planted false claim", () => {
    const planted = { ...good, body: good.body.replace("scored 31", "scored 22") };
    expect(validateDraft(planted, facts, settings, { signature }).errors).toContain('Number "22" does not appear in the facts');
    const reviews = { ...good, body: good.body.replace("Would it", "You also only have a handful of reviews. Would it") };
    expect(validateDraft(reviews, { ...facts, measured: { ...facts.measured, review_count: undefined } }, settings, { signature }).errors)
      .toContain("Claim about review count is not backed by the facts");
  });
  it("requires the footer and blocks banned phrases and fake Re:", () => {
    const v = validateDraft({ subject: "Re: your site", body: "Guaranteed #1 on Google. Interested?" }, facts, settings, { signature });
    expect(v.errors).toContain("Footer is missing");
    expect(v.errors).toContain('Subject must not start with a fake "Re:" or "Fwd:"');
    expect(v.errors.some((e) => e.startsWith("Banned phrase"))).toBe(true);
  });
  it("enforces word limit and a question", () => {
    const long = { subject: "hello", body: `${"word ".repeat(130)}.${tail}` };
    const v = validateDraft(long, facts, settings, { signature });
    expect(v.errors.some((e) => e.includes("limit is 120"))).toBe(true);
    expect(v.errors).toContain("Body needs one question as the call to action");
  });
  it("only mentions the founding offer when it applies", () => {
    const offer = { ...good, body: good.body.replace("Would it", "Founding clients get a half-price setup. Would it") };
    expect(validateDraft(offer, facts, settings, { signature }).errors).not.toContain("Claim about founding-client half-price offer is not backed by the facts");
    const closed = { ...facts, offer: { ...facts.offer, founding_client_half_price_setup: false } };
    expect(validateDraft(offer, closed, settings, { signature }).errors).toContain("Claim about founding-client half-price offer is not backed by the facts");
  });
  it("blocks subjects that mention things not in the body", () => {
    const v = validateDraft({ ...good, subject: "Your Google reviews" }, facts, settings, { signature });
    expect(v.errors).toContain("Subject mentions review count but the body does not");
  });
});

describe("website analysis", () => {
  it("reads viewport, copyright, booking, and published emails", () => {
    const html = `<html><head><title>Bella Salon</title><meta name="viewport" content="width=device-width"></head>
      <body><a href="https://www.vagaro.com/bella">Book</a><a href="mailto:Bella@BellaSalon.com?subject=hi">Email</a>
      <p>Write to webmaster@designco.com</p><footer>&copy; 2015 - 2019 Bella Salon</footer>
      <form><input type="email" name="email"><textarea></textarea></form></body></html>`;
    const a = analyzeHtml(html, { siteDomain: "bellasalon.com", now });
    expect(a.hasViewport).toBe(true);
    expect(a.copyrightYear).toBe(2019);
    expect(a.hasBooking).toBe(true);
    expect(a.hasContactForm).toBe(true);
    expect(a.emails).toEqual(["bella@bellasalon.com"]);
    expect(a.title).toBe("Bella Salon");
  });
  it("never invents an address", () => {
    const a = analyzeHtml("<html><body>Call us at 718-555-0101</body></html>", { siteDomain: "shop.com", now });
    expect(a.emails).toEqual([]);
    expect(a.hasViewport).toBe(false);
    expect(a.hasBooking).toBe(false);
  });
});

function inbound(p: Partial<InboundMessage>): InboundMessage {
  return { id: "x", threadId: "t", labelIds: [], headers: {}, from: "owner@shop.com", subject: "Re: hi", text: "", receivedAt: now, ...p };
}

describe("inbound classification", () => {
  it("detects bounces and the failed address", () => {
    const c = classifyInbound(inbound({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", text: "Final-Recipient: rfc822; gone@shop.com\nAction: failed" }), "me@out.com");
    expect(c).toEqual({ kind: "bounce", failedRecipient: "gone@shop.com" });
  });
  it("detects out-of-office with a return date", () => {
    const c = classifyInbound(inbound({ headers: { "auto-submitted": "auto-replied" }, subject: "Out of Office", text: "I'm away and will be back on Monday, November 9." }), "me@out.com");
    expect(c.kind).toBe("auto_reply");
    expect(c.kind === "auto_reply" && c.returnDate?.toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(parseReturnDate("Returning 11/12", now)?.toISOString().slice(0, 10)).toBe("2026-11-12");
    expect(parseReturnDate("Thanks for your email", now)).toBeNull();
  });
  it("detects opt-outs but not friendly replies", () => {
    expect(classifyInbound(inbound({ text: "STOP\n\nOn Mon, Maria wrote:\n> hi" }), "me@out.com").kind).toBe("unsubscribe");
    expect(classifyInbound(inbound({ text: "Please remove me from your list." }), "me@out.com").kind).toBe("unsubscribe");
    expect(classifyInbound(inbound({ text: "Stop by anytime this week, we'd love to chat!\n\n> unsubscribe here" }), "me@out.com").kind).toBe("reply");
    expect(classifyInbound(inbound({ from: "me@out.com" }), "me@out.com").kind).toBe("own");
  });
});

describe("mime and unsubscribe tokens", () => {
  it("builds a message with one-click unsubscribe headers", () => {
    const raw = buildMime({ fromName: "Maria Lopez", fromEmail: "maria@out.com", to: "a@b.com", subject: "Héllo", text: "Hi\nthere", messageId: "<k@out.com>", unsubscribeUrl: "https://x/u/t", unsubscribeMailto: "maria@out.com", inReplyTo: "<a@out.com>", references: ["<a@out.com>"] });
    expect(raw).toContain('From: "Maria Lopez" <maria@out.com>');
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("List-Unsubscribe: <https://x/u/t>, <mailto:maria@out.com?subject=unsubscribe>");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain("In-Reply-To: <a@out.com>");
  });
  it("round-trips tokens and rejects tampering", () => {
    const t = unsubscribeToken(42, "Owner@Shop.com");
    expect(readUnsubscribeToken(t)).toEqual({ leadId: 42, email: "owner@shop.com" });
    expect(readUnsubscribeToken(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
  });
});
