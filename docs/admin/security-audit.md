# Admin security audit — 2026-05-09

Findings from the Phase 18.5 / 19.5 verification pass on 2026-05-09. Each finding has a remediation block at the bottom; review and apply in order.

## Finding A — high-risk RPCs gate on `is_admin`, not `is_super_admin`

**Severity:** medium. Any account flagged `is_admin` can engage destructive / org-wide actions that the spec restricts to super-admins only.

**Affected RPCs:**

| Function | Action it can perform | Spec gate |
|---|---|---|
| `admin_set_master_kill_switch` | Engages master kill — pauses every worker, blocks every generation | super_admin |
| `admin_grant_credits` | Mints credits onto any user balance | super_admin (per spec on bulk paths) |
| `admin_set_feature_flag` | Flips any feature flag, including `pause_*` switches | super_admin |
| `admin_update_flag_metadata` | Edits flag descriptions / rollout / audience | super_admin |

**How verified:** ran `pg_get_functiondef(...)` on 2026-05-09; every gate is `IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION '<rpc>: forbidden' USING ERRCODE = '42501'; END IF;`. The `public.is_super_admin(uuid)` helper exists (it reads `user_roles.role = 'super_admin'`) but is not consulted.

**Why we didn't auto-patch in commit `06c1209`:** flipping the gate from `is_admin` to `is_super_admin` could lock out the lone admin if `user_roles` doesn't yet have a `super_admin` row for them. The remediation must run super-admin promotion *first*, then the gate-tightening.

### Remediation A.1 — promote existing admins to super_admin

Apply this first. Idempotent — re-applying does nothing:

```sql
-- Promote everyone who is currently is_admin=true to also have super_admin
-- in user_roles. This preserves access while we tighten the gates below.
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'super_admin'::app_role
  FROM auth.users u
  JOIN public.user_roles existing ON existing.user_id = u.id
 WHERE existing.role = 'admin'
ON CONFLICT (user_id, role) DO NOTHING;
```

After applying, verify: `SELECT user_id FROM public.user_roles WHERE role = 'super_admin';` returns the expected operator account(s).

### Remediation A.2 — tighten the four gates

Apply only after A.1 is verified. Each statement re-issues the function with the stricter gate.

```sql
-- admin_set_master_kill_switch: spec requires super_admin.
CREATE OR REPLACE FUNCTION public.admin_set_master_kill_switch(p_enabled boolean, p_message text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_super_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_set_master_kill_switch: super_admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.admin_rate_limit_check('master_kill', 5);  -- aggressive cap
  UPDATE public.app_settings
     SET value = jsonb_build_object('enabled', p_enabled, 'message', p_message, 'set_by', v_admin::text, 'set_at', NOW()),
         updated_at = NOW()
   WHERE key = 'master_kill_switch';
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'master_kill_switch_set', 'app_setting', NULL,
          jsonb_build_object('enabled', p_enabled, 'message', p_message,
                             'request_id', gen_random_uuid()));
  IF p_enabled THEN
    BEGIN PERFORM public.admin_cancel_all_active_jobs(true, 1, COALESCE('Master kill: ' || p_message, 'Master kill engaged')); EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  RETURN jsonb_build_object('enabled', p_enabled, 'message', p_message);
END;
$func$;

-- Apply the same is_super_admin pattern to:
--   admin_grant_credits (gate + rate limit + request_id)
--   admin_set_feature_flag (gate + rate limit + request_id)
--   admin_update_flag_metadata (gate + rate limit + request_id)
-- Lift each function's existing definition via pg_get_functiondef
-- and replace its is_admin check.
```

## Finding B — `admin_logs.details` rows lack `request_id`

**Severity:** low. Audit trail is still complete on a per-action basis; `request_id` is a nice-to-have for stitching together multi-step flows (e.g. "master kill engaged → 14 jobs cancelled" should share one ID).

**How verified:** `SELECT COUNT(*) FILTER (WHERE details ? 'request_id') FROM public.admin_logs` returned 0 of 58 rows.

**Remediation:** thread a `request_id := gen_random_uuid()` through every multi-step admin RPC. The example in remediation A.2 above shows the pattern: bind the UUID once at function entry, include it in the action's `admin_logs.details` AND in any side-effect RPC's `details`.

## Finding C — column-level documentation gaps

**Severity:** very low. Documentation only — no security or correctness impact.

**How verified:** spot-checked `pg_description` for the 13 admin tables. Most don't have per-column comments.

**Remediation:** generate a follow-up migration that runs `COMMENT ON COLUMN <table>.<col> IS '...'` for each column on each admin table. Templated comments are worse than nothing if they're vague — write per-column descriptions that explain meaning, units, and lifecycle, not just the type. Tractable as a multi-hour doc-pass session.

## Finding D — RPC-level documentation gaps

**Severity:** very low. Same as C but for `pg_proc`.

**How verified:** ~50 of the ~70 `admin_*` RPCs have `obj_description = NULL`.

**Remediation:** add `COMMENT ON FUNCTION` directives to each defining migration (or a single doc-pass migration). Templated comments based on naming conventions (`*_kpis`, `*_list`, `*_detail`) are tempting but should be avoided — they create false confidence the function is documented when really it isn't. Hand-written comments per function, please.

## What's not in this audit

The Phase 18.5 / 19.5 checklist also calls for:

- CSRF on POST routes via Supabase RPC + JWT (manual edge-function audit; not in scope here)
- CSV export endpoints reject unauthenticated curl (manual curl test)
- Synthetic Sentry error from an admin action (manual — fire one and verify in Sentry dashboard)
- Founder walkthrough + 24h soak (definitionally human-in-the-loop)

These are tracked in `ADMIN_REBUILD_CHECKLIST.md` under their `(manual)` notes.
