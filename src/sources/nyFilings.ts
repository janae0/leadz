import { config } from "../config.js";
import type { Candidate } from "./types.js";

// NY Department of State filings on data.ny.gov (Socrata). Newly formed
// corporations and LLCs with filing date and address. These have no phone or
// email, and many addresses are registered agents or homes, so they become
// research leads and never walk-in targets.
//
// Field names below match the "Active Corporations: Beginning 1800" dataset.
// If you point NY_FILINGS_DATASET at another dataset, adjust FIELDS to match.
const FIELDS = {
  id: "dos_id",
  name: "current_entity_name",
  filedAt: "initial_dos_filing_date",
  address1: "dos_process_address_1",
  city: "dos_process_city",
  state: "dos_process_state",
  zip: "dos_process_zip",
};

type Fetch = typeof fetch;

export function filingToCandidate(row: Record<string, string | undefined>): Candidate | null {
  const name = row[FIELDS.name];
  if (!name) return null;
  const zip = (row[FIELDS.zip] ?? "").slice(0, 5) || null;
  const parts = [row[FIELDS.address1], row[FIELDS.city], [row[FIELDS.state], zip].filter(Boolean).join(" ")].filter(Boolean);
  return {
    source: "ny_filings",
    sourceRef: row[FIELDS.id] ?? null,
    businessName: name,
    address: parts.length ? parts.join(", ") : null,
    zip,
    notes: row[FIELDS.filedAt] ? `NY filing ${row[FIELDS.filedAt]!.slice(0, 10)}` : null,
  };
}

export async function recentFilings(
  zips: string[],
  opts: { days?: number; now?: Date; fetchImpl?: Fetch } = {},
): Promise<Candidate[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 30) * 86_400_000).toISOString().slice(0, 10);
  // ZIPs may be stored as ZIP+4, so match on the prefix.
  const zipClause = zips.map((z) => `starts_with(${FIELDS.zip}, '${z.replace(/\D/g, "")}')`).join(" OR ");
  const where = `${FIELDS.filedAt} >= '${since}T00:00:00' AND (${zipClause})`;
  const params = new URLSearchParams({ $where: where, $limit: "1000", $order: `${FIELDS.filedAt} DESC` });
  const headers: Record<string, string> = {};
  if (config.nyOpenDataAppToken) headers["X-App-Token"] = config.nyOpenDataAppToken;
  const res = await fetchImpl(`https://data.ny.gov/resource/${config.nyFilingsDataset}.json?${params}`, { headers });
  if (!res.ok) throw new Error(`NY filings request failed (${res.status}): ${await res.text()}`);
  const rows = (await res.json()) as Record<string, string>[];
  return rows.map(filingToCandidate).filter((c): c is Candidate => c !== null);
}
