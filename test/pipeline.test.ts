import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { one, query } from "../src/db/pool.js";
import { ingestCandidate, markMultiLocationChains } from "../src/pipeline/ingest.js";
import { processLead } from "../src/pipeline/process.js";
import { processPending } from "../src/jobs/weekly.js";
import { searchPlaces } from "../src/sources/places.js";
import { filingToCandidate } from "../src/sources/nyFilings.js";
import { getSettings } from "../src/settings.js";
import { suppressDomain, suppressEmail } from "../src/suppression.js";
import type { DraftWriter } from "../src/draft/claude.js";
import { closeDb, htmlResponse, resetDb } from "./helpers.js";
import { config } from "../src/config.js";

beforeEach(resetDb);
afterAll(closeDb);

const base = { source: "places" as const, businessName: "Riverdale Cuts", address: "5601 Riverdale Ave, Bronx, NY 10471, USA", zip: "10471", category: "salon_barber" };

describe("ingest and dedupe", () => {
  it("dedupes on place ID, then name plus address, then website domain", async () => {
    const s = await getSettings();
    const a = await ingestCandidate({ ...base, placeId: "P1", sourceRef: "P1", website: "https://riverdalecuts.com" }, s);
    expect(a.status).toBe("created");
    const b = await ingestCandidate({ ...base, placeId: "P1", sourceRef: "P1" }, s);
    expect(b).toEqual({ status: "merged", leadId: (a as any).leadId });
    const c = await ingestCandidate({ source: "manual", businessName: "Riverdale Cuts LLC", address: "5601 Riverdale Avenue, Bronx NY 10471", phone: "718-555-0101" }, s);
    expect(c.status).toBe("merged");
    const d = await ingestCandidate({ source: "referral", referrer: "Sam (accountant)", businessName: "RC Barbers", website: "http://www.riverdalecuts.com/" }, s);
    expect(d.status).toBe("merged");
    const lead = await one("SELECT * FROM leads WHERE id = $1", [(a as any).leadId]);
    expect(lead.phone).toBe("7185550101");
    const sources = await query("SELECT source, referrer FROM lead_sources WHERE lead_id = $1 ORDER BY id", [lead.id]);
    expect(sources.map((x) => x.source)).toEqual(["places", "manual", "referral"]);
    expect(sources[2].referrer).toBe("Sam (accountant)");
    // Facebook pages are not a dedupe key.
    const e = await ingestCandidate({ source: "places", placeId: "P9", businessName: "Other", website: "https://facebook.com/other" }, s);
    const f = await ingestCandidate({ source: "places", placeId: "P10", businessName: "Another", website: "https://facebook.com/another" }, s);
    expect(e.status).toBe("created");
    expect(f.status).toBe("created");
  });

  it("skips closed businesses, opt-outs, and clients", async () => {
    const s = await getSettings();
    expect(await ingestCandidate({ ...base, placeId: "P2", businessStatus: "CLOSED_PERMANENTLY" }, s)).toEqual({ status: "skipped", reason: "closed" });
    await suppressEmail("owner@gone.com", "unsubscribe");
    expect((await ingestCandidate({ source: "manual", businessName: "Gone", email: "owner@gone.com" }, s)).status).toBe("skipped");
    await suppressDomain("client.com", "client");
    expect((await ingestCandidate({ source: "places", placeId: "P3", businessName: "Client", website: "https://client.com" }, s)).status).toBe("skipped");
  });

  it("never makes filing-only leads walk-in targets, and flags chains", async () => {
    const s = await getSettings();
    const c = filingToCandidate({ dos_id: "123", current_entity_name: "NEW THING LLC", initial_dos_filing_date: "2026-10-20T00:00:00", dos_process_address_1: "1 Main St", dos_process_city: "Bronx", dos_process_state: "NY", dos_process_zip: "10463" })!;
    const r = await ingestCandidate(c, s);
    expect((await one("SELECT walk_in_allowed FROM leads WHERE id = $1", [(r as any).leadId])).walk_in_allowed).toBe(false);
    const chain = await ingestCandidate({ source: "places", placeId: "C1", businessName: "Dunkin'" }, s);
    expect((await one("SELECT is_chain FROM leads WHERE id = $1", [(chain as any).leadId])).is_chain).toBe(true);
    for (const [i, addr] of ["1 A St", "2 B St", "3 C St"].entries()) {
      await ingestCandidate({ source: "places", placeId: `L${i}`, businessName: "Local Mini Chain", address: addr }, s);
    }
    expect(await markMultiLocationChains()).toBe(3);
  });
});

describe("places search", () => {
  it("requests only the needed fields and keeps results in the ZIP", async () => {
    (config as any).googlePlacesApiKey = "test-key";
    let sentMask = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentMask = (init.headers as Record<string, string>)["X-Goog-FieldMask"];
      return new Response(JSON.stringify({
        places: [
          { id: "A", displayName: { text: "In Zip" }, formattedAddress: "1 Broadway, Bronx, NY 10463, USA", userRatingCount: 4 },
          { id: "B", displayName: { text: "Out of Zip" }, formattedAddress: "1 Broadway, New York, NY 10004, USA" },
        ],
      }));
    }) as unknown as typeof fetch;
    const r = await searchPlaces("10463", (await getSettings()).categories[0], { fetchImpl });
    (config as any).googlePlacesApiKey = "";
    expect(sentMask).toContain("places.websiteUri");
    expect(sentMask).not.toContain("reviews");
    expect(r.candidates.map((c) => c.placeId)).toEqual(["A"]);
    expect(r.candidates[0].reviewCount).toBe(4);
  });
});

// A fake web: one slow, old salon site with a published email and no booking.
function fakeWeb(): typeof fetch {
  return (async (url: string) => {
    if (url.startsWith("http://oldsalon.com")) return new Response("", { status: 301, headers: { location: "https://oldsalon.com/" } });
    if (url === "https://oldsalon.com/") {
      return htmlResponse(`<html><head><title>Old Salon</title></head><body><a href="/contact">Contact</a>
        <footer>© 2018 Old Salon</footer></body></html>`);
    }
    if (url === "https://oldsalon.com/contact") return htmlResponse(`<a href="mailto:hello@oldsalon.com">hello@oldsalon.com</a>`);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const okWriter: DraftWriter = async (req) => ({
  subject: "Old Salon on phones",
  body: `Hi Old Salon team,\n\nYour site scored ${req.facts.measured.mobile_score} on Google's mobile speed test, so it loads slowly on phones. I build quick, simple sites for salons nearby.\n\nCould I send you a short list of fixes?`,
});

describe("process a lead end to end", () => {
  it("checks the site, scores, and drafts a validated email", async () => {
    const s = await getSettings();
    const r = await ingestCandidate({ source: "places", placeId: "S1", businessName: "Old Salon", category: "salon_barber", website: "http://oldsalon.com", rating: 4.1, reviewCount: 12, zip: "10463" }, s);
    const out = await processLead((r as any).leadId, { fetchImpl: fakeWeb(), pageSpeed: async () => 31, writer: okWriter, now: new Date("2026-10-28T12:00:00Z") });
    // +15 mobile, +10 copyright 2018, +10 appointment with no booking, +10 few reviews, +10 published email
    expect(out.score).toBe(55);
    expect(out.disposition).toBe("queue");
    const lead = await one("SELECT * FROM leads WHERE id = $1", [out.leadId]);
    expect(lead.email).toBe("hello@oldsalon.com");
    expect(lead.stage).toBe("qualified");
    const check = await one("SELECT * FROM checks WHERE lead_id = $1", [out.leadId]);
    expect(check).toMatchObject({ has_site: true, https_ok: true, mobile_score: 31, has_viewport: false, copyright_year: 2018, has_booking: false });
  });

  it("drafts automatically at 60 and up, retries once, then flags manual writing", async () => {
    const s = await getSettings();
    const r = await ingestCandidate({ source: "places", placeId: "S2", businessName: "No Site Studio", category: "fitness_dance", email: "hi@nosite.com", reviewCount: 5, rating: 4.8, zip: "10463" }, s);
    let calls = 0;
    const lying: DraftWriter = async () => {
      calls++;
      return { subject: "Your site", body: "Hi,\n\nYour mobile score is 12, guaranteed fix. Want it?" };
    };
    const out = await processLead((r as any).leadId, { fetchImpl: fakeWeb(), writer: lying });
    expect(out.score).toBe(65); // 35 + 10 + 10 + 10
    expect(out.drafted).toBe(true);
    expect(calls).toBe(2);
    const draft = await one("SELECT * FROM drafts WHERE lead_id = $1", [out.leadId]);
    expect(draft.needs_manual).toBe(true);
    expect(draft.validation_errors.join(" ")).toMatch(/Banned phrase/);
    expect(draft.body).toContain("PO Box 123, Bronx, NY 10463");
    expect(draft.facts_json.measured).toEqual({ has_website: false, online_booking: false, review_count: 5, rating: 4.8 });
    expect((await one("SELECT stage FROM leads WHERE id = $1", [out.leadId])).stage).toBe("drafted");
  });

  it("puts high scorers without email on the walk-in route and archives low scorers", async () => {
    const s = await getSettings();
    const walk = await ingestCandidate({ source: "places", placeId: "W1", businessName: "Corner Barber", category: "salon_barber", reviewCount: 3, address: "10 W 238th St, Bronx, NY 10463" }, s);
    const low = await ingestCandidate({ source: "places", placeId: "W2", businessName: "Fancy Firm", category: "real_estate", reviewCount: 300, rating: 4.9, website: "http://oldsalon.com" }, s);
    await processPending({ fetchImpl: fakeWeb(), pageSpeed: async () => 90, draft: false });
    const w = await one("SELECT * FROM leads WHERE id = $1", [(walk as any).leadId]);
    expect(w.walk_in).toBe(true);
    expect(w.score).toBe(55);
    const l = await one("SELECT * FROM leads WHERE id = $1", [(low as any).leadId]);
    expect(l.archived_at).not.toBeNull();
    expect(l.next_action).toBe("recheck");
    // processPending doesn't pick archived leads up again until the re-check is due.
    expect((await processPending({ fetchImpl: fakeWeb(), draft: false })).processed).toBe(0);
  });
});
