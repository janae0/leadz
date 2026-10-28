import type { ScoringWeights } from "../settings.js";

export interface CheckFacts {
  has_site: boolean | null;
  https_ok: boolean | null;
  http_status: number | null;
  mobile_score: number | null;
  has_viewport: boolean | null;
  copyright_year: number | null;
  has_booking: boolean | null;
  rating: number | null;
  review_count: number | null;
  published_email: string | null;
}

export interface ScoreInput {
  check: CheckFacts;
  isChain: boolean;
  appointment: boolean; // category is an appointment business
  hasEmail: boolean;
  now?: Date;
}

export interface ScoreLine {
  signal: string;
  points: number;
}

export type Situation = "no_website" | "outdated_site" | "no_booking" | "weak_google";
export type Fit = "core" | "growth" | "visibility" | null;

export interface ScoreResult {
  score: number;
  breakdown: ScoreLine[];
  situation: Situation | null;
  fit: Fit;
}

export function siteBroken(c: CheckFacts): boolean {
  return c.has_site === true && (c.https_ok === false || (c.http_status !== null && (c.http_status < 200 || c.http_status >= 400)) || c.http_status === null);
}

export function copyrightStale(c: CheckFacts, now: Date): boolean {
  return c.copyright_year !== null && now.getUTCFullYear() - c.copyright_year >= 3;
}

export function scoreLead(input: ScoreInput, w: ScoringWeights): ScoreResult {
  const { check: c } = input;
  const now = input.now ?? new Date();
  const lines: ScoreLine[] = [];
  const add = (signal: string, points: number) => lines.push({ signal, points });

  const noSite = c.has_site === false;
  if (noSite) add("No website", w.noWebsite);
  if (siteBroken(c)) add("Site broken or not HTTPS", w.brokenOrNotHttps);
  if (c.mobile_score !== null && c.mobile_score < 50) add(`Mobile performance ${c.mobile_score} (below 50)`, w.slowMobile);
  if (copyrightStale(c, now)) add(`Copyright year ${c.copyright_year}`, w.oldCopyright);
  const noBooking = input.appointment && (noSite || c.has_booking === false);
  if (noBooking) add("Appointment business with no online booking", w.apptNoBooking);
  if (c.review_count !== null && c.review_count < 20) add(`${c.review_count} Google reviews (fewer than 20)`, w.fewReviews);
  if (c.rating !== null && c.rating < 4.0) add(`Rating ${c.rating} (below 4.0)`, w.lowRating);
  if (input.hasEmail) add("Published email found", w.publishedEmail);
  if (input.isChain) add("Chain or franchise location", w.chain);

  const raw = lines.reduce((s, l) => s + l.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  // Template situation, in the order the design lists them.
  let situation: Situation | null = null;
  if (noSite) situation = "no_website";
  else if (siteBroken(c) || (c.mobile_score !== null && c.mobile_score < 50) || copyrightStale(c, now) || c.has_viewport === false) situation = "outdated_site";
  else if (noBooking) situation = "no_booking";
  else if ((c.review_count !== null && c.review_count < 20) || (c.rating !== null && c.rating < 4.0)) situation = "weak_google";

  const fit: Fit =
    situation === "no_website" || situation === "outdated_site" ? "core"
      : situation === "no_booking" ? "growth"
        : situation === "weak_google" ? "visibility"
          : null;

  return { score, breakdown: lines, situation, fit };
}

export type Disposition = "draft" | "queue" | "walk_in" | "archive";

// Thresholds: 60+ drafts automatically, 40-59 queues without a draft, below 40
// archives, and no email but 50+ goes onto the walk-in route instead.
export function disposition(
  score: number,
  opts: { hasEmail: boolean; priority: boolean; walkInAllowed: boolean; thresholds: { draft: number; queue: number; walkIn: number } },
): Disposition {
  const t = opts.thresholds;
  if (!opts.hasEmail) {
    if (opts.walkInAllowed && (score >= t.walkIn || opts.priority)) return "walk_in";
    return score >= t.queue || opts.priority ? "queue" : "archive";
  }
  if (opts.priority) return "draft"; // form submissions skip scoring and go to the top
  if (score >= t.draft) return "draft";
  if (score >= t.queue) return "queue";
  return "archive";
}
