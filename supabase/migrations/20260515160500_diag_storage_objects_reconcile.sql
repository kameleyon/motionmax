-- ============================================================
-- DIAGNOSTIC: reconcile storage.objects table with SDK-visible
-- bucket walk. Purpose: investigate why Supabase's Usage dashboard
-- shows storage growing even after we deleted 64 GB via the SDK.
-- ============================================================
-- Three theories to discriminate:
--   (a) Dashboard cache lag (their own warning says ~1 hour) →
--       storage.objects row count matches SDK walk.
--   (b) Soft-delete / version history → storage.objects has MORE
--       rows than SDK list() returns (object versions, trash bin).
--   (c) Active uploads outpace cleanup → recent rows in
--       storage.objects show fresh inserts since our delete pass.
--
-- Read-only. Wrapped in BEGIN/COMMIT so the migration is recorded
-- once and not re-run.
-- ============================================================

BEGIN;

DO $$
DECLARE
  r record;
  grand_total_bytes bigint := 0;
  grand_total_rows  bigint := 0;
BEGIN
  RAISE NOTICE '═══ storage.objects per-bucket totals ═══';
  FOR r IN
    SELECT
      bucket_id,
      COUNT(*) AS rows,
      COALESCE(SUM((metadata->>'size')::bigint), 0) AS bytes
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY bytes DESC
  LOOP
    RAISE NOTICE '  %  rows=%  bytes=%  (% GB)',
      RPAD(COALESCE(r.bucket_id::text, '(null)'), 16),
      r.rows,
      r.bytes,
      ROUND((r.bytes::numeric / 1024 / 1024 / 1024), 2);
    grand_total_bytes := grand_total_bytes + r.bytes;
    grand_total_rows  := grand_total_rows + r.rows;
  END LOOP;
  RAISE NOTICE '  ──';
  RAISE NOTICE '  TOTAL  rows=%  bytes=%  (% GB)',
    grand_total_rows,
    grand_total_bytes,
    ROUND((grand_total_bytes::numeric / 1024 / 1024 / 1024), 2);
END $$;

-- Does the storage.objects table have a `deleted_at` or version column?
-- (Supabase Storage versioning support, if any, would expose this.)
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '═══ storage.objects columns ═══';
  FOR r IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'objects'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  %  %', RPAD(r.column_name, 24), r.data_type;
  END LOOP;
END $$;

-- Are there any soft-deleted rows lurking? If storage.objects has a
-- deleted_at-style column, this surfaces non-NULL counts per bucket.
DO $$
DECLARE
  has_deleted_at boolean;
  r record;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'objects' AND column_name = 'deleted_at'
  ) INTO has_deleted_at;
  RAISE NOTICE '';
  RAISE NOTICE '═══ storage.objects soft-delete check ═══';
  RAISE NOTICE '  has deleted_at column: %', has_deleted_at;
  IF has_deleted_at THEN
    FOR r IN EXECUTE
      'SELECT bucket_id, COUNT(*) AS n, COALESCE(SUM((metadata->>''size'')::bigint), 0) AS bytes
       FROM storage.objects WHERE deleted_at IS NOT NULL GROUP BY bucket_id ORDER BY bytes DESC'
    LOOP
      RAISE NOTICE '  soft-deleted in %: rows=%  bytes=% (% GB)',
        r.bucket_id, r.n, r.bytes, ROUND((r.bytes::numeric / 1024 / 1024 / 1024), 2);
    END LOOP;
  END IF;
END $$;

-- Recently inserted rows — is something currently uploading?
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '═══ storage.objects created in last 60 min ═══';
  FOR r IN
    SELECT bucket_id, name, created_at, (metadata->>'size')::bigint AS bytes
    FROM storage.objects
    WHERE created_at > NOW() - INTERVAL '60 minutes'
    ORDER BY created_at DESC
    LIMIT 30
  LOOP
    RAISE NOTICE '  %  %  % MB  %',
      to_char(r.created_at, 'MM-DD HH24:MI:SS'),
      RPAD(COALESCE(r.bucket_id::text, '?'), 14),
      ROUND((r.bytes::numeric / 1024 / 1024), 1),
      LEFT(r.name, 70);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '  (total: %)', n;
END $$;

-- Check storage.s3_multipart_uploads if it exists — abandoned/incomplete
-- multipart uploads also count against storage billing on most providers.
DO $$
DECLARE
  has_mp boolean;
  r record;
BEGIN
  SELECT to_regclass('storage.s3_multipart_uploads') IS NOT NULL INTO has_mp;
  RAISE NOTICE '';
  RAISE NOTICE '═══ storage.s3_multipart_uploads ═══';
  RAISE NOTICE '  table exists: %', has_mp;
  IF has_mp THEN
    FOR r IN EXECUTE
      'SELECT bucket_id, COUNT(*) AS n FROM storage.s3_multipart_uploads GROUP BY bucket_id ORDER BY n DESC'
    LOOP
      RAISE NOTICE '  pending multipart in %: %', r.bucket_id, r.n;
    END LOOP;
  END IF;
END $$;

COMMIT;
