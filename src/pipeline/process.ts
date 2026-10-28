import { one, query } from "../db/pool.js";
import { enrichLead, type EnrichDeps } from "../enrich/enricher.js";
import { generateDraft, isAppointment } from "../draft/drafter.js";
import type { DraftWriter } from "../draft/claude.js";
import { disposition, scoreLead, type Disposition } from "../score/scorer.js";
import { getSettings } from "../settings.js";

export interface ProcessDeps extends EnrichDeps {
  writer?: DraftWriter;
  draft?: boolean; // false skips drafting (e.g. when no Claude key is configured)
}

export interface ProcessOutcome {
  leadId: number;
  score: number;
  disposition: Disposition;
  drafted: boolean;
}

// Enrich, score, and route one lead: draft, queue, walk-in route, or archive.
export async function processLead(leadId: number, deps: ProcessDeps = {}): Promise<ProcessOutcome> {
  const settings = await getSettings();
  const check = await enrichLead(leadId, deps);
  const lead = await one<{
    id: number; category: string | null; email: string | null; is_chain: boolean; priority: boolean;
    walk_in_allowed: boolean; stage: string;
  }>("SELECT * FROM leads WHERE id = $1", [leadId]);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const result = scoreLead(
    { check, isChain: lead.is_chain, appointment: isAppointment(lead.category, settings), hasEmail: !!lead.email, now: deps.now },
    settings.scoring,
  );
  const d = disposition(result.score, {
    hasEmail: !!lead.email, priority: lead.priority, walkInAllowed: lead.walk_in_allowed, thresholds: settings.thresholds,
  });

  // Only leads that haven't been worked yet move automatically.
  const routable = lead.stage === "new" || lead.stage === "qualified";
  await query(
    `UPDATE leads SET score = $2, score_breakdown = $3, fit = $4, updated_at = now(),
       stage = CASE WHEN $5 AND $6 <> 'archive' THEN 'qualified' ELSE stage END,
       walk_in = CASE WHEN $5 THEN $6 = 'walk_in' ELSE walk_in END,
       archived_at = CASE WHEN $5 AND $6 = 'archive' THEN now() WHEN $5 THEN NULL ELSE archived_at END,
       next_action = CASE WHEN $5 AND $6 = 'archive' THEN 'recheck'
                          WHEN $5 AND $6 = 'walk_in' THEN 'walk-in visit'
                          WHEN $5 AND next_action = 'recheck' THEN NULL ELSE next_action END,
       next_action_at = CASE WHEN $5 AND $6 = 'archive' THEN now() + interval '90 days'
                             WHEN $5 AND next_action = 'recheck' THEN NULL ELSE next_action_at END
     WHERE id = $1`,
    [leadId, result.score, JSON.stringify(result.breakdown), result.fit, routable, d],
  );

  let drafted = false;
  if (routable && d === "draft" && deps.draft !== false) {
    await generateDraft(leadId, deps.writer);
    drafted = true;
  }
  return { leadId, score: result.score, disposition: d, drafted };
}
