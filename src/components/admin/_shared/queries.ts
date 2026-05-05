/**
 * React Query conventions for the admin surface.
 *
 * Convention: every admin query key is an array prefixed with
 * `['admin', '<tab>', ...rest]`. This lets us invalidate/select an entire
 * tab in one shot (e.g. `queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })`)
 * and keeps existing legacy keys (`["admin-dashboard-stats"]`) discoverable
 * via the same first-element prefix during the migration.
 *
 * Migration note: Phase 0.4 only **introduces** this layer. The existing
 * string-style keys in `AdminOverview.tsx` etc. are migrated to
 * `adminKey('overview', ...)` form in Phase 1+ — do NOT rewrite call sites
 * here.
 *
 * Per-tab override note: tabs that need realtime semantics (Console:
 * `staleTime: 0`) override `ADMIN_DEFAULT_QUERY_OPTIONS` locally rather than
 * mutating the export.
 */

export const ADMIN_QUERY_PREFIX = "admin" as const;

/**
 * Closed set of admin tab identifiers. Mirrors the route-tab union in
 * `Admin.tsx` (Phase 1.1) so query keys and `?tab=` query-string values
 * can never drift.
 */
export type AdminTabKey =
  | "overview"
  | "analytics"
  | "activity"
  | "api"
  | "apikeys"
  | "users"
  | "gens"
  | "perf"
  | "errors"
  | "console"
  | "messages"
  | "notifs"
  | "news"
  | "announce"
  | "kill";

/**
 * Build a stable React Query key for an admin tab.
 *
 * `null` and `undefined` segments are preserved (NOT filtered) so query keys
 * stay stable across `userId === undefined` -> `userId === 'abc'` transitions
 * — React Query treats those as different queries by design.
 *
 * @example
 *   adminKey('overview', 'snapshot')
 *   // -> ['admin', 'overview', 'snapshot']
 *
 *   adminKey('users', userId, page)
 *   // -> ['admin', 'users', 'u_123', 2]
 */
export function adminKey(
  tab: AdminTabKey,
  ...rest: ReadonlyArray<string | number | undefined | null>
): readonly unknown[] {
  return [ADMIN_QUERY_PREFIX, tab, ...rest] as const;
}

/**
 * Default React Query options for admin queries.
 *
 * - `staleTime: 30_000` — admin views feel fresh but we don't hammer the API
 *   when an admin tabs around quickly.
 * - `gcTime: 5 * 60_000` — keep cached results around for 5 min so going
 *   back to a tab is instant.
 * - `refetchOnWindowFocus: false` — avoid surprise reloads when an admin
 *   alt-tabs to look at logs in another window.
 *
 * Override per tab where needed (Console: `staleTime: 0`).
 */
export const ADMIN_DEFAULT_QUERY_OPTIONS = {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;
