-- ============================================================
-- Migration: Fix log sanitization bypass vulnerabilities
-- Fixes: array values not sanitized, overly broad JWT/API key detection
-- ============================================================

CREATE OR REPLACE FUNCTION public.sanitize_log_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sensitive_keys TEXT[] := ARRAY[
    'password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'apikey',
    'api-key', 'authorization', 'auth_token', 'access_token', 'refresh_token',
    'bearer', 'credential', 'private_key', 'privatekey', 'secret_key',
    'secretkey', 'encryption_key', 'stripe_key', 'elevenlabs_api_key',
    'openai_key', 'gemini_api_key', 'replicate_api_token', 'ssn',
    'credit_card', 'card_number', 'cvv', 'cvc'
  ];
BEGIN
  IF NEW.details IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.details := sanitize_jsonb_value(NEW.details, sensitive_keys);
  RETURN NEW;
END;
$$;

-- Recursive helper: sanitizes any JSONB value (object, array, or scalar)
CREATE OR REPLACE FUNCTION public.sanitize_jsonb_value(
  val JSONB,
  sensitive_keys TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
  key_pattern TEXT;
  arr_elem JSONB;
  arr_result JSONB := '[]'::jsonb;
  kv RECORD;
  obj_result JSONB := '{}'::jsonb;
  str_val TEXT;
BEGIN
  IF val IS NULL THEN
    RETURN NULL;
  END IF;

  -- Handle arrays: recurse into each element
  IF jsonb_typeof(val) = 'array' THEN
    FOR arr_elem IN SELECT value FROM jsonb_array_elements(val)
    LOOP
      arr_result := arr_result || jsonb_build_array(
        sanitize_jsonb_value(arr_elem, sensitive_keys)
      );
    END LOOP;
    RETURN arr_result;
  END IF;

  -- Handle objects: check keys + recurse into values
  IF jsonb_typeof(val) = 'object' THEN
    FOR kv IN SELECT key, value FROM jsonb_each(val)
    LOOP
      -- Check if key matches any sensitive pattern
      DECLARE
        is_sensitive BOOLEAN := FALSE;
      BEGIN
        FOREACH key_pattern IN ARRAY sensitive_keys
        LOOP
          IF lower(kv.key) LIKE '%' || key_pattern || '%' THEN
            is_sensitive := TRUE;
            EXIT;
          END IF;
        END LOOP;

        IF is_sensitive THEN
          obj_result := obj_result || jsonb_build_object(kv.key, '"[REDACTED]"'::jsonb);
        ELSE
          obj_result := obj_result || jsonb_build_object(
            kv.key, sanitize_jsonb_value(kv.value, sensitive_keys)
          );
        END IF;
      END;
    END LOOP;
    RETURN obj_result;
  END IF;

  -- Handle string values: pattern-based redaction
  IF jsonb_typeof(val) = 'string' THEN
    str_val := val #>> '{}';  -- extract raw string

    -- Stripe keys: sk_live_*, sk_test_*, pk_live_*, pk_test_*
    IF str_val ~ '^(sk|pk)_(live|test)_[a-zA-Z0-9]{10,}$' THEN
      RETURN '"[REDACTED_STRIPE_KEY]"'::jsonb;
    END IF;

    -- Bearer tokens: "Bearer ..." prefix
    IF str_val ~* '^bearer\s+[a-zA-Z0-9._-]+$' THEN
      RETURN '"[REDACTED_BEARER_TOKEN]"'::jsonb;
    END IF;

    -- JWT tokens: must have exactly 3 base64url segments starting with eyJ
    IF str_val ~ '^eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}$' THEN
      RETURN '"[REDACTED_JWT]"'::jsonb;
    END IF;

    -- Known API key prefixes (provider-specific, not generic length)
    IF str_val ~ '^(sk-[a-zA-Z0-9]{20,}|r8_[a-zA-Z0-9]{20,}|xi_[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{30,})$' THEN
      RETURN '"[REDACTED_API_KEY]"'::jsonb;
    END IF;
  END IF;

  -- All other types (number, boolean, null): pass through
  RETURN val;
END;
$$;

-- Re-create trigger (no change, just ensure it's attached)
DROP TRIGGER IF EXISTS sanitize_system_logs_trigger ON public.system_logs;
CREATE TRIGGER sanitize_system_logs_trigger
  BEFORE INSERT OR UPDATE ON public.system_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_log_details();
