import { config } from "../config.js";
import type { Category } from "../settings.js";
import { zipFromAddress } from "../util/normalize.js";
import type { Candidate } from "./types.js";

// Google Places API (New), Text Search. Requests name only the fields scoring
// uses, since website and review-count fields bill at a higher tier.
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const SEARCH_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "nextPageToken",
].join(",");

export interface PlacesResult {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
}

type Fetch = typeof fetch;

export function placeToCandidate(p: PlacesResult, category: string): Candidate {
  return {
    source: "places",
    sourceRef: p.id,
    placeId: p.id,
    businessName: p.displayName?.text ?? "(unnamed)",
    category,
    address: p.formattedAddress ?? null,
    zip: zipFromAddress(p.formattedAddress),
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? 0,
    businessStatus: p.businessStatus ?? null,
  };
}

export async function searchPlaces(
  zip: string,
  category: Category,
  opts: { maxPages?: number; fetchImpl?: Fetch } = {},
): Promise<{ candidates: Candidate[]; requests: number }> {
  if (!config.googlePlacesApiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 3;
  const candidates: Candidate[] = [];
  let pageToken: string | undefined;
  let requests = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": SEARCH_FIELDS,
      },
      body: JSON.stringify({ textQuery: `${category.query} in ${zip}`, pageSize: 20, pageToken, regionCode: "US" }),
    });
    requests++;
    if (!res.ok) throw new Error(`Places search failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { places?: PlacesResult[]; nextPageToken?: string };
    for (const p of data.places ?? []) {
      const c = placeToCandidate(p, category.key);
      // Text Search matches loosely; keep only businesses inside the target ZIP.
      if (c.zip === zip) candidates.push(c);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return { candidates, requests };
}

// Refreshes Places details for one lead when it is worked, so stored Places
// content stays current (Google's terms limit how long most of it may be kept).
export async function placeDetails(placeId: string, fetchImpl: Fetch = fetch): Promise<PlacesResult | null> {
  if (!config.googlePlacesApiKey) return null;
  const fields = "id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,userRatingCount,businessStatus";
  const res = await fetchImpl(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": config.googlePlacesApiKey, "X-Goog-FieldMask": fields },
  });
  if (!res.ok) return null;
  return (await res.json()) as PlacesResult;
}
