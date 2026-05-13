-- Post-generation lipsync feature.
--
-- Flow: user generates a video normally → finds it on the editor → clicks
-- "Sync lips to audio" → backend enqueues a `lipsync_finalize` job that
-- sends the already-exported final MP4 + the master TTS audio to Sync
-- Labs lipsync-2 (Replicate or direct). On success we write the synced
-- video URL alongside the original on `generations`. The original
-- `final_video_url` stays put — `lipsync_video_url` is an override the
-- frontend prefers when present.
--
-- Pricing: 1 credit = 1s of standard output. Lipsync costs ~$0.06/output-
-- sec from Sync Labs (lipsync-2) or ~$0.15 (lipsync-2-pro). We charge
-- 2 credits/sec for std, 5 credits/sec for pro tier — keeps the existing
-- "credits ≈ seconds" mental model and leaves margin.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS lipsync_video_url        text,
  ADD COLUMN IF NOT EXISTS lipsync_status           text
    CHECK (lipsync_status IS NULL OR lipsync_status IN ('queued','processing','success','failed')),
  ADD COLUMN IF NOT EXISTS lipsync_provider         text,
  ADD COLUMN IF NOT EXISTS lipsync_model            text,
  ADD COLUMN IF NOT EXISTS lipsync_credits_charged  integer,
  ADD COLUMN IF NOT EXISTS lipsync_error            text,
  ADD COLUMN IF NOT EXISTS lipsync_completed_at     timestamptz;

COMMENT ON COLUMN public.generations.lipsync_video_url IS
  'URL of the lipsynced final video. Frontend player prefers this when
   set, falls back to the original final video (stored on the latest
   successful export_video job''s result.finalUrl). Independent column
   so the original is never destroyed and a failed lipsync run does not
   take down the existing video.';

COMMENT ON COLUMN public.generations.lipsync_status IS
  'queued = job inserted, not yet picked. processing = handler started.
   success = lipsync_video_url written. failed = check lipsync_error.
   NULL = feature never invoked for this generation.';

COMMENT ON COLUMN public.generations.lipsync_credits_charged IS
  'Credits deducted at enqueue time. On failure, refundCreditsOnFailure
   refunds exactly this amount via refund_credits_securely.';

-- Index for the "show me the latest lipsync status per project" admin view.
-- WHERE-clause makes it a tiny partial index covering only active rows.
CREATE INDEX IF NOT EXISTS generations_lipsync_status_idx
  ON public.generations (lipsync_status)
  WHERE lipsync_status IN ('queued', 'processing');
