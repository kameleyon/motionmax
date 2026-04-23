-- Apply missing schema that IntakeForm + handleFinalize + editor
-- all depend on. Run this ONCE in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/ayjbvcikuwknqdrpsdmj/sql/new
-- Paste all of it, click "Run".

-- 1. Persist intake form selections (music/sfx/captions/lipsync/etc.)
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS intake_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.projects.intake_settings IS
  'Catch-all JSON blob for the new unified intake form. Shape evolves as
   features light up; example keys: visualStyle, tone, camera, grade,
   lipSync{on,strength}, music{on,genre,intensity,sfx,uploadUrl},
   cast[], characterAppearance.';

-- 2. Editor columns: previous_export_url + music_url + stems
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS previous_export_url text;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS music_url text,
  ADD COLUMN IF NOT EXISTS stems jsonb;

COMMENT ON COLUMN public.projects.previous_export_url IS
  'Snapshot of the previous exported MP4 URL before the current one was
   written. Drives the Editor A/B compare view.';

COMMENT ON COLUMN public.generations.music_url IS
  'Hypereal Lyria 3 Pro music track URL when the user enabled music in
   the intake form. Null for generations with music off or pre-wiring.';

COMMENT ON COLUMN public.generations.stems IS
  'Per-generation unmixed audio stems and captions VTT. Shape:
   { voiceUrl, musicUrl, sfxUrl, captionsVtt }. Populated by the v2
   stems_export handler.';

-- 3. Unblock stuck finalize when any upstream dep failed.
-- Treat FAILED deps as terminal (not just COMPLETED) so finalize runs
-- with partial data instead of hanging forever on one bad scene.
CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type        TEXT    DEFAULT NULL,
  p_exclude_task_type TEXT   DEFAULT NULL,
  p_limit            INTEGER DEFAULT 1,
  p_worker_id        TEXT    DEFAULT NULL
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH to_claim AS (
    SELECT j.id,
      (
        SELECT COUNT(*)
        FROM public.video_generation_jobs a
        WHERE a.user_id = j.user_id AND a.status = 'processing'
      ) AS active_count
    FROM public.video_generation_jobs j
    WHERE j.status = 'pending'
      AND (p_task_type IS NULL OR j.task_type = p_task_type)
      AND (p_exclude_task_type IS NULL OR j.task_type != p_exclude_task_type)
      AND (
        j.depends_on = '{}'
        OR NOT EXISTS (
          SELECT 1 FROM public.video_generation_jobs dep
          WHERE dep.id = ANY(j.depends_on)
            AND dep.status NOT IN ('completed', 'failed')
        )
      )
    ORDER BY active_count ASC, j.created_at ASC
    LIMIT p_limit
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.video_generation_jobs j
  SET status = 'processing', updated_at = NOW(), worker_id = p_worker_id
  FROM to_claim
  WHERE j.id = to_claim.id
  RETURNING j.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER, TEXT) TO service_role;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name IN ('projects','generations')
   AND column_name IN ('intake_settings','previous_export_url','music_url','stems')
 ORDER BY table_name, column_name;
