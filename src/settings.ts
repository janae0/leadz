import { one, query, type Queryable, pool } from "./db/pool.js";

// Settings J edits in the admin UI. Defaults match the design doc; a row in
// the settings table overrides the default for that key.

export interface Category {
  key: string;
  label: string;
  query: string; // Places Text Search phrase, e.g. "hair salon"
  appointment: boolean; // appointment businesses: no online booking is a Growth-tier fit
}

export interface ScoringWeights {
  noWebsite: number;
  brokenOrNotHttps: number;
  slowMobile: number;
  oldCopyright: number;
  apptNoBooking: number;
  fewReviews: number;
  lowRating: number;
  publishedEmail: number;
  chain: number;
}

export interface Settings {
  targetZips: string[];
  neighborhoods: Record<string, string>; // ZIP -> name used in drafts
  categories: Category[];
  scoring: ScoringWeights;
  thresholds: { draft: number; queue: number; walkIn: number };
  chainNames: string[];
  foundingSlotsOpen: boolean;
  foundingSlotsLeft: number;
  sendWindow: { start: string; end: string }; // "HH:MM" Eastern
  extraHolidays: string[]; // "YYYY-MM-DD" or "YYYY-MM-DD..YYYY-MM-DD"
  skipThanksgivingWeek: boolean;
  skipLateDecember: boolean;
  rampStartDate: string | null; // first day the outreach domain sent mail
  dailyCapOverride: number | null;
  spacingMinutes: { min: number; max: number };
  mailingAddress: string;
  companyName: string;
  senderTitle: string;
  bannedPhrases: string[];
  maxWords: number;
  notifyOnReply: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  targetZips: ["10463", "10471"],
  neighborhoods: { "10463": "Kingsbridge", "10471": "Riverdale" },
  categories: [
    { key: "salon_barber", label: "Salons and barbers", query: "hair salon barber shop", appointment: true },
    { key: "fitness_dance", label: "Fitness and dance studios", query: "fitness studio dance studio", appointment: true },
    { key: "restaurant_cafe", label: "Restaurants and cafes", query: "restaurant cafe", appointment: false },
    { key: "medical_dental", label: "Medical and dental offices", query: "dentist doctor office", appointment: true },
    { key: "law_accounting", label: "Law and accounting firms", query: "law firm accountant", appointment: true },
    { key: "real_estate", label: "Real estate", query: "real estate agency", appointment: false },
    { key: "contractor", label: "Contractors", query: "contractor plumber electrician", appointment: false },
    { key: "retail", label: "Retail shops", query: "retail store boutique", appointment: false },
  ],
  scoring: {
    noWebsite: 35,
    brokenOrNotHttps: 15,
    slowMobile: 15,
    oldCopyright: 10,
    apptNoBooking: 10,
    fewReviews: 10,
    lowRating: 5,
    publishedEmail: 10,
    chain: -40,
  },
  thresholds: { draft: 60, queue: 40, walkIn: 50 },
  chainNames: [
    "starbucks", "dunkin", "mcdonalds", "subway", "burger king", "wendys", "chipotle", "dominos",
    "papa johns", "pizza hut", "kfc", "popeyes", "taco bell", "7-eleven", "cvs", "walgreens",
    "duane reade", "rite aid", "planet fitness", "blink fitness", "crunch fitness", "supercuts",
    "great clips", "h&r block", "jackson hewitt", "re/max", "century 21", "coldwell banker",
    "keller williams", "the ups store", "gnc", "t-mobile", "verizon", "at&t", "metro by t-mobile",
    "aspen dental", "citymd", "sallys beauty", "bank of america", "chase", "td bank",
  ],
  foundingSlotsOpen: true,
  foundingSlotsLeft: 3,
  sendWindow: { start: "09:30", end: "16:30" },
  extraHolidays: [],
  skipThanksgivingWeek: true,
  skipLateDecember: true,
  rampStartDate: null,
  dailyCapOverride: null,
  spacingMinutes: { min: 3, max: 8 },
  mailingAddress: "",
  companyName: "PureTech",
  senderTitle: "",
  bannedPhrases: ["guaranteed", "guarantee", "#1 on google", "number one on google", "first page of google", "risk-free", "act now", "100%"],
  maxWords: 120,
  notifyOnReply: true,
};

export type SettingKey = keyof Settings;

export async function getSettings(db: Queryable = pool): Promise<Settings> {
  const rows = await query<{ key: string; value: unknown }>("SELECT key, value FROM settings", [], db);
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) merged[row.key] = row.value;
  }
  return merged as unknown as Settings;
}

export async function setSetting<K extends SettingKey>(key: K, value: Settings[K], db: Queryable = pool): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
    db,
  );
}

// Job state (Gmail history cursor, next-send gate) shares the settings table
// under keys that are not user settings.
export async function getState<T>(key: string, db: Queryable = pool): Promise<T | undefined> {
  const row = await one<{ value: T }>("SELECT value FROM settings WHERE key = $1", [`state:${key}`], db);
  return row?.value;
}

export async function setState(key: string, value: unknown, db: Queryable = pool): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`state:${key}`, JSON.stringify(value)],
    db,
  );
}
