-- Fix: replace flat-loop sanitize_log_details with recursive sanitize_jsonb_value.
-- The original implementation only redacted top-level JSONB keys; nested objects
-- like {"request": {"token": "abc"}} were left unredacted.

-- Helper: recursively redact sensitive keys at every nesting level.
CREATE OR REPLACE FUNCTION public.sanitize_jsonb_value(val JSONB, sensitive_keys TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key    TEXT;
  child  JSONB;
  result JSONB;
BEGIN
  IF val IS NULL THEN
    RETURN val;
  END IF;

  CASE jsonb_typeof(val)
    WHEN 'object' THEN
      result := '{}';
      FOR key, child IN SELECT * FROM jsonb_each(val) LOOP
        IF EXISTS (
          SELECT 1 FROM unnest(sensitive_keys) AS sk
          WHERE lower(key) LIKE '%' || sk || '%'
        ) THEN
          result := result || jsonb_build_object(key, '[REDACTED]');
        ELSE
          result := result || jsonb_build_object(key, public.sanitize_jsonb_value(child, sensitive_keys));
        END IF;
      END LOOP;
      RETURN result;

    WHEN 'array' THEN
      SELECT jsonb_agg(public.sanitize_jsonb_value(elem, sensitive_keys))
      INTO result
      FROM jsonb_array_elements(val) AS elem;
      RETURN COALESCE(result, '[]');

    ELSE
      RETURN val;
  END CASE;
END;
$$;

-- Rewrite trigger function to delegate to the recursive helper.
CREATE OR REPLACE FUNCTION public.sanitize_log_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  keys TEXT[] := ARRAY[
    'password','passwd','secret','token','api_key','apikey','api-key',
    'authorization','auth_token','access_token','refresh_token','bearer','credential',
    'private_key','secret_key','encryption_key','stripe_key','elevenlabs_api_key',
    'gemini_api_key','replicate_api_token','ssn','credit_card','card_number','cvv','cvc'
  ];
BEGIN
  IF NEW.details IS NULL THEN RETURN NEW; END IF;
  NEW.details := public.sanitize_jsonb_value(NEW.details, keys);
  RETURN NEW;
END;
$$;

-- Lock down the helper the same way as the trigger function.
REVOKE ALL ON FUNCTION public.sanitize_jsonb_value(JSONB, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sanitize_jsonb_value(JSONB, TEXT[]) TO service_role;
