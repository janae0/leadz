// Normalization used before matching leads against each other, the
// suppression list, and existing clients.

const NAME_SUFFIXES = [
  "llc", "l l c", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited",
  "pllc", "pc", "p c", "llp", "lp", "dds", "md", "pa", "the",
];

export function normalizeName(name: string): string {
  let s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = s.split(" ").filter((w) => w && !NAME_SUFFIXES.includes(w));
  s = words.join(" ");
  return s;
}

const STREET_ABBREVIATIONS: Record<string, string> = {
  street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", road: "rd", rd: "rd",
  boulevard: "blvd", blvd: "blvd", place: "pl", pl: "pl", parkway: "pkwy", pkwy: "pkwy",
  drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", ter: "ter",
  highway: "hwy", hwy: "hwy", square: "sq", sq: "sq", east: "e", e: "e", west: "w", w: "w",
  north: "n", n: "n", south: "s", s: "s", suite: "ste", ste: "ste", apartment: "apt", apt: "apt",
  floor: "fl", fl: "fl",
};

export function normalizeAddress(address: string): string {
  const s = address
    .toLowerCase()
    .replace(/,?\s*(usa|united states)$/, "")
    .replace(/#/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return s
    .split(" ")
    .filter(Boolean)
    .map((w) => STREET_ABBREVIATIONS[w] ?? w.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .join(" ");
}

// Returns a ten-digit US number, or null when it can't be read as one.
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

export function formatPhone(digits: string | null): string {
  if (!digits || digits.length !== 10) return digits ?? "";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function domainOf(urlOrEmail: string | null | undefined): string | null {
  if (!urlOrEmail) return null;
  const s = urlOrEmail.trim().toLowerCase();
  if (s.includes("@") && !s.includes("/")) return s.split("@").pop() || null;
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `http://${s}`);
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// Website domains that are directories or social profiles, not the business's own site.
const NON_OWNED_DOMAINS = [
  "facebook.com", "instagram.com", "yelp.com", "linktr.ee", "google.com", "business.site",
  "tiktok.com", "twitter.com", "x.com", "squareup.com", "doordash.com", "grubhub.com",
  "ubereats.com", "seamless.com", "booksy.com", "vagaro.com", "styleseat.com", "zocdoc.com",
];

export function isOwnedSiteDomain(domain: string | null): boolean {
  if (!domain) return false;
  return !NON_OWNED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function zipFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  return m ? m[1] : null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const s = email.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

// Splits "123 W 238th St, Bronx, NY 10463" into a street key and house number
// for grouping the walk-in route by street.
export function streetOf(address: string | null | undefined): { street: string; number: number } {
  if (!address) return { street: "Unknown street", number: 0 };
  const first = address.split(",")[0].trim();
  const m = first.match(/^(\d+)[a-z]?(?:-\d+)?\s+(.*)$/i);
  if (!m) return { street: first || "Unknown street", number: 0 };
  return { street: m[2], number: Number(m[1]) };
}
