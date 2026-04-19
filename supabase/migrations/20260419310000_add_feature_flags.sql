-- Feature flags table for runtime provider kill-switches.
-- Env var FLAG_<UPPERCASE_NAME>=true|false always overrides the DB value,
-- so flags remain operable even during DB incidents.
create table if not exists public.feature_flags (
  flag_name   text        primary key,
  enabled     boolean     not null default true,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.feature_flags enable row level security;

-- Only service-role (worker / edge functions) may read; no public access.
create policy "service_role_only"
  on public.feature_flags
  for all
  using (auth.role() = 'service_role');

-- Seed the initial provider kill-switches (all enabled by default).
insert into public.feature_flags (flag_name, enabled, description) values
  ('ai_video_generation',      true,  'Enable AI video generation per scene during export (EXPORT_AI_VIDEO env override)'),
  ('voice_cloning',            true,  'Enable ElevenLabs / Fish Audio voice-clone provider'),
  ('image_generation',         true,  'Enable AI image generation (master kill-switch for all image providers)'),
  ('image_provider_hypereal',  true,  'Enable Hypereal as the primary image generation provider'),
  ('image_provider_replicate', true,  'Enable Replicate as the fallback image generation provider'),
  ('tts_provider_elevenlabs',  true,  'Enable ElevenLabs TTS provider'),
  ('tts_provider_fish',        true,  'Enable Fish Audio TTS provider')
on conflict (flag_name) do nothing;

-- Trigger to keep updated_at current.
create or replace function public.set_feature_flag_updated_at()
  returns trigger language plpgsql security definer
  set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists feature_flags_updated_at on public.feature_flags;
create trigger feature_flags_updated_at
  before update on public.feature_flags
  for each row execute function public.set_feature_flag_updated_at();

comment on table public.feature_flags is
  'Runtime feature flags for provider kill-switches. '
  'Env var FLAG_<UPPERCASE_FLAG_NAME>=true|false overrides the DB value.';
