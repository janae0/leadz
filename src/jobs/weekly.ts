import { config } from "../config.js";
import { query } from "../db/pool.js";
import { ingestCandidate, markMultiLocationChains } from "../pipeline/ingest.js";
import { processLead, type ProcessDeps } from "../pipeline/process.js";
import { recentFilings } from "../sources/nyFilings.js";
import { searchPlaces } from "../sources/places.js";
import type { Candidate } from "../sources/types.js";
import { getSettings } from "../settings.js";

export interface WeeklySummary {
  placesRequests: number;
  candidates: number;
  created: number;
  merged: number;
  skipped: Record<string, number>;
  processed: number;
  drafted: number;
  byDisposition: Record<string, number>;
  errors: string[];
}

export interface WeeklyDeps extends ProcessDeps {
  sources?: { places?: boolean; nyFilings?: boolean };
}

// The weekly run: pull, deduplicate, check, and score new leads so the review
// queue is ready Monday morning.
export async function runWeekly(deps: WeeklyDeps = {}): Promise<WeeklySummary> {
  const settings = await getSettings();
  const summary: WeeklySummary = {
    placesRequests: 0, candidates: 0, created: 0, merged: 0, skipped: {}, processed: 0, drafted: 0, byDisposition: {}, errors: [],
  };
  const candidates: Candidate[] = [];

  if (deps.sources?.places !== false && config.googlePlacesApiKey) {
    for (const zip of settings.targetZips) {
      for (const category of settings.categories) {
        try {
          const r = await searchPlaces(zip, category, { fetchImpl: deps.fetchImpl });
          summary.placesRequests += r.requests;
          candidates.push(...r.candidates);
        } catch (err) {
          summary.errors.push(`Places ${zip}/${category.key}: ${(err as Error).message}`);
        }
      }
    }
  }
  if (deps.sources?.nyFilings !== false) {
    try {
      candidates.push(...(await recentFilings(settings.targetZips, { fetchImpl: deps.fetchImpl })));
    } catch (err) {
      summary.errors.push(`NY filings: ${(err as Error).message}`);
    }
  }

  summary.candidates = candidates.length;
  for (const c of candidates) {
    const r = await ingestCandidate(c, settings);
    if (r.status === "created") summary.created++;
    else if (r.status === "merged") summary.merged++;
    else summary.skipped[r.reason] = (summary.skipped[r.reason] ?? 0) + 1;
  }
  await markMultiLocationChains();

  const s = await processPending(deps);
  summary.processed = s.processed;
  summary.drafted = s.drafted;
  summary.byDisposition = s.byDisposition;
  summary.errors.push(...s.errors);
  return summary;
}

// Enrich and score every new lead not yet checked, plus archived leads whose
// 90-day re-check is due.
export async function processPending(deps: ProcessDeps = {}) {
  const out = { processed: 0, drafted: 0, byDisposition: {} as Record<string, number>, errors: [] as string[] };
  const due = await query<{ id: number }>(
    `SELECT l.id FROM leads l
     WHERE l.stage IN ('new', 'qualified')
       AND ((l.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM checks c WHERE c.lead_id = l.id))
         OR (l.next_action = 'recheck' AND l.next_action_at <= now()))
     ORDER BY l.priority DESC, l.id`,
  );
  for (const { id } of due) {
    try {
      const r = await processLead(id, { ...deps, draft: deps.draft ?? !!process.env.ANTHROPIC_API_KEY });
      out.processed++;
      if (r.drafted) out.drafted++;
      out.byDisposition[r.disposition] = (out.byDisposition[r.disposition] ?? 0) + 1;
    } catch (err) {
      out.errors.push(`Lead ${id}: ${(err as Error).message}`);
    }
  }
  return out;
}
