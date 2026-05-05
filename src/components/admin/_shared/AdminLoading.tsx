import { AdminLoadingState } from "@/components/ui/admin-loading-state";

/**
 * Re-export of the existing app-wide `AdminLoadingState` skeleton, surfaced
 * inside the admin `_shared` namespace under the canonical `AdminLoading`
 * name so per-tab code can `import { AdminLoading } from './_shared/AdminLoading'`.
 *
 * Do NOT add a wrapper component — the goal is a single source of truth for
 * the skeleton layout. If admin needs a different shape, fork at the call
 * site rather than diverging here.
 */
export { AdminLoadingState as AdminLoading };
