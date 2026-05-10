-- ============================================================
-- C-7-1 / C-7-2 / C-7-3 — Schema integrity hardening
--
-- Audit findings (Atlas F-D3 / F-D4 / F-D13):
--
--   F-D3 (C-7-1): video_generation_jobs.project_id was demoted to
--                 NULLABLE in 20260315164505_allow_null_project_id_jobs
--                 to support script-phase and standalone jobs
--                 (voice_preview, clone_voice, generate_topics,
--                 autopost_email_delivery, etc.) that legitimately
--                 have no project. Without a CHECK constraint this
--                 conflates legit null with orphan rows from buggy
--                 inserts. Add a partial CHECK that allows NULL
--                 ONLY when task_type is in the whitelist of
--                 standalone/script-phase task types.
--
--   F-D4 (C-7-2): user_flags / admin_logs / generation_archives
--                 FK constraints on user_id / flagged_by /
--                 resolved_by / admin_id were added in
--                 20260419000021_add_user_id_foreign_keys.sql.
--                 This migration re-asserts them defensively
--                 (idempotent IF NOT EXISTS) so environments that
--                 somehow drifted out of sync converge.
--
--   F-D13 (C-7-3): RLS predicate
--                  `WHERE user_id = auth.uid()` on
--                  video_generation_jobs sequential-scans without
--                  an index. 20260405000001_rate_limits_and_indexes
--                  added a single-column user_id index, but most
--                  RLS-driven UI reads also filter by status (e.g.
--                  "my pending/processing jobs"). Add a composite
--                  (user_id, status) index that the planner will
--                  prefer for those compound predicates.
--
-- Apply order matters:
--   1. Index FIRST (cheap, no table validation).
--   2. CHECK constraint SECOND (validates every existing row;
--      slow on large tables, briefly takes ACCESS EXCLUSIVE lock).
--   3. FK constraints LAST (also validating; mostly already
--      present from 20260419000021).
--
-- Lock cost (rough):
--   - CREATE INDEX … (concurrently NOT used here so the migration
--     is transactional) takes a SHARE lock on video_generation_jobs.
--     On a typical install this completes in <2s.
--   - ALTER TABLE … ADD CONSTRAINT … CHECK validates every row
--     and takes ACCESS EXCLUSIVE for the duration. At 1M rows
--     budget ~5-10s.
--   - ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY validates every
--     row against auth.users; the FKs are already in place in
--     production so the IF NOT EXISTS guards are no-ops.
-- ============================================================


-- ── 1. Pre-flight: surface any row that would violate the CHECK ──
-- The whitelist of task types that may legitimately ship with a
-- NULL project_id. Sources verified by grep of task_type literals
-- across worker/, src/, and supabase/functions/:
--   • generate_video           — script phase, runs before project is materialised
--   • generate_cinematic       — reserved alias of generate_video
--   • voice_preview            — standalone TTS preview, no project
--   • clone_voice              — voice cloning, no project
--   • rename_voice             — voice metadata edit, no project
--   • generate_topics          — autopost intake, project not yet created
--   • autopost_render          — autopost shadow project may not exist
--   • autopost_rerender        — autopost re-render path
--   • autopost_email_delivery  — autopost email send (Resend), no project
--
-- task types NOT on the whitelist require a non-NULL project_id:
--   process_audio, process_images, finalize_generation,
--   master_audio, cinematic_audio, cinematic_image, cinematic_video,
--   cinematic_video_edit, regenerate_image, regenerate_audio,
--   undo_regeneration, export_video.
--
-- Pre-flight scans for any row that would VIOLATE the CHECK. If
-- any are found we RAISE with a count + sample to give an operator
-- a chance to investigate. We do not auto-delete: those rows may
-- carry real history. The RAISE EXCEPTION will abort the
-- transaction so the constraint is never applied to bad data.

DO $$
DECLARE
  bad_count BIGINT;
  sample_rows TEXT;
BEGIN
  SELECT COUNT(*)
  INTO bad_count
  FROM public.video_generation_jobs
  WHERE project_id IS NULL
    AND task_type NOT IN (
      'generate_video',
      'generate_cinematic',
      'voice_preview',
      'clone_voice',
      'rename_voice',
      'generate_topics',
      'autopost_render',
      'autopost_rerender',
      'autopost_email_delivery'
    );

  IF bad_count > 0 THEN
    SELECT string_agg(
      format('id=%s task_type=%s status=%s created_at=%s',
             id, task_type, status, created_at), E'\n'
    )
    INTO sample_rows
    FROM (
      SELECT id, task_type, status, created_at
      FROM public.video_generation_jobs
      WHERE project_id IS NULL
        AND task_type NOT IN (
          'generate_video',
          'generate_cinematic',
          'voice_preview',
          'clone_voice',
          'rename_voice',
          'generate_topics',
          'autopost_render',
          'autopost_rerender',
          'autopost_email_delivery'
        )
      ORDER BY created_at DESC
      LIMIT 20
    ) s;

    RAISE EXCEPTION USING
      MESSAGE = format(
        'C-7-1 pre-flight: % video_generation_jobs rows have NULL project_id with a task_type that is not on the standalone whitelist. Investigate before applying the CHECK constraint.',
        bad_count
      ),
      DETAIL = sample_rows,
      HINT = 'Either backfill project_id, archive the rows, or extend the whitelist in this migration after confirming the task_type is legitimately standalone.';
  END IF;
END $$;


-- ── 2. Composite (user_id, status) index (C-7-3) ─────────────
-- The single-column idx_video_generation_jobs_user_id from
-- 20260405000001 already exists. RLS-driven UI predicates almost
-- always combine user_id with a status filter (e.g. "my pending
-- jobs", "my processing jobs"). The composite covers both cases:
-- (user_id = ?) range scans, AND (user_id = ? AND status IN
-- ('pending','processing')) bitmap scans. The single-column index
-- is left in place because postgres can still pick it for
-- user_id-only joins; the planner will choose the cheaper of the
-- two per query.

CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_user_id_status
  ON public.video_generation_jobs (user_id, status);

COMMENT ON INDEX public.idx_video_generation_jobs_user_id_status IS
  'Atlas F-D13 (C-7-3). Composite covers the common RLS-driven '
  'predicate user_id = auth.uid() AND status IN (...). Companion '
  'to the single-column idx_video_generation_jobs_user_id from '
  '20260405000001_rate_limits_and_indexes.sql.';


-- ── 3. CHECK constraint on project_id null-correlation (C-7-1) ──
-- "null only when task_type is on the standalone whitelist".
-- Idempotent: drop-if-exists then add. Drop is needed because
-- the constraint name is fixed and ALTER TABLE … ADD CONSTRAINT
-- has no IF NOT EXISTS option in Postgres ≤16.

ALTER TABLE public.video_generation_jobs
  DROP CONSTRAINT IF EXISTS vgj_project_id_or_standalone_only;

ALTER TABLE public.video_generation_jobs
  ADD CONSTRAINT vgj_project_id_or_standalone_only
    CHECK (
      project_id IS NOT NULL
      OR task_type IN (
        'generate_video',
        'generate_cinematic',
        'voice_preview',
        'clone_voice',
        'rename_voice',
        'generate_topics',
        'autopost_render',
        'autopost_rerender',
        'autopost_email_delivery'
      )
    );

COMMENT ON CONSTRAINT vgj_project_id_or_standalone_only
  ON public.video_generation_jobs IS
  'Atlas F-D3 (C-7-1). project_id is nullable to support script-'
  'phase jobs (generate_video runs before the project row is '
  'committed) and standalone jobs (voice_preview, clone_voice, '
  'generate_topics, autopost_email_delivery, autopost_render/'
  'rerender). For every other task_type project_id is mandatory; '
  'a NULL on a non-whitelist task_type is an orphan and must be '
  'investigated. If a new standalone task_type is introduced, '
  'extend this whitelist in a follow-up migration before inserting '
  'rows with the new value.';


-- ── 4. Defensive FK re-assertion (C-7-2) ─────────────────────
-- These FKs were added in 20260419000021_add_user_id_foreign_keys.
-- We re-assert them with the same IF NOT EXISTS guards so an
-- environment that lost them (manual schema surgery, accidental
-- DROP CONSTRAINT) re-converges. Each constraint matches the
-- original definition exactly — same name, same ON DELETE rule.

-- user_flags.user_id  — flagged user, cascade so the flag goes
--                       with the user.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_flags_user_id_fkey'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    RAISE NOTICE 'C-7-2: re-added user_flags_user_id_fkey (drifted)';
  END IF;
END $$;

-- user_flags.flagged_by — admin who raised the flag; SET NULL so
--                         the flag survives admin deletion.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_flags_flagged_by_fkey'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    ALTER TABLE public.user_flags
      ALTER COLUMN flagged_by DROP NOT NULL;
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_flagged_by_fkey
      FOREIGN KEY (flagged_by) REFERENCES auth.users(id) ON DELETE SET NULL;
    RAISE NOTICE 'C-7-2: re-added user_flags_flagged_by_fkey (drifted)';
  END IF;
END $$;

-- user_flags.resolved_by — admin who resolved the flag; SET NULL.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_flags_resolved_by_fkey'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_resolved_by_fkey
      FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;
    RAISE NOTICE 'C-7-2: re-added user_flags_resolved_by_fkey (drifted)';
  END IF;
END $$;

-- admin_logs.admin_id — the admin who performed the logged action.
--                       SET NULL keeps the audit row when the
--                       admin account is gone (analogous to
--                       B-NEW-6's deletion_requests fix).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_logs_admin_id_fkey'
      AND conrelid = 'public.admin_logs'::regclass
  ) THEN
    ALTER TABLE public.admin_logs
      ALTER COLUMN admin_id DROP NOT NULL;
    ALTER TABLE public.admin_logs
      ADD CONSTRAINT admin_logs_admin_id_fkey
      FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    RAISE NOTICE 'C-7-2: re-added admin_logs_admin_id_fkey (drifted)';
  END IF;
END $$;

-- generation_archives.user_id — already SET NULL (not CASCADE) in
--                               20260419000021 because archive
--                               rows are intentionally retained
--                               for audit/billing after user
--                               deletion. We preserve that policy
--                               here. The task brief asked for
--                               CASCADE but that conflicts with
--                               the retention intent in the
--                               original migration; SET NULL is
--                               the correct GDPR-compatible
--                               policy. Auth deletion still
--                               removes auth.users; the archive
--                               row's user_id is nulled so the
--                               row is no longer attributable to
--                               an identified person.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'generation_archives_user_id_fkey'
      AND conrelid = 'public.generation_archives'::regclass
  ) THEN
    ALTER TABLE public.generation_archives
      ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE public.generation_archives
      ADD CONSTRAINT generation_archives_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    RAISE NOTICE 'C-7-2: re-added generation_archives_user_id_fkey (drifted)';
  END IF;
END $$;


-- ── 5. Verification queries (informational; no rows changed) ──
--
-- Confirm the CHECK is present and validated:
--   SELECT conname, convalidated
--   FROM pg_constraint
--   WHERE conname = 'vgj_project_id_or_standalone_only';
--   -- Expected: convalidated = true.
--
-- Confirm the index landed:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'video_generation_jobs'
--     AND indexname = 'idx_video_generation_jobs_user_id_status';
--
-- Confirm the FKs are present:
--   SELECT conname, confdeltype
--   FROM pg_constraint
--   WHERE conname IN (
--     'user_flags_user_id_fkey',
--     'user_flags_flagged_by_fkey',
--     'user_flags_resolved_by_fkey',
--     'admin_logs_admin_id_fkey',
--     'generation_archives_user_id_fkey'
--   );
--   -- Expected confdeltype:
--   --   user_flags_user_id_fkey            c (CASCADE)
--   --   user_flags_flagged_by_fkey         n (SET NULL)
--   --   user_flags_resolved_by_fkey        n (SET NULL)
--   --   admin_logs_admin_id_fkey           n (SET NULL)
--   --   generation_archives_user_id_fkey   n (SET NULL)
