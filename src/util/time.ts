import { config } from "../config.js";
import type { Settings } from "../settings.js";

// All sending rules are in Eastern time; these helpers convert between UTC
// instants and Eastern wall-clock parts without a date library.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, tz = config.timezone): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), weekday: WEEKDAYS[p.weekday],
  };
}

// The UTC instant at which the clock in tz reads the given wall time.
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz = config.timezone): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset even across a DST change.
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(ts), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ts += guess - asUtc;
  }
  return new Date(ts);
}

export function dateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function localDateKey(date: Date, tz = config.timezone): string {
  const p = zonedParts(date, tz);
  return dateKey(p.year, p.month, p.day);
}

function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return dateKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Monday through Sunday of the week holding the fourth Thursday of November.
export function thanksgivingWeek(year: number): { start: string; end: string } {
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThursday = 1 + ((4 - nov1 + 7) % 7);
  const thanksgiving = firstThursday + 21;
  const monday = thanksgiving - 3;
  return { start: dateKey(year, 11, monday), end: dateKey(year, 11, monday + 6) };
}

export function isHoliday(key: string, settings: Pick<Settings, "extraHolidays" | "skipThanksgivingWeek" | "skipLateDecember">): boolean {
  const year = Number(key.slice(0, 4));
  if (settings.skipThanksgivingWeek) {
    const tw = thanksgivingWeek(year);
    if (key >= tw.start && key <= tw.end) return true;
  }
  if (settings.skipLateDecember && key >= `${year}-12-22` && key <= `${year}-12-31`) return true;
  for (const entry of settings.extraHolidays) {
    const [start, end] = entry.split("..").map((s) => s.trim());
    if (key >= start && key <= (end || start)) return true;
  }
  return false;
}

export function isSendingDay(key: string, settings: Parameters<typeof isHoliday>[1]): boolean {
  const wd = weekdayOfKey(key);
  return wd !== 0 && wd !== 6 && !isHoliday(key, settings);
}

function parseHm(hm: string): [number, number] {
  const [h, m] = hm.split(":").map(Number);
  return [h, m || 0];
}

type WindowSettings = Pick<Settings, "sendWindow" | "extraHolidays" | "skipThanksgivingWeek" | "skipLateDecember">;

export function inSendWindow(date: Date, settings: WindowSettings): boolean {
  const key = localDateKey(date);
  if (!isSendingDay(key, settings)) return false;
  const p = zonedParts(date);
  const mins = p.hour * 60 + p.minute;
  const [sh, sm] = parseHm(settings.sendWindow.start);
  const [eh, em] = parseHm(settings.sendWindow.end);
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

// Earliest instant at or after `from` that falls inside the sending window.
export function nextSendSlot(from: Date, settings: WindowSettings): Date {
  if (inSendWindow(from, settings)) return from;
  const [sh, sm] = parseHm(settings.sendWindow.start);
  let key = localDateKey(from);
  for (let i = 0; i < 60; i++) {
    if (isSendingDay(key, settings)) {
      const [y, m, d] = key.split("-").map(Number);
      const start = zonedTimeToUtc(y, m, d, sh, sm);
      if (start.getTime() >= from.getTime()) return start;
    }
    key = addDaysKey(key, 1);
  }
  throw new Error("No sending day found in the next 60 days; check the holiday settings");
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function daysBetweenKeys(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

// Daily cap ramps with the domain's sending history: 15 a day in week 1,
// 25 in week 2, then 40.
export function dailyCap(today: Date, rampStart: string | null, override: number | null): number {
  if (override !== null && override !== undefined) return override;
  if (!rampStart) return 15;
  const days = daysBetweenKeys(rampStart, localDateKey(today));
  if (days < 7) return 15;
  if (days < 14) return 25;
  return 40;
}

// Start of the local day / week (Monday) as UTC instants, for counting.
export function startOfLocalDay(date: Date): Date {
  const p = zonedParts(date);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0);
}

export function startOfLocalWeek(date: Date): Date {
  const p = zonedParts(date);
  const back = (p.weekday + 6) % 7;
  const key = addDaysKey(dateKey(p.year, p.month, p.day), -back);
  const [y, m, d] = key.split("-").map(Number);
  return zonedTimeToUtc(y, m, d, 0, 0);
}

export function formatLocal(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(d);
}

export function randomBetween(min: number, max: number, rand: () => number = Math.random): number {
  return min + rand() * (max - min);
}
