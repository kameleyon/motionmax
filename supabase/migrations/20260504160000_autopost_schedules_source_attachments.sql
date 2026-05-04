-- Persist source attachments on autopost_schedules so each scheduled
-- run can re-feed them through the same research → script pipeline the
-- interactive intake form uses.
--
-- Previously: sources were only consumed (one-shot) during topic
-- generation in the intake/edit dialog and discarded — the script LLM
-- saw only `prompt_template` + `topic` + `previousTopics`. Result:
-- videos drifted into hallucinated dates / wrong facts because the
-- only ground truth was Google-search-via-Gemini at run time.
--
-- New: store the SourceAttachment[] (descriptor array — same shape the
-- frontend's processAttachments() emits) so handleAutopostRun.ts can
-- rebuild the [PDF_URL]/[FETCH_URL]/[YOUTUBE_URL]/etc. tag block on
-- every fire. The worker's existing processContentAttachments() then
-- expands those tags into actual content before researchTopic() runs,
-- giving the script LLM both the user's sources AND fresh Google-Search
-- grounding.
--
-- JSONB (not TEXT) so we can keep the editable structure round-tripping
-- through the edit dialog. Default '[]' so existing schedules don't
-- need backfill — they just behave like before until the user attaches
-- sources via the dialog.

ALTER TABLE public.autopost_schedules
  ADD COLUMN IF NOT EXISTS source_attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.autopost_schedules.source_attachments IS
  'Array of SourceAttachment descriptors (type/name/value). For images and PDFs, value is a Supabase Storage public URL captured at save time. For link/youtube/github/gdrive, value is the raw URL. For text/file (text content), value holds the inlined content. Re-processed on every run so URL-based sources fetch fresh.';
