export type SourceName = "places" | "ny_filings" | "form" | "referral" | "manual";

// A business as a source reports it, before matching against existing leads.
export interface Candidate {
  source: SourceName;
  sourceRef?: string | null; // place ID, DOS ID, form submission ID
  referrer?: string | null;
  businessName: string;
  category?: string | null;
  address?: string | null;
  zip?: string | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null; // only addresses the business published or submitted itself
  placeId?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  businessStatus?: string | null;
  notes?: string | null;
}
