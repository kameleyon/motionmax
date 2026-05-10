-- ============================================================
-- C-8-7: per-provider cost columns on generation_costs
--
-- The original generation_costs schema (migration 20260201165235)
-- shipped four columns:
--   openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost
--
-- Half of the worker's TTS spend ended up rolled into the wrong
-- column because the provider catalog has grown to include Fish
-- Audio, ElevenLabs, LemonFox, Smallest, OpenAI, and the new
-- Gemini Flash TTS surface — none of which map cleanly to those
-- four buckets.
--
-- This migration:
--   1. Adds one column per provider currently emitting api_call_logs
--      rows so handleFinalize can attribute the right slice to the
--      right column.
--   2. Drops + rebuilds the `total_cost` generated column so it
--      sums every per-provider column, including the new ones.
--      Postgres doesn't let you ALTER a STORED GENERATED column,
--      so we drop and recreate.
--   3. Backfill is intentionally NOT done — historical rows stay
--      at zero in the new columns; dashboards that need historical
--      attribution should keep reading the legacy aggregate columns.
-- ============================================================

BEGIN;

-- 1. Add per-provider columns. All default 0 so existing inserts that
-- don't set these compile fine. NUMERIC(10,6) matches the legacy column
-- type so per-call sub-cent values aren't truncated.
ALTER TABLE public.generation_costs
  ADD COLUMN IF NOT EXISTS fish_audio_cost         NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS elevenlabs_cost         NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lemonfox_cost           NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS smallest_cost           NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_cost             NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gemini_flash_tts_cost   NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hypereal_asr_cost       NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hypereal_video_cost     NUMERIC(10,6) DEFAULT 0;

-- 2. Rebuild total_cost. We have to drop first because Postgres won't
-- let us ALTER a STORED GENERATED expression in place. Wrapping in a
-- DO block so the migration is idempotent (rerunning on a DB where
-- total_cost was already rebuilt by an earlier deploy is a no-op).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'generation_costs'
       AND column_name  = 'total_cost'
  ) THEN
    ALTER TABLE public.generation_costs DROP COLUMN total_cost;
  END IF;
END $$;

ALTER TABLE public.generation_costs
  ADD COLUMN total_cost NUMERIC(10,6)
    GENERATED ALWAYS AS (
      COALESCE(openrouter_cost, 0)
      + COALESCE(replicate_cost, 0)
      + COALESCE(hypereal_cost, 0)
      + COALESCE(google_tts_cost, 0)
      + COALESCE(fish_audio_cost, 0)
      + COALESCE(elevenlabs_cost, 0)
      + COALESCE(lemonfox_cost, 0)
      + COALESCE(smallest_cost, 0)
      + COALESCE(openai_cost, 0)
      + COALESCE(gemini_flash_tts_cost, 0)
      + COALESCE(hypereal_asr_cost, 0)
      + COALESCE(hypereal_video_cost, 0)
    ) STORED;

COMMENT ON COLUMN public.generation_costs.fish_audio_cost
  IS 'Fish Audio s2-pro TTS spend in USD for this generation.';
COMMENT ON COLUMN public.generation_costs.elevenlabs_cost
  IS 'ElevenLabs TTS / STS spend in USD.';
COMMENT ON COLUMN public.generation_costs.lemonfox_cost
  IS 'LemonFox TTS (Adam / River) spend in USD.';
COMMENT ON COLUMN public.generation_costs.smallest_cost
  IS 'Smallest.ai TTS spend in USD.';
COMMENT ON COLUMN public.generation_costs.openai_cost
  IS 'Direct OpenAI API spend (gpt-4o, etc.) in USD.';
COMMENT ON COLUMN public.generation_costs.gemini_flash_tts_cost
  IS 'Google Gemini 3.1 Flash TTS spend in USD (native API, not Hypereal).';
COMMENT ON COLUMN public.generation_costs.hypereal_asr_cost
  IS 'Hypereal audio-asr spend in USD (caption sync transcription).';
COMMENT ON COLUMN public.generation_costs.hypereal_video_cost
  IS 'Hypereal Kling I2V / scene video spend in USD.';

COMMIT;
