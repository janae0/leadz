import { domainOf, normalizeEmail } from "../util/normalize.js";
import { FREE_MAIL } from "../suppression.js";

type Fetch = typeof fetch;

export interface FetchResult {
  ok: boolean; // final response was 2xx
  status: number | null; // final HTTP status, null when the request failed outright
  finalUrl: string | null;
  https: boolean; // final URL is https
  redirects: string[];
  html: string;
  lastModified: string | null;
  error: string | null;
}

const USER_AGENT = "Mozilla/5.0 (compatible; PureTechSiteCheck/1.0; +https://puretech.example/check)";

export async function fetchSite(url: string, opts: { fetchImpl?: Fetch; timeoutMs?: number } = {}): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let current = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  const redirects: string[] = [];
  try {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetchImpl(current, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        redirects.push(current);
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      const html = type.includes("html") || type === "" ? (await res.text()).slice(0, 2_000_000) : "";
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        finalUrl: current,
        https: current.startsWith("https://"),
        redirects,
        html,
        lastModified: res.headers.get("last-modified"),
        error: null,
      };
    }
    return { ok: false, status: null, finalUrl: current, https: current.startsWith("https://"), redirects, html: "", lastModified: null, error: "too many redirects" };
  } catch (err) {
    return { ok: false, status: null, finalUrl: current, https: current.startsWith("https://"), redirects, html: "", lastModified: null, error: (err as Error).message };
  }
}

const BOOKING_HOSTS = [
  "calendly.com", "acuityscheduling.com", "as.me", "vagaro.com", "booksy.com", "styleseat.com", "mindbodyonline.com",
  "mindbody.io", "schedulicity.com", "glossgenius.com", "fresha.com", "square.site", "squareup.com/appointments",
  "book.squareup.com", "setmore.com", "zocdoc.com", "opentable.com", "resy.com", "exploretock.com", "yelp.com/reservations",
  "simplybook.me", "appointy.com", "zenoti.com", "boulevard.io", "joinblvd.com", "localmed.com", "nexhealth.com",
  "solutionreach.com", "clio.com/book", "youcanbook.me", "tidycal.com", "wellnessliving.com", "classpass.com",
  "zenplanner.com", "pike13.com", "momence.com", "arketa.co", "getsquire.com", "toasttab.com",
];

const BOOKING_PHRASES = /\b(book (now|online|an appointment|a table|your)|schedule (an? )?(appointment|consultation|visit)|request (an )?appointment|make a reservation|reserve (a table|now|online)|online booking)\b/i;

export interface SiteAnalysis {
  hasViewport: boolean;
  copyrightYear: number | null;
  lastModifiedYear: number | null;
  hasBooking: boolean;
  hasContactForm: boolean;
  emails: string[]; // published addresses, best first
  contactLinks: string[];
  title: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&copy;/gi, "©")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
}

const IGNORED_EMAIL = /(\.(png|jpe?g|gif|svg|webp)$)|(^(example|email|name|your(name|email)?|user)@)|(@(example|domain|email|sentry|sentry-next|wixpress|godaddy|squarespace|wix)\.)/i;

export function analyzeHtml(html: string, opts: { siteDomain?: string | null; lastModified?: string | null; now?: Date } = {}): SiteAnalysis {
  const now = opts.now ?? new Date();
  const thisYear = now.getUTCFullYear();
  const text = htmlToText(html);

  const hasViewport = /<meta[^>]+name\s*=\s*["']?viewport["']?[^>]*>/i.test(html);

  // Copyright year: take the latest plausible year mentioned next to © or "copyright".
  let copyrightYear: number | null = null;
  const re = /(?:©|\(c\)|copyright)\s*(?:[a-z.,]*\s*)?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi;
  for (const m of text.matchAll(re)) {
    const years = [m[1], m[2]].filter(Boolean).map(Number).filter((y) => y >= 1995 && y <= thisYear + 1);
    for (const y of years) if (copyrightYear === null || y > copyrightYear) copyrightYear = y;
  }

  let lastModifiedYear: number | null = null;
  if (opts.lastModified) {
    const d = new Date(opts.lastModified);
    if (!Number.isNaN(d.getTime())) lastModifiedYear = d.getUTCFullYear();
  }

  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]));
  const lowerHrefs = hrefs.map((h) => h.toLowerCase());
  const hasBooking = lowerHrefs.some((h) => BOOKING_HOSTS.some((b) => h.includes(b))) || BOOKING_PHRASES.test(text);

  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const hasContactForm = forms.some((f) => /type\s*=\s*["']?email|name\s*=\s*["']?[^"'>]*email|<textarea/i.test(f));

  // Only addresses the business itself publishes: mailto links and addresses
  // written on the page. Never guessed.
  const found = new Set<string>();
  for (const h of hrefs) {
    if (h.toLowerCase().startsWith("mailto:")) {
      const e = normalizeEmail(decodeURIComponent(h.slice(7)));
      if (e) found.add(e);
    }
  }
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = normalizeEmail(m[0]);
    if (e) found.add(e);
  }
  const siteDomain = opts.siteDomain ?? null;
  const emails = [...found]
    .filter((e) => !IGNORED_EMAIL.test(e))
    .filter((e) => {
      const d = domainOf(e);
      // Keep addresses on the business's own domain or a mailbox provider;
      // drop third-party addresses such as the web designer's.
      return !!d && (FREE_MAIL.has(d) || !siteDomain || d === siteDomain || d.endsWith(`.${siteDomain}`));
    })
    .sort((a, b) => Number(domainOf(b) === siteDomain) - Number(domainOf(a) === siteDomain));

  const contactLinks = hrefs.filter((h, i) => /contact|about|book|appointment/.test(lowerHrefs[i]) && !lowerHrefs[i].startsWith("mailto:"));

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : null;

  return { hasViewport, copyrightYear, lastModifiedYear, hasBooking, hasContactForm, emails, contactLinks, title };
}

type PageSpeedFetch = Fetch;

// PageSpeed Insights, mobile strategy. Returns 0-100 or null if unavailable.
export async function mobilePerformance(url: string, apiKey: string, fetchImpl: PageSpeedFetch = fetch): Promise<number | null> {
  const params = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (apiKey) params.set("key", apiKey);
  try {
    const res = await fetchImpl(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { lighthouseResult?: { categories?: { performance?: { score?: number | null } } } };
    const score = data.lighthouseResult?.categories?.performance?.score;
    return typeof score === "number" ? Math.round(score * 100) : null;
  } catch {
    return null;
  }
}
