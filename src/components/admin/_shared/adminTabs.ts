/**
 * Admin tab metadata — sole source of truth for the 15-tab strip.
 *
 * Used by:
 * - `AdminTabStrip` (Phase 1.3) to render the icon row.
 * - `Admin.tsx` route shell (Phase 1.1) to validate `?tab=` query param.
 * - The dashboard `Sidebar.tsx` admin sub-list (Phase 1.2) for label/order parity.
 *
 * Definitions mirror `tmp_design/motionmax/project/upgrades/admin.jsx` `tabs[]`
 * and the design inventory § 0.13. Badge/dot/segment-separator metadata is
 * static here; live counts (errors=14, messages=2, notifs=3, etc.) override
 * the static values via per-tab live queries — see Phase 5/11/13/14/16.
 */

import type { AdminTabKey } from "./queries";
import type { AdminIconName } from "./AdminIcons";

/**
 * Closed tuple of admin tab keys in display order. Matches the union in
 * `queries.ts`; if you add a key, update both files together.
 */
export const TAB_KEYS: readonly AdminTabKey[] = [
  "overview",
  "analytics",
  "activity",
  "api",
  "apikeys",
  "users",
  "gens",
  "perf",
  "errors",
  "console",
  "messages",
  "notifs",
  "news",
  "announce",
  "kill",
] as const;

/**
 * One row in the tab strip.
 *
 * - `badge` is the static fallback count rendered as a `.pill` next to the icon.
 *   Live wiring (Phase 5/11/…) overlays the real count via React Query.
 * - `dot: 'live'` renders the pulsing aqua activity indicator (top-right of tab).
 * - `segSepBefore: true` renders the `.seg-sep` divider immediately before the
 *   tab — visual grouping ops/data | dev | comms | kill.
 */
export interface TabDefinition {
  key: AdminTabKey;
  label: string;
  icon: AdminIconName;
  badge?: { value: string | number; tone: "cyan" | "danger" };
  dot?: "live";
  segSepBefore?: boolean;
}

export const TAB_DEFINITIONS: readonly TabDefinition[] = [
  { key: "overview", label: "Overview", icon: "home" },
  { key: "analytics", label: "Analytics", icon: "chart" },
  { key: "activity", label: "Activity", icon: "bolt", dot: "live" },
  { key: "api", label: "API & Costs", icon: "api" },
  { key: "apikeys", label: "API Keys", icon: "key", badge: { value: 6, tone: "cyan" } },
  { key: "users", label: "Users", icon: "users" },
  { key: "gens", label: "Generations", icon: "spark" },
  { key: "perf", label: "Performance", icon: "chart" },
  {
    key: "errors",
    label: "Errors",
    icon: "alert",
    badge: { value: 14, tone: "danger" },
    segSepBefore: true,
  },
  { key: "console", label: "Console", icon: "terminal" },
  { key: "messages", label: "Messages", icon: "mail", badge: { value: 2, tone: "danger" } },
  { key: "notifs", label: "Notifications", icon: "bell", badge: { value: 3, tone: "danger" } },
  { key: "news", label: "Newsletter", icon: "send", segSepBefore: true },
  { key: "announce", label: "Announcements", icon: "bell", badge: { value: 2, tone: "cyan" } },
  { key: "kill", label: "Kill switches", icon: "power" },
] as const;

/**
 * O(1) membership check against `TAB_KEYS`. Built once at module load —
 * the array itself is read-only so the Set never goes stale.
 */
const TAB_KEY_SET: ReadonlySet<AdminTabKey> = new Set<AdminTabKey>(TAB_KEYS);

/**
 * Validate a `?tab=` value; returns `'overview'` if missing or unknown.
 *
 * Accepts `null`/`undefined` directly so callers can pipe
 * `useSearchParams().get('tab')` in without a null-guard.
 */
export function parseTabKey(raw: string | null | undefined): AdminTabKey {
  if (!raw) return "overview";
  return TAB_KEY_SET.has(raw as AdminTabKey) ? (raw as AdminTabKey) : "overview";
}
