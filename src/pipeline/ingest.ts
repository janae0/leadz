import { one, query, withTx, type Queryable } from "../db/pool.js";
import type { Candidate } from "../sources/types.js";
import { isSuppressed } from "../suppression.js";
import type { Settings } from "../settings.js";
import {
  domainOf, isOwnedSiteDomain, normalizeAddress, normalizeEmail, normalizeName, normalizePhone, zipFromAddress,
} from "../util/normalize.js";

export type IngestOutcome =
  | { status: "created"; leadId: number }
  | { status: "merged"; leadId: number }
  | { status: "skipped"; reason: "closed" | "suppressed" | "client" | "no_name" };

export function isChainName(name: string, chainNames: string[]): boolean {
  const n = normalizeName(name);
  return chainNames.some((c) => {
    const cn = normalizeName(c);
    return cn.length > 0 && (n === cn || n.startsWith(`${cn} `) || n.endsWith(` ${cn}`) || n.includes(` ${cn} `));
  });
}

interface ExistingLead {
  id: number;
  stage: string;
}

async function findExisting(
  db: Queryable,
  c: { placeId: string | null; normName: string; normAddress: string | null; domain: string | null },
): Promise<ExistingLead | undefined> {
  // Deduplicate on Google place ID first, then normalized name plus address,
  // then website domain.
  if (c.placeId) {
    const row = await one<ExistingLead>("SELECT id, stage FROM leads WHERE place_id = $1", [c.placeId], db);
    if (row) return row;
  }
  if (c.normAddress) {
    const row = await one<ExistingLead>(
      "SELECT id, stage FROM leads WHERE norm_name = $1 AND norm_address = $2 ORDER BY id LIMIT 1",
      [c.normName, c.normAddress],
      db,
    );
    if (row) return row;
  }
  if (c.domain && isOwnedSiteDomain(c.domain)) {
    const row = await one<ExistingLead>(
      "SELECT id, stage FROM leads WHERE website_domain = $1 ORDER BY id LIMIT 1",
      [c.domain],
      db,
    );
    if (row) return row;
  }
  return undefined;
}

export async function ingestCandidate(candidate: Candidate, settings: Settings): Promise<IngestOutcome> {
  if (!candidate.businessName?.trim()) return { status: "skipped", reason: "no_name" };
  if (candidate.businessStatus === "CLOSED_PERMANENTLY") return { status: "skipped", reason: "closed" };

  const normName = normalizeName(candidate.businessName);
  const normAddress = candidate.address ? normalizeAddress(candidate.address) : null;
  const website = candidate.website?.trim() || null;
  const domain = domainOf(website);
  const email = normalizeEmail(candidate.email);
  const phone = normalizePhone(candidate.phone);
  const zip = candidate.zip ?? zipFromAddress(candidate.address);
  const placeId = candidate.placeId ?? null;

  return withTx(async (db) => {
    const existing = await findExisting(db, { placeId, normName, normAddress, domain });

    if (!existing) {
      // Never create a lead that matches the opt-out list or an existing client.
      if (await isSuppressed({ email, website }, db)) return { status: "skipped", reason: "suppressed" } as const;
    }

    const places = candidate.source === "places"
      ? { rating: candidate.rating ?? null, reviewCount: candidate.reviewCount ?? null }
      : null;

    let leadId: number;
    let status: "created" | "merged";
    if (existing) {
      leadId = existing.id;
      status = "merged";
      // Fill blanks only; never overwrite what a person entered or an earlier source found.
      await query(
        `UPDATE leads SET
           category = COALESCE(category, $2),
           address = COALESCE(address, $3),
           norm_address = COALESCE(norm_address, $4),
           zip = COALESCE(zip, $5),
           phone = COALESCE(phone, $6),
           website = COALESCE(website, $7),
           website_domain = COALESCE(website_domain, $8),
           email = COALESCE(email, $9),
           place_id = COALESCE(place_id, $10),
           places_json = COALESCE($11, places_json),
           places_fetched_at = CASE WHEN $11::jsonb IS NULL THEN places_fetched_at ELSE now() END,
           walk_in_allowed = walk_in_allowed OR $12,
           priority = priority OR $13,
           updated_at = now()
         WHERE id = $1`,
        [
          leadId, candidate.category ?? null, candidate.address ?? null, normAddress, zip, phone, website, domain,
          email, placeId, places ? JSON.stringify(places) : null,
          candidate.source === "places", candidate.source === "form",
        ],
        db,
      );
    } else {
      const row = await one<{ id: number }>(
        `INSERT INTO leads (business_name, norm_name, category, address, norm_address, zip, phone, website,
           website_domain, email, place_id, places_json, places_fetched_at, is_chain, priority, walk_in_allowed, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $12::jsonb IS NULL THEN NULL ELSE now() END,
           $13,$14,$15,$16)
         RETURNING id`,
        [
          candidate.businessName.trim(), normName, candidate.category ?? null, candidate.address ?? null, normAddress,
          zip, phone, website, domain, email, placeId, places ? JSON.stringify(places) : null,
          isChainName(candidate.businessName, settings.chainNames),
          candidate.source === "form",
          // Filing addresses are often registered agents or homes: never walk-in targets.
          candidate.source !== "ny_filings",
          candidate.notes ?? null,
        ],
        db,
      );
      leadId = row!.id;
      status = "created";
    }

    // Store each source and its first-seen date, so the scoreboard can tell
    // which sources produce signings.
    await query(
      `INSERT INTO lead_sources (lead_id, source, source_ref, referrer)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lead_id, source, source_ref) DO NOTHING`,
      [leadId, candidate.source, candidate.sourceRef ?? "", candidate.referrer ?? null],
      db,
    );
    return { status, leadId } as const;
  });
}

// A name that shows up at three or more addresses is treated as a chain even
// if it isn't on the configured list.
export async function markMultiLocationChains(db?: Queryable): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE leads SET is_chain = true, updated_at = now()
     WHERE is_chain = false AND norm_name IN (
       SELECT norm_name FROM leads WHERE norm_name <> ''
       GROUP BY norm_name HAVING COUNT(DISTINCT COALESCE(norm_address, id::text)) >= 3)
     RETURNING id`,
    [],
    db,
  );
  return rows.length;
}
