-- ============================================================
-- video_generation_jobs.checkpoint — resumable-handler state
-- ============================================================
-- Per-job durable state that handlers consult on entry to skip
-- already-completed external API calls after a worker restart.
-- Kept separate from `payload` so handler progress writes don't
-- have to round-trip the whole input payload, and so a checkpoint
-- can persist past status transitions (processing → pending) when
-- gracefulShutdown releases an in-flight job.
--
-- Shape (as written by worker/src/lib/checkpoint.ts):
--   {
--     "scene_<i>": {
--        "stage": "polling" | "downloaded" | "uploaded" | "scene_committed",
--        "provider": "Seedance" | "Kling V3 Pro" | ...,
--        "providerJobId": "abc123",
--        "pollUrl": "https://...",
--        "videoUrl": "https://...",     // populated at stage='downloaded'+
--        "uploadedUrl": "https://..."   // populated at stage='uploaded'+
--     }
--   }
--
-- Rationale: no schema enforcement so handlers can evolve checkpoint
-- shapes without migrations. JSON validation lives in checkpoint.ts.

BEGIN;

ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS checkpoint jsonb;

COMMIT;
