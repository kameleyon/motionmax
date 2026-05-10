/**
 * profile-queries — helpers for reading from the `profiles` table while
 * respecting the soft-delete contract.
 *
 * Soft-delete contract:
 *   `profiles.deleted_at` is the canonical signal that an account has been
 *   soft-deleted (typically via the deletion_requests grace-period flow,
 *   or by an admin marking the row inactive). Once `deleted_at IS NOT NULL`,
 *   the user must NOT appear in any user-facing surface — header avatar,
 *   sidebar, dashboard, project lists, etc. The row stays for audit /
 *   billing reconciliation until the canonical pg_cron pipeline finally
 *   purges the auth.users row.
 *
 * Why this helper exists:
 *   Direct `supabase.from("profiles")` reads scattered across user-facing
 *   components historically forgot to add `.is("deleted_at", null)`. This
 *   wrapper centralizes the filter so every user-facing read inherits it
 *   for free, and makes the intent (and the GDPR alignment) obvious at
 *   the call site.
 *
 * Scope:
 *   This is intentionally NOT used in admin views (admin/* tabs,
 *   adminDirectQueries.ts) — admins must be able to see soft-deleted
 *   accounts to triage support tickets, audit billing, and (where
 *   appropriate) reverse a soft-delete before the grace period ends.
 *   Settings.tsx and useAuth.ts also keep direct access because they
 *   read/write the current user's own row regardless of soft-delete
 *   state (the user can still modify their settings during the 7-day
 *   grace period — that's how they cancel the deletion).
 *
 *   Migrated user-facing surfaces:
 *     • src/components/dashboard/Hero.tsx           — display_name greeting
 *     • src/components/dashboard/Sidebar.tsx        — display_name + avatar_url
 *     • src/components/editor/MiniSidebar.tsx       — display_name + avatar_url
 *     • src/components/layout/AppSidebar.tsx        — display_name in chrome
 */

import { supabase } from "@/integrations/supabase/client";

/**
 * Build a SELECT query against `profiles` that filters out soft-deleted
 * rows (`deleted_at IS NULL`). Compose your `.eq()`, `.maybeSingle()`,
 * etc. on the returned builder as you would with `supabase.from()`.
 *
 * Example:
 *   const { data } = await selectActiveProfile("display_name, avatar_url")
 *     .eq("user_id", user.id)
 *     .maybeSingle();
 */
export function selectActiveProfile(columns: string = "*") {
  return supabase
    .from("profiles")
    .select(columns)
    .is("deleted_at", null);
}
