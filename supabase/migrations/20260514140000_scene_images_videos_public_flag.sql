-- Re-assert public=true on the scene-images and videos buckets.
--
-- Context: the earlier `20260510130100_lock_storage_buckets.sql`
-- migration was intended to gate writes/deletes via RLS policies on
-- storage.objects, but a side effect (the Supabase platform's bucket-
-- create-or-update semantics, possibly via dashboard config drift)
-- left both buckets at `public=false`. That broke the public URL
-- format `/storage/v1/object/public/scene-images/<path>` for external
-- consumers — most importantly the worker's video providers
-- (Replicate, Hypereal) which fetch the image via plain HTTPS from
-- the URL we stuff into scene.imageUrl. A failed fetch there means
-- Replicate's primary call 400s, the handler falls through to
-- Hypereal Seedance Fast at full premium cost, and credits burn
-- without delivering a video.
--
-- Verified 2026-05-14 17:30 UTC: ~1,040 user credits burned in a
-- single hour from 4 fallback-fired calls (3x Seedance 281 + 1x Kling
-- 197). Reverted live by calling `supabase.storage.updateBucket(id,
-- { public: true })` for both buckets. This migration codifies the
-- correct steady-state so a future re-run of the lock_storage_buckets
-- migration (or a dashboard config push) can't drop us back into the
-- broken state without an explicit follow-up.
--
-- Reads are intentionally allowed on these two buckets because the
-- worker (Replicate / Hypereal / etc.) must be able to fetch images
-- from a plain HTTP URL with no auth header. The lock_storage_buckets
-- RLS policies on storage.objects still gate WRITES / DELETES by
-- ownership — they're unaffected by this flag.
--
-- If we later refactor the worker to generate signed URLs before
-- handing images to external providers, this can be reverted (set
-- public=false) — but only AFTER the worker code uses sb.storage
-- .createSignedUrl(...) for every external-provider call site.

UPDATE storage.buckets
   SET public = TRUE
 WHERE id IN ('scene-images', 'videos')
   AND public = FALSE;
