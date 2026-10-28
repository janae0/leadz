import { config } from "../config.js";
import { one, query } from "../db/pool.js";
import { domainOf, isOwnedSiteDomain } from "../util/normalize.js";
import { analyzeHtml, fetchSite, mobilePerformance, type FetchResult } from "./website.js";
import type { CheckFacts } from "../score/scorer.js";

type Fetch = typeof fetch;

export interface LeadForEnrich {
  id: number;
  website: string | null;
  email: string | null;
  places_json: { rating: number | null; reviewCount: number | null } | null;
}

export interface EnrichDeps {
  fetchImpl?: Fetch;
  pageSpeed?: (url: string) => Promise<number | null>;
  now?: Date;
}

export async function runChecks(lead: LeadForEnrich, deps: EnrichDeps = {}): Promise<CheckFacts & { raw: Record<string, unknown>; has_contact_form: boolean | null; final_url: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pageSpeed = deps.pageSpeed ?? ((url: string) => mobilePerformance(url, config.pageSpeedApiKey, fetchImpl));
  const raw: Record<string, unknown> = {};
  const rating = lead.places_json?.rating ?? null;
  const reviewCount = lead.places_json?.reviewCount ?? null;

  const domain = domainOf(lead.website);
  // A Facebook page or directory listing is not the business's own site.
  if (!lead.website || !isOwnedSiteDomain(domain)) {
    if (lead.website) raw.non_owned_site = lead.website;
    return {
      has_site: false, https_ok: null, http_status: null, final_url: null, mobile_score: null, has_viewport: null,
      copyright_year: null, has_booking: null, has_contact_form: null, rating, review_count: reviewCount,
      published_email: null, raw,
    };
  }

  const home: FetchResult = await fetchSite(lead.website, { fetchImpl });
  raw.home = { status: home.status, finalUrl: home.finalUrl, redirects: home.redirects, error: home.error };
  const analysis = home.html ? analyzeHtml(home.html, { siteDomain: domain, lastModified: home.lastModified, now: deps.now }) : null;

  let emails = analysis?.emails ?? [];
  let hasBooking = analysis?.hasBooking ?? null;
  let hasContactForm = analysis?.hasContactForm ?? null;

  // Look one level deeper (contact or booking page) for a published email
  // address or a booking path the homepage doesn't show.
  if (analysis && home.finalUrl && (emails.length === 0 || !hasBooking)) {
    const sameSite = analysis.contactLinks
      .map((h) => { try { return new URL(h, home.finalUrl!).toString(); } catch { return null; } })
      .filter((u): u is string => !!u && domainOf(u) === domainOf(home.finalUrl))
      .filter((u, i, all) => all.indexOf(u) === i)
      .slice(0, 2);
    for (const url of sameSite) {
      const page = await fetchSite(url, { fetchImpl });
      if (!page.html) continue;
      const a = analyzeHtml(page.html, { siteDomain: domain, now: deps.now });
      if (emails.length === 0) emails = a.emails;
      hasBooking = hasBooking || a.hasBooking;
      hasContactForm = hasContactForm || a.hasContactForm;
    }
  }

  const mobileScore = home.ok && home.finalUrl ? await pageSpeed(home.finalUrl) : null;

  const copyrightYear = analysis
    ? (analysis.copyrightYear ?? null)
    : null;
  if (analysis?.lastModifiedYear) raw.last_modified_year = analysis.lastModifiedYear;
  if (analysis?.title) raw.title = analysis.title;
  if (emails.length > 1) raw.other_emails = emails.slice(1);

  return {
    has_site: true,
    https_ok: home.ok && home.https,
    http_status: home.status,
    final_url: home.finalUrl,
    mobile_score: mobileScore,
    has_viewport: analysis ? analysis.hasViewport : null,
    copyright_year: copyrightYear,
    has_booking: hasBooking,
    has_contact_form: hasContactForm,
    rating,
    review_count: reviewCount,
    published_email: emails[0] ?? null,
    raw,
  };
}

export async function enrichLead(leadId: number, deps: EnrichDeps = {}): Promise<CheckFacts> {
  const lead = await one<LeadForEnrich>("SELECT id, website, email, places_json FROM leads WHERE id = $1", [leadId]);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  const c = await runChecks(lead, deps);
  await query(
    `INSERT INTO checks (lead_id, has_site, https_ok, http_status, final_url, mobile_score, has_viewport, copyright_year,
       has_booking, has_contact_form, published_email, rating, review_count, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [leadId, c.has_site, c.https_ok, c.http_status, c.final_url, c.mobile_score, c.has_viewport, c.copyright_year,
      c.has_booking, c.has_contact_form, c.published_email, c.rating, c.review_count, c.raw],
  );
  // Use the address the business publishes itself; a submitted or hand-entered one wins.
  if (!lead.email && c.published_email) {
    await query("UPDATE leads SET email = $2, updated_at = now() WHERE id = $1 AND email IS NULL", [leadId, c.published_email]);
  }
  return c;
}

export async function latestCheck(leadId: number): Promise<(CheckFacts & { ran_at: Date; raw_json: any; has_contact_form: boolean | null }) | undefined> {
  return one("SELECT * FROM checks WHERE lead_id = $1 ORDER BY ran_at DESC, id DESC LIMIT 1", [leadId]);
}
