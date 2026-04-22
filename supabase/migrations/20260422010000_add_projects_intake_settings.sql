-- Add a JSONB catch-all for the new intake form's feature toggles.
--
-- Why JSONB instead of discrete columns:
--   The intake form surfaces a large, evolving set of creative toggles
--   (lip sync, music & sfx, cast, tone, camera, color grade, visual
--   style, character appearance, etc.). Several of these are blocked on
--   external integrations (Hypereal Lyrica for music, worker-side lip
--   sync, character locking) and will evolve quickly. A single JSONB
--   column means the UI can save + read the full settings blob today
--   without schema churn; when the render pipeline learns to consume a
--   given field, it just reads it out of the JSON.
--
-- Default '{}' keeps all existing SELECTs returning the same shape as
-- before (empty object rather than NULL) so client code doesn't need
-- null checks.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS intake_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.projects.intake_settings IS
  'Catch-all JSON blob for the new unified intake form. Shape evolves as
   features light up; example keys: visualStyle, tone, camera, grade,
   lipSync{on,strength}, music{on,genre,intensity,sfx,uploadUrl},
   cast[], characterAppearance.';
