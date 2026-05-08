# Adding a New Kill Switch — Deploy Runbook

Use this when you want to add a new feature flag that the admin can toggle on/off (e.g. a new provider integration that you want to be able to pause without redeploying).

## Steps

1. **Pick a flag name.** Lowercase, snake_case, kill-switch semantics (`enabled=true` means feature BLOCKED). Examples: `ai_video_generation`, `payments`, `signups_disabled`.
2. **Seed the row in a migration:**
   ```sql
   INSERT INTO public.feature_flags (flag_name, enabled, description, rollout_pct, audience)
   VALUES ('my_new_flag', false, 'Pause my new feature.', 100, '{"all": true}'::jsonb)
   ON CONFLICT (flag_name) DO NOTHING;
   ```
3. **Add the kill-switch check in the worker handler / edge fn:**
   ```ts
   // worker side
   import { isKillSwitchArmed } from "../lib/featureFlags.js";
   if (await isKillSwitchArmed("my_new_flag")) {
     throw new Error("Feature paused by admin (kill switch: my_new_flag).");
   }
   ```
   ```ts
   // edge fn side — query feature_flags directly via service-role
   const { data: flagRow } = await supabaseClient
     .from("feature_flags").select("enabled").eq("flag_name", "my_new_flag").maybeSingle();
   if ((flagRow as { enabled?: boolean } | null)?.enabled === true) {
     return new Response(JSON.stringify({ error: "Feature paused by an administrator." }),
       { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" }});
   }
   ```
4. **Add the subsystem card to TabKillSwitches.tsx** if you want it to appear above the flags table (otherwise it auto-shows in the table once seeded). Edit the `SUBSYSTEMS` array.

## Things to know

- Worker caches feature flags for 60 s (see `worker/src/lib/featureFlags.ts`). Test toggles take up to a minute to propagate. Speed it up via `invalidateFeatureFlags()` or by setting the env var override `FLAG_<UPPER_SNAKE_NAME>=true|false`.
- Edge functions have no cache — they re-query on every request, so toggles are immediate but cost a DB round-trip per call. For high-traffic edge fns, mirror the value to a global var with a 30 s TTL.
- The toggle UI uses RPC `admin_set_feature_flag(p_flag, p_enabled, p_reason)` which audit-logs to `admin_logs.action='feature_flag.set'`.
