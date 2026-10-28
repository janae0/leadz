import type { Settings } from "../settings.js";
import type { Facts } from "./facts.js";
import { UNSUBSCRIBE_PLACEHOLDER, splitFooter } from "./templates.js";

// Checks a draft before it reaches the review queue: every number and claim
// must appear in facts_json, the required footer must be present, and banned
// phrases must be absent.

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

interface Claim {
  name: string;
  pattern: RegExp;
  supported: (f: Facts) => boolean;
}

const CLAIMS: Claim[] = [
  {
    name: "mobile speed or score",
    pattern: /\b(mobile|phone)[- ](speed|score|performance)\b|\bpagespeed\b|\bloads? (slowly|slow)\b|\bslow (to load|on (phones|mobile))\b|\bspeed score\b/i,
    supported: (f) => f.measured.mobile_score !== undefined,
  },
  {
    name: "no website",
    pattern: /\b(no|without an?|don[’']?t have an?|doesn[’']?t have an?|lack of an?|haven[’']?t got an?)\s+(own\s+)?(web\s?site|site)\b/i,
    supported: (f) => f.measured.has_website === false,
  },
  {
    name: "site security / HTTPS",
    pattern: /\b(https|ssl|not secure|insecure|security warning|padlock)\b/i,
    supported: (f) => f.measured.https === false,
  },
  {
    name: "site broken or down",
    pattern: /\b(is down|not loading|won[’']?t load|doesn[’']?t load|broken|error page|isn[’']?t loading)\b/i,
    supported: (f) => f.measured.site_broken === true,
  },
  {
    name: "online booking",
    pattern: /\b(online booking|book online|booking (link|page|button|system)|no way to book|can[’']?t book)\b/i,
    supported: (f) => f.measured.online_booking === false,
  },
  {
    name: "review count",
    pattern: /\breviews?\b/i,
    supported: (f) => f.measured.review_count !== undefined,
  },
  {
    name: "star rating",
    pattern: /\b(rating|rated|stars?)\b/i,
    supported: (f) => f.measured.rating !== undefined,
  },
  {
    name: "copyright year",
    pattern: /\bcopyright\b|©/i,
    supported: (f) => f.measured.copyright_year !== undefined,
  },
  {
    name: "mobile layout",
    pattern: /\b(viewport|desktop[- ]only|not mobile[- ]friendly|isn[’']?t mobile[- ]friendly|hard to read on (a )?phones?)\b/i,
    supported: (f) => f.measured.has_viewport === false,
  },
  {
    name: "founding-client half-price offer",
    pattern: /\b(half[- ]price|half off|50% off|founding[- ]client|founding)\b/i,
    supported: (f) => f.offer.founding_client_half_price_setup,
  },
];

function allowedNumbers(f: Facts): Set<string> {
  const nums = new Set<string>();
  const addFrom = (s: string | null | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) nums.add(m[0]);
  };
  for (const v of Object.values(f.measured)) if (typeof v === "number") nums.add(String(v));
  if (f.measured.rating !== undefined) nums.add(f.measured.rating.toFixed(1));
  // Scales the measured numbers are quoted on ("31 out of 100", "3.8 out of 5").
  if (f.measured.mobile_score !== undefined) nums.add("100");
  if (f.measured.rating !== undefined) nums.add("5");
  addFrom(f.business_name);
  addFrom(f.neighborhood);
  addFrom(f.category);
  return nums;
}

function numbersIn(text: string): string[] {
  // Times of day ("10:30") and URLs are not claims.
  const cleaned = text.replace(/https?:\/\/\S+/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
  return [...cleaned.matchAll(/(?<![\w.])\d+(?:[.,]\d+)?(?![\w])/g)].map((m) => m[0].replace(/,/g, ""));
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

export function validateDraft(
  draft: { subject: string; body: string },
  facts: Facts,
  settings: Pick<Settings, "bannedPhrases" | "maxWords" | "mailingAddress">,
  opts: { signature?: string } = {},
): ValidationResult {
  const errors: string[] = [];
  const subject = draft.subject.trim();
  const { main, footer } = splitFooter(draft.body);
  let writing = main;
  if (opts.signature && writing.trimEnd().endsWith(opts.signature.trim())) {
    writing = writing.trimEnd().slice(0, -opts.signature.trim().length);
  }

  // Required footer
  if (!footer) errors.push("Footer is missing");
  else {
    if (!settings.mailingAddress.trim()) errors.push("Mailing address is not set in settings");
    else if (!footer.includes(settings.mailingAddress.trim())) errors.push("Footer is missing the postal address");
    if (!footer.includes(UNSUBSCRIBE_PLACEHOLDER)) errors.push("Footer is missing the unsubscribe link");
    if (!/reply\s+"?stop"?/i.test(footer)) errors.push('Footer is missing the "reply stop" wording');
  }

  // Subject rules
  if (!subject) errors.push("Subject is empty");
  if (/^\s*(re|fw|fwd)\s*:/i.test(subject)) errors.push('Subject must not start with a fake "Re:" or "Fwd:"');

  // Banned phrases
  const lowerAll = `${subject}\n${writing}`.toLowerCase();
  for (const phrase of settings.bannedPhrases) {
    if (phrase && lowerAll.includes(phrase.toLowerCase())) errors.push(`Banned phrase: "${phrase}"`);
  }

  // House style
  const words = wordCount(writing);
  if (words > settings.maxWords) errors.push(`Body is ${words} words; the limit is ${settings.maxWords}`);
  if (!writing.includes("?")) errors.push("Body needs one question as the call to action");

  // Every number must come from the facts.
  const allowed = allowedNumbers(facts);
  for (const n of [...numbersIn(subject), ...numbersIn(writing)]) {
    if (!allowed.has(n) && !allowed.has(String(Number(n)))) errors.push(`Number "${n}" does not appear in the facts`);
  }

  // Every claim must be backed by a measured fact.
  for (const claim of CLAIMS) {
    if ((claim.pattern.test(subject) || claim.pattern.test(writing)) && !claim.supported(facts)) {
      errors.push(`Claim about ${claim.name} is not backed by the facts`);
    }
  }

  // Subject must not mention things the body doesn't.
  for (const claim of CLAIMS) {
    if (claim.pattern.test(subject) && !claim.pattern.test(writing)) {
      errors.push(`Subject mentions ${claim.name} but the body does not`);
    }
  }
  for (const n of numbersIn(subject)) {
    if (!numbersIn(writing).includes(n)) errors.push(`Subject mentions "${n}" but the body does not`);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
