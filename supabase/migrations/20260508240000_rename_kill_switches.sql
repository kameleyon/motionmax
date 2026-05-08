-- ============================================================
-- EMERGENCY: rename kill-switches to pause_* to avoid collision
-- ============================================================
-- The 8 kill switches I added in 20260508210000 reused flag names
-- that already existed with POSITIVE semantics ("enabled=true means
-- feature ON"). My new code uses KILL-SWITCH semantics ("enabled=true
-- means feature BLOCKED"). Same flag name, opposite meaning →
-- 2026-05-08 incident where every cinematic_image job failed and
-- the emergency-disarm migration accidentally flipped the legacy
-- positive 'image_generation' flag to false (which would have
-- disabled image gen if anything still read it positively).
--
-- Fix: rename my 8 kill switches with a `pause_` prefix so the
-- semantic is unambiguous in both the table and the code:
--   image_generation  → pause_image
--   video_generation  → pause_video
--   voice_generation  → pause_voice
--   payments          → pause_payments
--   autopost          → pause_autopost
--   newsletter        → pause_newsletter
--   signups_disabled  → pause_signups
--   maint             → maintenance_mode
--
-- Worker / edge-fn code is updated in companion commits to read
-- the new names. Old rows are deleted (the legacy positive flags
-- where they exist must NOT be touched — they belong to the older
-- providers system). For names that didn't pre-exist, the rename
-- is a clean swap.

BEGIN;

-- 1. Insert the new pause_* / maintenance_mode rows (idempotent).
INSERT INTO public.feature_flags (flag_name, enabled, description, rollout_pct, audience, updated_by)
VALUES
  ('maintenance_mode',  false, 'Site maintenance mode — all non-admin routes return 503.',     100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_signups',     false, 'Block new auth.users INSERTs (existing users unaffected).',     100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_image',       false, 'Pause cinematic image generation handler entry.',               100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_video',       false, 'Pause cinematic video generation (Hypereal Seedance/Kling).',   100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_voice',       false, 'Pause voice/TTS generation across all providers.',              100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_payments',    false, 'Block Stripe checkout sessions (existing subscriptions OK).',   100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_autopost',    false, 'Pause autopost render dispatch (existing runs continue).',      100, '{"all": true}'::jsonb, 'rename-2026-05-08'),
  ('pause_newsletter',  false, 'Pause outbound newsletter sender (drafts + scheduled OK).',     100, '{"all": true}'::jsonb, 'rename-2026-05-08')
ON CONFLICT (flag_name) DO NOTHING;

-- 2. Restore legacy positive flags that the bad disarm migration
--    flipped to false. We only restore them if the description text
--    suggests positive semantics ('Enable …') — preserves any
--    intentional admin-side disable.
UPDATE public.feature_flags
   SET enabled = true,
       updated_by = 'rename-restore-2026-05-08',
       updated_at = NOW()
 WHERE flag_name = 'image_generation'
   AND enabled = false
   AND COALESCE(description, '') ILIKE '%enable%';

UPDATE public.feature_flags
   SET enabled = true,
       updated_by = 'rename-restore-2026-05-08',
       updated_at = NOW()
 WHERE flag_name = 'voice_generation'
   AND enabled = false
   AND COALESCE(description, '') ILIKE '%enable%';

UPDATE public.feature_flags
   SET enabled = true,
       updated_by = 'rename-restore-2026-05-08',
       updated_at = NOW()
 WHERE flag_name = 'video_generation'
   AND enabled = false
   AND COALESCE(description, '') ILIKE '%enable%';

-- 3. Delete the kill-switch flags that DIDN'T pre-exist (only ones
--    seeded by the 20260508210000 migration with kill-switch
--    descriptions). Compare the description to the seed text.
DELETE FROM public.feature_flags
 WHERE flag_name IN ('autopost', 'newsletter', 'payments', 'signups_disabled', 'maint')
   AND COALESCE(description, '') ILIKE '%pause%' OR COALESCE(description, '') ILIKE '%block%';
-- Note: image_generation / video_generation / voice_generation are
-- INTENTIONALLY left in place if they pre-existed with positive
-- semantics. The new code reads pause_* names and ignores them.

-- 4. Update the signups_kill_switch_check() trigger to read the
--    new flag name. CREATE OR REPLACE rebinds the existing trigger
--    automatically (the trigger references the function by name).
CREATE OR REPLACE FUNCTION public.signups_kill_switch_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_armed boolean;
BEGIN
  SELECT enabled INTO v_armed
    FROM public.feature_flags
   WHERE flag_name = 'pause_signups';
  IF COALESCE(v_armed, false) THEN
    RAISE EXCEPTION 'Sign-ups are temporarily disabled by an administrator. Please try again later.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$func$;

COMMIT;
