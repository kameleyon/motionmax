/**
 * Shared helpers for the Autopost lab pages.
 *
 * All four user-facing pages (Connect, SchedulesList, ScheduleWizard,
 * ScheduleEdit) share the same handful of cron / time / icon helpers.
 * Centralising them keeps the page files focused on layout + state.
 *
 * Cron expressions follow the standard 5-field POSIX form:
 *   minute hour day-of-month month day-of-week
 *
 * `humanizeCron` recognises a small handful of idiomatic patterns we
 * surface as preset chips in the wizard; anything else falls back to
 * `Custom: <raw>` so users still see something meaningful in the
 * schedule list. `nextFireFromCron` is intentionally a *preview-only*
 * implementation — the worker uses the `autopost_advance_next_fire`
 * RPC as the source of truth.
 */

import type { JSX } from "react";
import { Instagram, Youtube } from "lucide-react";
import { createElement } from "react";

/* ────────────────────────────────────────────────────────────── */
/* Cron parsing + humanisation                                    */
/* ────────────────────────────────────────────────────────────── */

const CRON_FIVE_FIELDS = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

export interface ParsedCron {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

export function parseCron(cron: string): ParsedCron | null {
  const m = cron.match(CRON_FIVE_FIELDS);
  if (!m) return null;
  return { minute: m[1], hour: m[2], dom: m[3], month: m[4], dow: m[5] };
}

export function validateCron(cron: string): { valid: boolean; error?: string } {
  if (!cron || !cron.trim()) return { valid: false, error: "Cron expression required" };
  const parsed = parseCron(cron);
  if (!parsed) return { valid: false, error: "Cron must have exactly 5 fields" };
  // Lightweight per-field check — accepts numbers, *, ranges, lists, steps.
  const fieldRe = /^(\*|(\d+|\*)(\/\d+)?|(\d+(-\d+)?)(,\d+(-\d+)?)*)$/;
  for (const [name, value] of [
    ["minute", parsed.minute],
    ["hour", parsed.hour],
    ["dom", parsed.dom],
    ["month", parsed.month],
    ["dow", parsed.dow],
  ] as const) {
    if (!fieldRe.test(value)) {
      return { valid: false, error: `Invalid ${name} field: "${value}"` };
    }
  }
  return { valid: true };
}

/**
 * Maps a 24-hour clock value to a friendly "9:00 AM" style label.
 * Accepts `H` strings like "0", "9", "23"; multi-value cron hours like
 * "9,12" pass through unchanged so the humaniser falls back to Custom.
 */
function formatClockHour(hour: string, minute: string): string | null {
  if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return null;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

const TZ_ABBR: Record<string, string> = {
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Los_Angeles": "PT",
  "Europe/London": "BST/GMT",
  "Europe/Paris": "CET",
  UTC: "UTC",
};

export function humanizeCron(cron: string, tz?: string): string {
  const parsed = parseCron(cron);
  if (!parsed) return `Custom: ${cron}`;
  const { minute, hour, dom, month, dow } = parsed;

  const tzLabel = tz ? TZ_ABBR[tz] ?? tz : "";
  const clock = formatClockHour(hour, minute);
  const at = clock ? ` at ${clock}${tzLabel ? ` ${tzLabel}` : ""}` : "";

  // Daily: 0 9 * * *
  if (dom === "*" && month === "*" && dow === "*") return `Daily${at}`;
  // Weekdays: * * * * 1-5 or 1,2,3,4,5
  if (dom === "*" && month === "*" && (dow === "1-5" || dow === "1,2,3,4,5")) {
    return `Weekdays${at}`;
  }
  // Weekends: * * * * 0,6 or 6,0
  if (dom === "*" && month === "*" && (dow === "0,6" || dow === "6,0" || dow === "0,6")) {
    return `Weekends${at}`;
  }
  // M/W/F: 1,3,5
  if (dom === "*" && month === "*" && dow === "1,3,5") return `Mon/Wed/Fri${at}`;
  // T/Th: 2,4
  if (dom === "*" && month === "*" && dow === "2,4") return `Tue/Thu${at}`;
  // Single day-of-week
  if (dom === "*" && month === "*" && /^\d$/.test(dow)) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[parseInt(dow, 10)]}${at}`;
  }
  return `Custom: ${cron}`;
}

/* ────────────────────────────────────────────────────────────── */
/* Cron next-fire computation (preview-only)                      */
/* ────────────────────────────────────────────────────────────── */

interface FieldMatch {
  matches: (n: number) => boolean;
}

function compileField(value: string, min: number, max: number): FieldMatch {
  if (value === "*") return { matches: (n) => n >= min && n <= max };
  // Step: */N or A/N
  const step = value.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
  if (step) {
    const stepN = parseInt(step[2], 10);
    if (step[1] === "*") return { matches: (n) => (n - min) % stepN === 0 };
    const r = step[1].split("-").map((s) => parseInt(s, 10));
    const lo = r[0], hi = r[1] ?? max;
    return { matches: (n) => n >= lo && n <= hi && (n - lo) % stepN === 0 };
  }
  // Comma list with optional ranges
  const allowed = new Set<number>();
  for (const part of value.split(",")) {
    const r = part.split("-").map((s) => parseInt(s, 10));
    if (r.length === 1 && !Number.isNaN(r[0])) allowed.add(r[0]);
    else if (r.length === 2 && !r.some(Number.isNaN)) {
      for (let i = r[0]; i <= r[1]; i++) allowed.add(i);
    }
  }
  return { matches: (n) => allowed.has(n) };
}

/**
 * Find the next time after `after` that satisfies `cron`. Returns null
 * if no fire time within the next 366 days (catches typos like
 * `0 0 30 2 *` which can never fire).
 *
 * Note: timezone is honored only loosely — we compute in UTC and let
 * the caller format. For the wizard preview that's good enough; the
 * worker uses pg's `next fire` RPC as ground truth.
 */
export function nextFireFromCron(cron: string, _tz: string, after: Date): Date | null {
  const parsed = parseCron(cron);
  if (!parsed) return null;
  const minute = compileField(parsed.minute, 0, 59);
  const hour = compileField(parsed.hour, 0, 23);
  const dom = compileField(parsed.dom, 1, 31);
  const month = compileField(parsed.month, 1, 12);
  const dow = compileField(parsed.dow, 0, 6);

  // Cron semantic: if both DOM and DOW are restricted, match either.
  const domRestricted = parsed.dom !== "*";
  const dowRestricted = parsed.dow !== "*";

  const cursor = new Date(after.getTime() + 60_000); // start at next minute
  cursor.setSeconds(0, 0);
  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (cursor < limit) {
    const m = cursor.getUTCMinutes();
    const h = cursor.getUTCHours();
    const d = cursor.getUTCDate();
    const mo = cursor.getUTCMonth() + 1;
    const w = cursor.getUTCDay();

    const dayOk =
      domRestricted && dowRestricted
        ? dom.matches(d) || dow.matches(w)
        : dom.matches(d) && dow.matches(w);

    if (minute.matches(m) && hour.matches(h) && month.matches(mo) && dayOk) {
      return new Date(cursor);
    }
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

export function nextNFiresFromCron(
  cron: string,
  tz: string,
  count: number,
  after: Date = new Date(),
): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextFireFromCron(cron, tz, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/* ────────────────────────────────────────────────────────────── */
/* Relative time formatter                                         */
/* ────────────────────────────────────────────────────────────── */

const REL_UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

export function formatRelativeTime(input: Date | string | null | undefined): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "—";
  const diffSec = (d.getTime() - Date.now()) / 1000;
  if (Math.abs(diffSec) < 30) return "Just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let value = diffSec;
  for (const [div, unit] of REL_UNITS) {
    if (Math.abs(value) < div) return rtf.format(Math.round(value), unit);
    value /= div;
  }
  return rtf.format(Math.round(value), "year");
}

/* ────────────────────────────────────────────────────────────── */
/* Platform icons                                                  */
/* ────────────────────────────────────────────────────────────── */

export type AutopostPlatform = "youtube" | "instagram" | "tiktok";

/**
 * Lucide doesn't ship a TikTok glyph, so we render a small inline SVG.
 * Sized via `className` props (h-4 w-4 etc.) just like Lucide icons.
 */
export function TikTokIcon({ className }: { className?: string }): JSX.Element {
  return createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      className,
    },
    createElement("path", {
      d: "M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.27a8.16 8.16 0 0 0 4.77 1.52V6.34a4.85 4.85 0 0 1-1.84.35z",
    }),
  );
}

export function platformIcon(platform: AutopostPlatform, className = "h-4 w-4"): JSX.Element {
  switch (platform) {
    case "youtube":
      return createElement(Youtube, { className });
    case "instagram":
      return createElement(Instagram, { className });
    case "tiktok":
      return createElement(TikTokIcon, { className });
  }
}

export const PLATFORM_LABEL: Record<AutopostPlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/* Caption length limits used by the wizard's per-platform editors.
 * YouTube allows 5,000 in description; IG/TikTok caption ≈ 2,200. */
export const CAPTION_LIMITS: Record<AutopostPlatform, number> = {
  youtube: 5000,
  instagram: 2200,
  tiktok: 2200,
};

/* ────────────────────────────────────────────────────────────── */
/* Static option lists                                             */
/* ────────────────────────────────────────────────────────────── */

export const MOTION_PRESETS = [
  { value: "random", label: "Random from curated set" },
  { value: "still", label: "Still" },
  { value: "push-in", label: "Push-in" },
  { value: "pan-left", label: "Pan left" },
  { value: "pan-right", label: "Pan right" },
  { value: "dolly", label: "Dolly" },
  { value: "orbit", label: "Orbit" },
  { value: "tilt-up", label: "Tilt up" },
  { value: "tilt-down", label: "Tilt down" },
  { value: "handheld", label: "Handheld" },
] as const;

export const TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Arizona (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "America/Toronto", label: "Toronto" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Madrid", label: "Madrid" },
  { value: "Europe/Athens", label: "Athens" },
  { value: "Africa/Johannesburg", label: "Johannesburg" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "Kolkata" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "UTC", label: "UTC" },
];

/** Cadence preset chips → seed cron expression. The hour/minute is
 * later overwritten by the time-of-day Select. */
export const CADENCE_PRESETS = [
  { id: "daily", label: "Daily", cron: "0 9 * * *" },
  { id: "mwf", label: "Mon/Wed/Fri", cron: "0 9 * * 1,3,5" },
  { id: "weekdays", label: "Weekdays", cron: "0 9 * * 1-5" },
  { id: "weekends", label: "Weekends", cron: "0 9 * * 0,6" },
  { id: "custom", label: "Custom", cron: "" },
] as const;

/** Apply a "HH:MM" time string to the minute+hour fields of a cron. */
export function withTimeOfDay(cron: string, hhmm: string): string {
  const parsed = parseCron(cron);
  if (!parsed) return cron;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return cron;
  return `${parseInt(m[2], 10)} ${parseInt(m[1], 10)} ${parsed.dom} ${parsed.month} ${parsed.dow}`;
}

/** Build the list of "00:00, 00:30, … 23:30" slots used by the
 * time-of-day Select in step 2. */
export function timeOfDayOptions(): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const value = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
      const label = formatClockHour(String(h), String(m).padStart(2, "0")) ?? value;
      out.push({ value, label });
    }
  }
  return out;
}
