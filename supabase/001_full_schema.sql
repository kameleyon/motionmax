-- ============================================================
-- 001_full_schema.sql
-- MotionMax / AudioMax — Complete database schema
-- Paste into target Supabase SQL Editor and run once.
-- Source: consolidated from all migrations + live types.ts
-- ============================================================

-- ── 1. ENUMS ──────────────────────────────────────────────
CREATE TYPE public.subscription_status AS ENUM (
  'active','canceled','past_due','trialing',
  'incomplete','incomplete_expired','unpaid'
);

CREATE TYPE public.app_role AS ENUM ('admin','moderator','user');

-- ── 2. UTILITY FUNCTION ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ── 3. TABLES ─────────────────────────────────────────────

CREATE TABLE public.profiles (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.user_api_keys (
  id                   UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID NOT NULL UNIQUE,
  gemini_api_key       TEXT,
  replicate_api_token  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.subscriptions (
  id                      UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 UUID NOT NULL,
  stripe_customer_id      TEXT NOT NULL,
  stripe_subscription_id  TEXT UNIQUE,
  plan_name               TEXT NOT NULL DEFAULT 'free',
  status                  subscription_status NOT NULL DEFAULT 'active',
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.user_credits (
  id               UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID NOT NULL UNIQUE,
  credits_balance  INTEGER NOT NULL DEFAULT 0,
  total_purchased  INTEGER NOT NULL DEFAULT 0,
  total_used       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_transactions (
  id                       UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                  UUID NOT NULL,
  amount                   INTEGER NOT NULL,
  transaction_type         TEXT NOT NULL CHECK (transaction_type IN ('purchase','usage','subscription_grant','refund','adjustment')),
  description              TEXT,
  stripe_payment_intent_id TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- projects — final schema (includes all ALTER TABLE additions + Lovable columns)
CREATE TABLE public.projects (
  id                              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title                           TEXT NOT NULL,
  description                     TEXT,
  content                         TEXT NOT NULL DEFAULT '',
  format                          TEXT NOT NULL DEFAULT 'landscape',
  length                          TEXT NOT NULL DEFAULT 'short',
  style                           TEXT NOT NULL DEFAULT 'modern-minimalist',
  status                          TEXT NOT NULL DEFAULT 'draft',
  is_favorite                     BOOLEAN NOT NULL DEFAULT false,
  brand_mark                      TEXT,
  project_type                    TEXT NOT NULL DEFAULT 'doc2video',
  inspiration_style               TEXT,
  story_tone                      TEXT,
  story_genre                     TEXT,
  voice_inclination               TEXT,
  voice_type                      TEXT DEFAULT 'standard',
  voice_id                        TEXT,
  voice_name                      TEXT,
  character_consistency_enabled   BOOLEAN DEFAULT false,
  character_description           TEXT,
  disable_expressions             BOOLEAN NOT NULL DEFAULT false,
  presenter_focus                 TEXT,
  thumbnail_url                   TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.generations (
  id            UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  progress      INTEGER NOT NULL DEFAULT 0,
  script        TEXT,
  scenes        JSONB,
  audio_url     TEXT,
  video_url     TEXT,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.generation_archives (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_id           UUID NOT NULL,
  project_id            UUID NOT NULL,
  user_id               UUID NOT NULL,
  status                TEXT NOT NULL,
  progress              INTEGER NOT NULL DEFAULT 0,
  scenes                JSONB,
  script                TEXT,
  audio_url             TEXT,
  video_url             TEXT,
  error_message         TEXT,
  original_created_at   TIMESTAMPTZ NOT NULL,
  original_completed_at TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.generation_costs (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id   UUID NOT NULL,
  user_id         UUID NOT NULL,
  openrouter_cost DECIMAL(10,6) DEFAULT 0,
  replicate_cost  DECIMAL(10,6) DEFAULT 0,
  hypereal_cost   DECIMAL(10,6) DEFAULT 0,
  google_tts_cost DECIMAL(10,6) DEFAULT 0,
  total_cost      DECIMAL(10,6) GENERATED ALWAYS AS (openrouter_cost + replicate_cost + hypereal_cost + google_tts_cost) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.api_call_logs (
  id               UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id    UUID,
  user_id          UUID NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  queue_time_ms    INTEGER,
  running_time_ms  INTEGER,
  total_duration_ms INTEGER,
  cost             NUMERIC DEFAULT 0,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.system_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID,
  event_type    TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('user_activity','system_error','system_warning','system_info')),
  message       TEXT NOT NULL,
  details       JSONB,
  generation_id UUID,
  project_id    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.project_characters (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL,
  user_id             UUID NOT NULL,
  character_name      TEXT NOT NULL,
  description         TEXT NOT NULL,
  reference_image_url TEXT NOT NULL,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.project_shares (
  id           UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  share_token  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ DEFAULT NULL,
  view_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE public.user_voices (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL,
  voice_name  TEXT NOT NULL,
  voice_id    TEXT NOT NULL,
  sample_url  TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role       app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE public.user_flags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL,
  flag_type        TEXT NOT NULL CHECK (flag_type IN ('warning','flagged','suspended','banned')),
  reason           TEXT NOT NULL,
  details          TEXT,
  flagged_by       UUID NOT NULL,
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID,
  resolution_notes TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   UUID,
  details     JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- video_generation_jobs — created via Supabase dashboard; captured here from types.ts
CREATE TABLE public.video_generation_jobs (
  id            UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id    UUID NOT NULL,
  user_id       UUID NOT NULL,
  task_type     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  payload       JSONB,
  progress      INTEGER DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- webhook_events — stripe idempotency guard
CREATE TABLE public.webhook_events (
  id           UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 4. INDEXES ────────────────────────────────────────────
CREATE INDEX idx_subscriptions_user_id            ON public.subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer_id ON public.subscriptions(stripe_customer_id);
CREATE INDEX idx_user_credits_user_id             ON public.user_credits(user_id);
CREATE INDEX idx_credit_transactions_user_id      ON public.credit_transactions(user_id);
CREATE INDEX idx_projects_user_type               ON public.projects(user_id, project_type);
CREATE INDEX idx_project_shares_token             ON public.project_shares(share_token);
CREATE INDEX idx_generation_costs_user_id         ON public.generation_costs(user_id);
CREATE INDEX idx_generation_costs_generation_id   ON public.generation_costs(generation_id);
CREATE INDEX idx_api_call_logs_created_at         ON public.api_call_logs(created_at DESC);
CREATE INDEX idx_api_call_logs_provider           ON public.api_call_logs(provider);
CREATE INDEX idx_api_call_logs_status             ON public.api_call_logs(status);
CREATE INDEX idx_system_logs_created_at           ON public.system_logs(created_at DESC);
CREATE INDEX idx_system_logs_category             ON public.system_logs(category);
CREATE INDEX idx_system_logs_user_id              ON public.system_logs(user_id);
CREATE INDEX idx_system_logs_event_type           ON public.system_logs(event_type);

-- ── 5. FUNCTIONS ──────────────────────────────────────────

-- Auto-create profile on signup (sanitizes display_name)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  safe_name TEXT;
BEGIN
  safe_name := COALESCE(
    substring(NEW.raw_user_meta_data->>'full_name', 1, 100),
    split_part(NEW.email, '@', 1)
  );
  safe_name := regexp_replace(safe_name, '[^a-zA-Z0-9 ''._-]', '', 'g');
  IF safe_name IS NULL OR length(trim(safe_name)) = 0 THEN
    safe_name := 'User';
  END IF;
  BEGIN
    INSERT INTO public.profiles (user_id, display_name)
    VALUES (NEW.id, trim(safe_name));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Role helpers (SECURITY DEFINER prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'admin')
$$;

-- Get shared project by token (bypasses RLS)
CREATE OR REPLACE FUNCTION public.get_shared_project(share_token_param TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sr RECORD; pr RECORD; gr RECORD; result JSON;
BEGIN
  SELECT * INTO sr FROM project_shares WHERE share_token = share_token_param;
  IF sr IS NULL THEN RETURN NULL; END IF;
  IF sr.expires_at IS NOT NULL AND sr.expires_at < now() THEN RETURN NULL; END IF;
  SELECT id, title, format, style, description INTO pr FROM projects WHERE id = sr.project_id;
  IF pr IS NULL THEN RETURN NULL; END IF;
  SELECT scenes, audio_url INTO gr
  FROM generations WHERE project_id = sr.project_id AND status = 'complete'
  ORDER BY created_at DESC LIMIT 1;
  UPDATE project_shares SET view_count = view_count + 1 WHERE id = sr.id;
  result := json_build_object(
    'project', json_build_object('id',pr.id,'title',pr.title,'format',pr.format,'style',pr.style,'description',pr.description),
    'scenes', COALESCE(gr.scenes, '[]'::jsonb),
    'share',  json_build_object('id',sr.id,'view_count',sr.view_count + 1)
  );
  RETURN result;
END;
$$;

-- Atomic credit deduction (race-condition safe)
CREATE OR REPLACE FUNCTION public.deduct_credits_securely(
  p_user_id UUID, p_amount INT, p_transaction_type TEXT, p_description TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE bal INT;
BEGIN
  SELECT credits_balance INTO bal FROM user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF bal IS NULL OR bal < p_amount THEN RETURN FALSE; END IF;
  UPDATE user_credits
  SET credits_balance = credits_balance - p_amount, total_used = total_used + p_amount, updated_at = NOW()
  WHERE user_id = p_user_id;
  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (p_user_id, -p_amount, p_transaction_type, p_description);
  RETURN TRUE;
END;
$$;

-- Upsert credit balance (called by stripe-webhook)
CREATE OR REPLACE FUNCTION public.increment_user_credits(p_user_id UUID, p_credits INT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO user_credits (user_id, credits_balance, total_purchased)
  VALUES (p_user_id, p_credits, p_credits)
  ON CONFLICT (user_id) DO UPDATE
  SET credits_balance  = user_credits.credits_balance + p_credits,
      total_purchased  = user_credits.total_purchased + p_credits,
      updated_at       = NOW();
END;
$$;

-- Atomic single-scene update inside a generation
CREATE OR REPLACE FUNCTION public.update_scene_at_index(
  p_generation_id UUID, p_scene_index INTEGER, p_scene_data JSONB, p_progress INTEGER DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE generations
  SET scenes   = jsonb_set(scenes, ARRAY[p_scene_index::text], p_scene_data),
      progress = COALESCE(p_progress, progress)
  WHERE id = p_generation_id;
END;
$$;

-- Sanitize sensitive keys from JSONB log details
CREATE OR REPLACE FUNCTION public.sanitize_log_details()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s JSONB;
  keys TEXT[] := ARRAY['password','passwd','secret','token','api_key','apikey','api-key',
    'authorization','auth_token','access_token','refresh_token','bearer','credential',
    'private_key','secret_key','encryption_key','stripe_key','elevenlabs_api_key',
    'gemini_api_key','replicate_api_token','ssn','credit_card','card_number','cvv','cvc'];
  k TEXT;
BEGIN
  IF NEW.details IS NULL THEN RETURN NEW; END IF;
  s := NEW.details;
  FOREACH k IN ARRAY keys LOOP
    s := (SELECT COALESCE(jsonb_object_agg(key, CASE WHEN lower(key) LIKE '%' || k || '%' THEN '"[REDACTED]"'::jsonb ELSE value END), '{}'::jsonb) FROM jsonb_each(s));
  END LOOP;
  NEW.details := s;
  RETURN NEW;
END;
$$;

-- ── 6. TRIGGERS ───────────────────────────────────────────
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_user_credits_updated_at
  BEFORE UPDATE ON public.user_credits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_user_api_keys_updated_at
  BEFORE UPDATE ON public.user_api_keys FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_user_roles_updated_at
  BEFORE UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_user_flags_updated_at
  BEFORE UPDATE ON public.user_flags FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_video_generation_jobs_updated_at
  BEFORE UPDATE ON public.video_generation_jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER sanitize_system_logs_trigger
  BEFORE INSERT OR UPDATE ON public.system_logs FOR EACH ROW EXECUTE FUNCTION public.sanitize_log_details();

-- ── 7. ROW LEVEL SECURITY ─────────────────────────────────
ALTER TABLE public.profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.generations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generations          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.generation_archives  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_archives  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.generation_costs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_call_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_characters   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_characters   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_shares       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_voices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_voices          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_flags           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_flags           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.admin_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_logs           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.video_generation_jobs ENABLE ROW LEVEL SECURITY;

-- profiles
CREATE POLICY "Authenticated users can view their own profile"   ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can create their own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can update their own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can delete their own profile" ON public.profiles FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- user_api_keys
CREATE POLICY "Authenticated users can view their own API keys"   ON public.user_api_keys FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can insert their own API keys" ON public.user_api_keys FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can update their own API keys" ON public.user_api_keys FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can delete their own API keys" ON public.user_api_keys FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Deny anonymous access to user_api_keys"
  ON public.user_api_keys AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- subscriptions
CREATE POLICY "Authenticated users can view their own subscription" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Deny direct subscription inserts" ON public.subscriptions FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "Deny direct subscription updates" ON public.subscriptions FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "Deny anonymous access to subscriptions" ON public.subscriptions AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- user_credits
CREATE POLICY "Authenticated users can view their own credits"    ON public.user_credits FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Service role can insert credits"                   ON public.user_credits FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role can update credits"                   ON public.user_credits FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role can delete credits"                   ON public.user_credits FOR DELETE TO service_role USING (true);
CREATE POLICY "Authenticated users cannot insert credits"         ON public.user_credits AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "Authenticated users cannot update credits"         ON public.user_credits AS RESTRICTIVE FOR UPDATE TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY "Authenticated users cannot delete credits"         ON public.user_credits AS RESTRICTIVE FOR DELETE TO authenticated USING (false);
CREATE POLICY "Deny anonymous access to user_credits"            ON public.user_credits AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- credit_transactions
CREATE POLICY "Users can view their own credit transactions"     ON public.credit_transactions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Only service role can insert credit transactions" ON public.credit_transactions FOR INSERT WITH CHECK (false);
CREATE POLICY "Deny anonymous access to credit_transactions"    ON public.credit_transactions AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- projects
CREATE POLICY "Authenticated users can view their own projects"   ON public.projects FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can create their own projects" ON public.projects FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can update their own projects" ON public.projects FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can delete their own projects" ON public.projects FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Deny anonymous access to projects"                ON public.projects AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- generations
CREATE POLICY "Authenticated users can view their own generations"   ON public.generations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can create their own generations" ON public.generations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Authenticated users can update their own generations" ON public.generations FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can delete their own generations" ON public.generations FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- generation_archives (admin read-only)
CREATE POLICY "Admins can view all archives"      ON public.generation_archives FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Deny anonymous access to archives" ON public.generation_archives FOR ALL TO anon USING (false) WITH CHECK (false);

-- generation_costs
CREATE POLICY "Admins can view all costs"                 ON public.generation_costs FOR SELECT USING (public.is_admin(auth.uid()));
CREATE POLICY "Service role can insert costs"             ON public.generation_costs FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Deny anonymous access to generation_costs" ON public.generation_costs FOR ALL USING (false) WITH CHECK (false);

-- api_call_logs
CREATE POLICY "Admins can view all api_call_logs"       ON public.api_call_logs FOR SELECT USING (is_admin(auth.uid()));
CREATE POLICY "Service role can insert api_call_logs"   ON public.api_call_logs FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Deny anonymous access to api_call_logs"  ON public.api_call_logs FOR ALL TO anon USING (false) WITH CHECK (false);

-- system_logs
CREATE POLICY "Admins can view all system_logs"  ON public.system_logs FOR SELECT USING (is_admin(auth.uid()));
CREATE POLICY "Deny anon select system_logs"     ON public.system_logs FOR SELECT TO anon USING (false);
CREATE POLICY "Deny anon insert system_logs"     ON public.system_logs FOR INSERT TO anon WITH CHECK (false);
CREATE POLICY "Deny anon update system_logs"     ON public.system_logs FOR UPDATE TO anon USING (false) WITH CHECK (false);
CREATE POLICY "Deny anon delete system_logs"     ON public.system_logs FOR DELETE TO anon USING (false);

-- project_characters
CREATE POLICY "Users can view their own characters"           ON public.project_characters FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own characters"         ON public.project_characters FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own characters"         ON public.project_characters FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own characters"         ON public.project_characters FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Deny anonymous access to project_characters"  ON public.project_characters FOR ALL TO anon USING (false) WITH CHECK (false);

-- project_shares (anonymous access only via get_shared_project() RPC – SECURITY DEFINER)
CREATE POLICY "Users can create their own shares" ON public.project_shares FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view their own shares"   ON public.project_shares FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own shares" ON public.project_shares FOR DELETE USING (auth.uid() = user_id);

-- user_voices
CREATE POLICY "Users can view their own voices"   ON public.user_voices FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create their own voices" ON public.user_voices FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own voices" ON public.user_voices FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own voices" ON public.user_voices FOR DELETE USING (auth.uid() = user_id);

-- user_roles
CREATE POLICY "Admins can view all roles"             ON public.user_roles FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Admins can insert roles"               ON public.user_roles FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Admins can update roles"               ON public.user_roles FOR UPDATE TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Admins can delete roles"               ON public.user_roles FOR DELETE TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Deny anonymous access to user_roles"   ON public.user_roles FOR ALL TO anon USING (false) WITH CHECK (false);

-- user_flags
CREATE POLICY "Admins can view all flags"             ON public.user_flags FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Admins can create flags"               ON public.user_flags FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Admins can update flags"               ON public.user_flags FOR UPDATE TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Admins can delete flags"               ON public.user_flags FOR DELETE TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Deny anonymous access to user_flags"   ON public.user_flags FOR ALL TO anon USING (false) WITH CHECK (false);

-- admin_logs
CREATE POLICY "Admins can view all logs"              ON public.admin_logs FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY "Admins can insert logs"                ON public.admin_logs FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()));
CREATE POLICY "Deny anonymous access to admin_logs"   ON public.admin_logs FOR ALL TO anon USING (false) WITH CHECK (false);

-- video_generation_jobs
CREATE POLICY "anon_worker_select_jobs"       ON public.video_generation_jobs FOR SELECT TO anon USING (true);
CREATE POLICY "anon_worker_update_jobs"       ON public.video_generation_jobs FOR UPDATE TO anon USING (true);
CREATE POLICY "authenticated_select_own_jobs" ON public.video_generation_jobs FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "authenticated_insert_own_jobs" ON public.video_generation_jobs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ── 8. GRANTS & REVOKES ───────────────────────────────────
REVOKE ALL ON public.user_api_keys FROM anon;
REVOKE ALL ON public.user_api_keys FROM public;
REVOKE ALL ON public.user_credits  FROM anon;
REVOKE ALL ON public.user_credits  FROM public;
REVOKE ALL ON public.system_logs   FROM anon;
REVOKE ALL ON public.system_logs   FROM public;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_api_keys TO authenticated;
GRANT SELECT ON public.user_credits TO authenticated;

-- ── 9. STORAGE BUCKETS ────────────────────────────────────
-- Private buckets
INSERT INTO storage.buckets (id, name, public) VALUES ('audio',          'audio',          false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('source_uploads', 'source_uploads', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('voice_samples',  'voice_samples',  false) ON CONFLICT (id) DO NOTHING;

-- Public buckets
INSERT INTO storage.buckets (id, name, public) VALUES ('scene-images',       'scene-images',       true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('audio-files',        'audio-files',        true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('scene-videos',       'scene-videos',       true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('project-thumbnails', 'project-thumbnails', true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('style-references',   'style-references',   true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('videos','videos',true,524288000,ARRAY['video/mp4','video/webm','audio/mpeg','image/png','image/jpeg'])
  ON CONFLICT (id) DO NOTHING;

-- ── 10. STORAGE POLICIES ──────────────────────────────────
-- audio (private — owner + service_role only)
CREATE POLICY "Users can upload their own audio"  ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can view their own audio"    ON storage.objects FOR SELECT USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can update their own audio"  ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can delete their own audio"  ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Service role can manage all audio" ON storage.objects FOR ALL TO service_role USING (bucket_id = 'audio') WITH CHECK (bucket_id = 'audio');

-- source_uploads (private — owner only)
CREATE POLICY "Users can upload their own source files" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'source_uploads' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can view their own source files"   ON storage.objects FOR SELECT USING (bucket_id = 'source_uploads' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can delete their own source files" ON storage.objects FOR DELETE USING (bucket_id = 'source_uploads' AND auth.uid()::text = (storage.foldername(name))[1]);

-- voice_samples (private — owner only)
CREATE POLICY "Authenticated users can upload voice samples"           ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'voice_samples' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Users can read their own voice samples"                 ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'voice_samples' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Authenticated users can delete their own voice samples" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'voice_samples' AND auth.uid()::text = (storage.foldername(name))[1]);

-- scene-videos (public bucket — authenticated write)
CREATE POLICY "Users can upload to scene-videos"   ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'scene-videos');
CREATE POLICY "Users can update scene-videos"      ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'scene-videos');
CREATE POLICY "Users can delete from scene-videos" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'scene-videos');

-- project-thumbnails (public read, service_role write)
CREATE POLICY "Public read access for project thumbnails"  ON storage.objects FOR SELECT USING (bucket_id = 'project-thumbnails');
CREATE POLICY "Service role can upload project thumbnails" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'project-thumbnails');
CREATE POLICY "Service role can delete project thumbnails" ON storage.objects FOR DELETE USING (bucket_id = 'project-thumbnails');

-- videos (public read; scoped auth write; anon worker writes to generated/ prefix)
CREATE POLICY "public_read_videos"              ON storage.objects FOR SELECT TO public      USING (bucket_id = 'videos');
CREATE POLICY "authenticated_upload_own_videos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'videos' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "authenticated_update_own_videos" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'videos' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "authenticated_delete_own_videos" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'videos' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "anon_worker_upload_videos"       ON storage.objects FOR INSERT TO anon        WITH CHECK (bucket_id = 'videos' AND (storage.foldername(name))[1] = 'generated');

-- ── END OF SCHEMA ──────────────────────────────────────────
-- After running this: see MIGRATION_GUIDE.md for next steps