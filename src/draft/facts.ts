import type { CheckFacts, Situation } from "../score/scorer.js";
import { copyrightStale, siteBroken } from "../score/scorer.js";
import type { Settings } from "../settings.js";

// facts_json holds exactly the facts a draft may use. Only check results that
// were actually measured go in; anything unknown is left out entirely.
export interface Facts {
  business_name: string;
  category: string | null;
  neighborhood: string | null;
  situation: Situation | null;
  measured: {
    has_website?: false;
    https?: false;
    site_broken?: true;
    http_status?: number;
    mobile_score?: number;
    has_viewport?: false;
    copyright_year?: number;
    online_booking?: false;
    review_count?: number;
    rating?: number;
  };
  offer: { founding_client_half_price_setup: boolean; free_checkup: true };
  sender: { name: string; company: string };
}

export function buildFacts(
  lead: { business_name: string; category: string | null; zip: string | null; fit: string | null },
  check: CheckFacts | undefined,
  situation: Situation | null,
  appointment: boolean,
  settings: Settings,
  sender: { name: string },
  now: Date = new Date(),
): Facts {
  const measured: Facts["measured"] = {};
  if (check) {
    if (check.has_site === false) measured.has_website = false;
    if (check.has_site && check.https_ok === false && check.http_status !== null && check.http_status < 400) measured.https = false;
    if (siteBroken(check) && (check.http_status === null || check.http_status >= 400)) {
      measured.site_broken = true;
      if (check.http_status !== null) measured.http_status = check.http_status;
    }
    if (check.mobile_score !== null) measured.mobile_score = check.mobile_score;
    if (check.has_viewport === false) measured.has_viewport = false;
    if (copyrightStale(check, now)) measured.copyright_year = check.copyright_year!;
    if (appointment && (check.has_site === false || check.has_booking === false)) measured.online_booking = false;
    if (check.review_count !== null) measured.review_count = check.review_count;
    if (check.rating !== null) measured.rating = Number(check.rating);
  }
  const category = settings.categories.find((c) => c.key === lead.category);
  return {
    business_name: lead.business_name,
    category: category?.label ?? lead.category,
    neighborhood: (lead.zip && settings.neighborhoods[lead.zip]) || null,
    situation,
    measured,
    offer: {
      founding_client_half_price_setup:
        settings.foundingSlotsOpen && settings.foundingSlotsLeft > 0 && (lead.fit === "core" || lead.fit === "growth"),
      free_checkup: true,
    },
    sender: { name: sender.name, company: settings.companyName },
  };
}

// Short, human-readable lines shown beside each draft in the review queue.
export function factLines(f: Facts): string[] {
  const m = f.measured;
  const lines: string[] = [];
  if (m.has_website === false) lines.push("No website");
  if (m.site_broken) lines.push(m.http_status ? `Site returns HTTP ${m.http_status}` : "Site does not load");
  if (m.https === false) lines.push("Site is not on HTTPS");
  if (m.mobile_score !== undefined) lines.push(`Mobile score ${m.mobile_score}`);
  if (m.has_viewport === false) lines.push("No mobile viewport tag");
  if (m.copyright_year !== undefined) lines.push(`Copyright ${m.copyright_year}`);
  if (m.online_booking === false) lines.push("No online booking");
  if (m.review_count !== undefined) lines.push(`${m.review_count} Google reviews`);
  if (m.rating !== undefined) lines.push(`Rating ${m.rating}`);
  if (f.offer.founding_client_half_price_setup) lines.push("Founding-client offer applies");
  return lines;
}
