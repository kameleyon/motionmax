-- ============================================================
-- Voice cloning consent audit trail
-- Required by GDPR Art. 9 / biometric data processing rules.
-- Every voice clone must have a persisted, server-verified
-- consent record before the clone is created.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.voice_consents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  voice_id      TEXT NOT NULL,             -- ElevenLabs voice_id
  consented_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address    TEXT,
  user_agent    TEXT
);

-- Index for audits: find all consents for a user quickly
CREATE INDEX IF NOT EXISTS voice_consents_user_id_idx ON public.voice_consents(user_id);

-- RLS: users can view their own consent records; only service_role inserts
ALTER TABLE public.voice_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own voice consents"
  ON public.voice_consents FOR SELECT
  USING (auth.uid() = user_id);

-- service_role bypasses RLS — inserts happen from the edge function
