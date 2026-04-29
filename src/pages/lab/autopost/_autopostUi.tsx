/**
 * Shared UI helpers for the Autopost lab pages (home dashboard, run
 * history, run detail). Kept colocated so the only consumers are
 * inside `src/pages/lab/autopost/`.
 *
 * - Status pill + per-platform pill with brand-token colors.
 * - Relative-time formatter with sane fallbacks for clock skew.
 * - Platform icons (lucide).
 * - Group-by-day labelling for the history list.
 */

import { Youtube, Instagram, Music2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Statuses that mean "still doing work" — the dashboard surfaces them
 * with an animated spinner so users don't think the page is frozen
 * while the worker chews through script + audio + visuals + render.
 */
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "generating",
  "publishing",
]);

export function isRunStatusActive(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export const AUTOPOST_BRAND = {
  bg: "#0A0D0F",
  surface: "#10151A",
  border: "rgba(255,255,255,0.08)",
  fg: "#ECEAE4",
  fgMuted: "#8A9198",
  fgFaint: "#5A6268",
  aqua: "#11C4D0",
  gold: "#E4C875",
} as const;

export type RunStatus =
  | "queued"
  | "generating"
  | "rendered"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled";

export type PublishStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "published"
  | "failed"
  | "rejected";

export type Platform = "youtube" | "instagram" | "tiktok";

/** Returns a "X ago" / "in X" string. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = d.getTime() - now.getTime();
  const sign = diffMs < 0 ? -1 : 1;
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  let core: string;
  if (abs < 45_000) core = "just now";
  else if (mins < 60) core = `${mins}m`;
  else if (hours < 24) core = `${hours}h`;
  else if (days < 30) core = `${days}d`;
  else core = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (core === "just now") return core;
  return sign < 0 ? `${core} ago` : `in ${core}`;
}

/** "Today" / "Yesterday" / "Apr 26, 2026" — used to bucket the history list. */
export function dayBucketLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const startOfDay = (x: Date) => {
    const c = new Date(x);
    c.setHours(0, 0, 0, 0);
    return c;
  };
  const a = startOfDay(d).getTime();
  const b = startOfDay(now).getTime();
  const dayDiff = Math.round((b - a) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Returns the bucket key (YYYY-MM-DD UTC) for grouping. Stable across timezones. */
export function dayBucketKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

interface PillTone {
  text: string;
  bg: string;
  border: string;
}

const RUN_STATUS_TONE: Record<RunStatus, PillTone> = {
  queued:     { text: "#8A9198", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.1)" },
  generating: { text: "#11C4D0", bg: "rgba(17,196,208,0.1)",   border: "rgba(17,196,208,0.3)" },
  rendered:   { text: "#11C4D0", bg: "rgba(17,196,208,0.1)",   border: "rgba(17,196,208,0.3)" },
  publishing: { text: "#E4C875", bg: "rgba(228,200,117,0.1)",  border: "rgba(228,200,117,0.3)" },
  completed:  { text: "#7BD389", bg: "rgba(123,211,137,0.1)",  border: "rgba(123,211,137,0.3)" },
  failed:     { text: "#F47272", bg: "rgba(244,114,114,0.1)",  border: "rgba(244,114,114,0.3)" },
  cancelled:  { text: "#8A9198", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.1)" },
};

const PUBLISH_STATUS_TONE: Record<PublishStatus, PillTone> = {
  pending:    { text: "#8A9198", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.12)" },
  uploading:  { text: "#E4C875", bg: "rgba(228,200,117,0.1)",  border: "rgba(228,200,117,0.3)" },
  processing: { text: "#E4C875", bg: "rgba(228,200,117,0.1)",  border: "rgba(228,200,117,0.3)" },
  published:  { text: "#7BD389", bg: "rgba(123,211,137,0.1)",  border: "rgba(123,211,137,0.3)" },
  failed:     { text: "#F47272", bg: "rgba(244,114,114,0.1)",  border: "rgba(244,114,114,0.3)" },
  rejected:   { text: "#F47272", bg: "rgba(244,114,114,0.1)",  border: "rgba(244,114,114,0.3)" },
};

export function StatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone =
    RUN_STATUS_TONE[status as RunStatus] ??
    { text: "#8A9198", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.1)" };
  const active = isRunStatusActive(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        className,
      )}
      style={{ color: tone.text, backgroundColor: tone.bg, borderColor: tone.border }}
    >
      {active && <Loader2 className="h-3.5 w-3.5 autopost-spin" aria-hidden="true" />}
      {status}
    </span>
  );
}

/**
 * Progress bar shown under any run row that is still in flight.
 *
 * Two modes, picked by the `value` prop:
 *   - number 0..100  → determinate. Aqua bar fills proportionally with
 *                      a small "X%" label on the right.
 *   - null/undefined → indeterminate. Translucent slice slides across
 *                      the track via the .animate-shimmer keyframe.
 *
 * The autopost worker pushes coarse waypoints to autopost_runs.progress
 * _pct (5 / 25 / 35 / 80 / 100). Old rows or freshly queued ones have
 * null and fall back to the shimmer.
 */
export function RunProgressBar({
  value,
  className,
}: {
  value?: number | null;
  className?: string;
}) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const pct = determinate ? Math.max(0, Math.min(100, Math.round(value!))) : 0;
  return (
    <div
      className={cn("flex items-center gap-2", className)}
      role="progressbar"
      aria-busy="true"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? pct : undefined}
      aria-label="Generation in progress"
    >
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        {determinate ? (
          <div
            className="h-full rounded-full transition-[width] duration-700 ease-out"
            style={{
              width: `${pct}%`,
              background: "linear-gradient(90deg, #11C4D0, #5BE3EE)",
            }}
          />
        ) : (
          <div
            className="h-full w-1/3 animate-shimmer rounded-full"
            style={{
              background: "linear-gradient(90deg, transparent, #11C4D0, transparent)",
            }}
          />
        )}
      </div>
      {determinate && (
        <span className="text-[10px] font-mono text-[#8A9198] tabular-nums shrink-0 w-9 text-right">
          {pct}%
        </span>
      )}
    </div>
  );
}

export function PublishStatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone =
    PUBLISH_STATUS_TONE[status as PublishStatus] ??
    { text: "#8A9198", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.1)" };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
      style={{ color: tone.text, backgroundColor: tone.bg, borderColor: tone.border }}
    >
      {status}
    </span>
  );
}

/** Compact icon-only pill: square swatch with the platform glyph,
 *  colored to publish status. Used in the run-history dense rows. */
export function PlatformPill({
  platform,
  status,
  className,
}: {
  platform: string;
  status: string;
  className?: string;
}) {
  const tone =
    PUBLISH_STATUS_TONE[status as PublishStatus] ??
    { text: "#8A9198", bg: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.1)" };
  const Icon = platformIcon(platform);
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px]",
        className,
      )}
      style={{ color: tone.text, backgroundColor: tone.bg, borderColor: tone.border }}
      title={`${platform}: ${status}`}
    >
      <Icon className="h-3 w-3" />
      <span className="hidden sm:inline">{shortStatus(status)}</span>
    </span>
  );
}

function shortStatus(status: string): string {
  switch (status) {
    case "published": return "live";
    case "uploading":
    case "processing": return "publishing";
    case "rejected": return "rejected";
    case "failed": return "failed";
    default: return status;
  }
}

export function platformIcon(platform: string) {
  if (platform === "youtube") return Youtube;
  if (platform === "instagram") return Instagram;
  return Music2; // TikTok — lucide doesn't ship a TikTok glyph
}

export function platformLabel(platform: string): string {
  if (platform === "youtube") return "YouTube";
  if (platform === "instagram") return "Instagram";
  if (platform === "tiktok") return "TikTok";
  return platform;
}
