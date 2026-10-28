import { config } from "../config.js";
import { one, query, withTx } from "../db/pool.js";
import { latestCheck } from "../enrich/enricher.js";
import { placeDetails } from "../sources/places.js";
import { scoreLead } from "../score/scorer.js";
import { getSettings, type Settings } from "../settings.js";
import { claudeWriter, type DraftWriter } from "./claude.js";
import { buildFacts, type Facts } from "./facts.js";
import { getTemplate, signatureAndFooter } from "./templates.js";
import { validateDraft } from "./validator.js";

export interface DraftOutcome {
  draftId: number;
  ok: boolean;
  needsManual: boolean;
  errors: string[];
}

interface LeadRow {
  id: number;
  business_name: string;
  category: string | null;
  zip: string | null;
  fit: string | null;
  email: string | null;
  is_chain: boolean;
  stage: string;
  place_id: string | null;
  places_fetched_at: Date | null;
  places_json: { rating: number | null; reviewCount: number | null } | null;
}

const PLACES_REFRESH_MS = 7 * 86_400_000;

export function isAppointment(category: string | null, settings: Settings): boolean {
  return settings.categories.find((c) => c.key === category)?.appointment ?? false;
}

// Refresh Places details when a lead is worked, so the draft quotes current numbers.
async function refreshPlaces(lead: LeadRow): Promise<void> {
  if (!lead.place_id || !config.googlePlacesApiKey) return;
  if (lead.places_fetched_at && Date.now() - new Date(lead.places_fetched_at).getTime() < PLACES_REFRESH_MS) return;
  const p = await placeDetails(lead.place_id);
  if (!p) return;
  await query(
    "UPDATE leads SET places_json = $2, places_fetched_at = now() WHERE id = $1",
    [lead.id, JSON.stringify({ rating: p.rating ?? null, reviewCount: p.userRatingCount ?? 0 })],
  );
}

export async function generateDraft(leadId: number, writer: DraftWriter = claudeWriter): Promise<DraftOutcome> {
  const settings = await getSettings();
  let lead = await one<LeadRow>("SELECT * FROM leads WHERE id = $1", [leadId]);
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  await refreshPlaces(lead);
  lead = (await one<LeadRow>("SELECT * FROM leads WHERE id = $1", [leadId]))!;
  const check = await latestCheck(leadId);
  const places = lead.places_json;
  if (check && places) {
    check.rating = places.rating;
    check.review_count = places.reviewCount;
  }
  const appointment = isAppointment(lead.category, settings);
  const scored = check
    ? scoreLead({ check, isChain: lead.is_chain, appointment, hasEmail: !!lead.email }, settings.scoring)
    : null;
  const sender = { name: config.senderName || "PureTech" };
  const facts: Facts = buildFacts(lead, check, scored?.situation ?? null, appointment, settings, sender);
  const template = (await getTemplate(scored?.situation ?? "general")) ?? (await getTemplate("general"))!;
  const tail = signatureAndFooter(settings, sender);
  const signature = tail.split("\n\n-- \n")[0];

  let subject = "";
  let body = "";
  let errors: string[] = [];
  let ok = false;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    try {
      const written = await writer({
        template, facts, maxWords: settings.maxWords, bannedPhrases: settings.bannedPhrases,
        previousErrors: attempt > 0 ? errors : undefined,
      });
      subject = written.subject;
      body = written.body + tail;
      const v = validateDraft({ subject, body }, facts, settings, { signature });
      ok = v.ok;
      errors = v.errors;
    } catch (err) {
      errors = [`Drafting failed: ${(err as Error).message}`];
    }
  }
  if (!body) body = tail; // drafting failed outright; leave the footer for manual writing

  // Drafts that fail twice are flagged for manual writing.
  const needsManual = !ok;
  const draftId = await withTx(async (db) => {
    await query(
      `UPDATE drafts SET status = 'rejected', reject_reason = 'superseded', reviewed_at = now()
       WHERE lead_id = $1 AND status = 'pending'`,
      [leadId],
      db,
    );
    const row = await one<{ id: number }>(
      `INSERT INTO drafts (lead_id, template, subject, body, facts_json, needs_manual, validation_errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [leadId, template.name, subject, body, JSON.stringify(facts), needsManual, needsManual ? JSON.stringify(errors) : null],
      db,
    );
    await query(
      "UPDATE leads SET stage = 'drafted', updated_at = now() WHERE id = $1 AND stage IN ('new', 'qualified')",
      [leadId],
      db,
    );
    return row!.id;
  });
  return { draftId, ok, needsManual, errors };
}
