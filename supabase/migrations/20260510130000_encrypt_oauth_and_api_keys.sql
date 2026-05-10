-- Migration: encrypt_oauth_and_api_keys
--
-- Audit: .audits/2026-05-10-360 — Blocker B-NEW-1 sub-issues 3 & 4.
--
-- Plain-text secrets are currently stored in two places:
--
--   1. autopost_social_accounts.access_token   (YouTube/IG/TikTok OAuth)
--      autopost_social_accounts.refresh_token  (YouTube/TikTok rotation)
--   2. user_api_keys.gemini_api_key            (Google AI key)
--      user_api_keys.replicate_api_token       (Replicate AI key)
--
-- After this migration the application code (api/, supabase/functions/,
-- worker/) writes those columns through the AES-256-GCM helpers in
-- supabase/functions/_shared/encryption.ts (Deno) and
-- worker/src/lib/encryption.ts (Node), which use the wire format:
--
--     v1:<base64-iv>:<base64-ciphertext-with-auth-tag>
--
-- The CHECK constraints below reject any new INSERT/UPDATE that does not
-- match that format, OR the legacy `v3:` prefix used by the existing
-- manage-api-keys Edge Function (which encrypts user_api_keys with a
-- per-user PBKDF2-derived key — different ENV var, different format, but
-- still ciphertext, NOT plaintext).  Allowing both prefixes keeps existing
-- rows valid while letting new writes adopt the unified v1 format.
--
-- ⚠️  RUN-ONCE BACKFILL REQUIRED ⚠️
-- This migration ADDS the constraint as `NOT VALID` so existing rows are
-- not rejected.  Any plaintext rows present at apply time MUST be
-- re-encrypted in place by the one-shot Edge Function
-- `migrate-encrypt-secrets` (see supabase/functions/migrate-encrypt-secrets).
-- After the backfill completes, run:
--
--     ALTER TABLE public.autopost_social_accounts
--       VALIDATE CONSTRAINT autopost_social_accounts_access_token_encrypted;
--     ALTER TABLE public.autopost_social_accounts
--       VALIDATE CONSTRAINT autopost_social_accounts_refresh_token_encrypted;
--     ALTER TABLE public.user_api_keys
--       VALIDATE CONSTRAINT user_api_keys_gemini_api_key_encrypted;
--     ALTER TABLE public.user_api_keys
--       VALIDATE CONSTRAINT user_api_keys_replicate_api_token_encrypted;
--
-- so the table-level invariant is enforced for every existing row too.
-- Keep `migrate-encrypt-secrets` deployed for one release, then disable
-- the route per the comments in that function.

-- Reusable predicate: NULL OR encrypted-looking string. Either the
-- v1: format from _shared/encryption.ts or the v3: format from the
-- legacy manage-api-keys helper.
--
-- The trailing $$ regex anchors are explicit so a leading newline /
-- whitespace cannot smuggle plaintext through.

-- ---- autopost_social_accounts ----
ALTER TABLE public.autopost_social_accounts
  ADD CONSTRAINT autopost_social_accounts_access_token_encrypted
    CHECK (
      access_token IS NULL
      OR access_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
      OR access_token ~ '^v3:[A-Za-z0-9+/=]+$'
    ) NOT VALID;

ALTER TABLE public.autopost_social_accounts
  ADD CONSTRAINT autopost_social_accounts_refresh_token_encrypted
    CHECK (
      refresh_token IS NULL
      OR refresh_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
      OR refresh_token ~ '^v3:[A-Za-z0-9+/=]+$'
    ) NOT VALID;

COMMENT ON COLUMN public.autopost_social_accounts.access_token
  IS 'OAuth access token, AES-256-GCM-encrypted. Wire format v1:<b64-iv>:<b64-ciphertext>. Decrypt via supabase/functions/_shared/encryption.ts or worker/src/lib/encryption.ts.';
COMMENT ON COLUMN public.autopost_social_accounts.refresh_token
  IS 'OAuth refresh token, AES-256-GCM-encrypted. Same format as access_token. NULL when the platform does not issue refresh tokens (e.g. Meta long-lived).';

-- ---- user_api_keys ----
-- The columns are gemini_api_key and replicate_api_token (verified via
-- the original create migration 20260111221546 — there is no `api_key`
-- column despite the audit shorthand).
ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_gemini_api_key_encrypted
    CHECK (
      gemini_api_key IS NULL
      OR gemini_api_key ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
      OR gemini_api_key ~ '^v3:[A-Za-z0-9+/=]+$'
    ) NOT VALID;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_replicate_api_token_encrypted
    CHECK (
      replicate_api_token IS NULL
      OR replicate_api_token ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
      OR replicate_api_token ~ '^v3:[A-Za-z0-9+/=]+$'
    ) NOT VALID;

COMMENT ON COLUMN public.user_api_keys.gemini_api_key
  IS 'User-supplied Google Gemini API key, AES-256-GCM-encrypted. Wire format v1:<b64-iv>:<b64-ciphertext> (or legacy v3:<b64> from manage-api-keys/index.ts).';
COMMENT ON COLUMN public.user_api_keys.replicate_api_token
  IS 'User-supplied Replicate API token, AES-256-GCM-encrypted. Same format as gemini_api_key.';
