-- ============================================================
-- Restore image / AI-video provider flags so generation works
-- ============================================================
-- Pre-existing positive-semantic flags (image_provider_*,
-- ai_video_generation, etc.) ended up enabled=false. With every
-- image provider off, every cinematic_image job fails with
-- 'gpt-image-2, Gemini 3.1 Flash, and tertiary fallback all
-- exhausted'. Restore them so the worker has at least one provider
-- per role.
--
-- Flag semantics here are POSITIVE: enabled=true means provider ON.
-- (My new kill switches use the pause_* prefix — see migration
-- 20260508240000.)

BEGIN;

-- Image generation primary providers — at least one must be ON.
-- gpt-image-2 is the configured primary; Gemini Flash is the
-- secondary; Replicate is the fallback. Enable all three so the
-- chain has every link available again.
UPDATE public.feature_flags
   SET enabled = true,
       updated_by = 'restore-providers-2026-05-08',
       updated_at = NOW()
 WHERE flag_name IN (
   'image_generation',
   'image_provider_gpt_image2',
   'image_provider_gemini',
   'image_provider_hypereal',
   'image_provider_replicate'
 )
   AND enabled = false;

-- AI video generation (per-scene, controls EXPORT_AI_VIDEO env override).
UPDATE public.feature_flags
   SET enabled = true,
       updated_by = 'restore-providers-2026-05-08',
       updated_at = NOW()
 WHERE flag_name = 'ai_video_generation'
   AND enabled = false;

-- TTS / voice — leave alone. Strict-routing audioRouter (commit
-- b625501) already pins providers per language; admin can tune
-- tts_provider_* + voice_cloning toggles separately if they want.

COMMIT;
