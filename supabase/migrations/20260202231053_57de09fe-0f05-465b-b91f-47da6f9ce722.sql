-- Create a function to sanitize sensitive data from JSONB logs
CREATE OR REPLACE FUNCTION public.sanitize_log_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sanitized_details JSONB;
  sensitive_keys TEXT[] := ARRAY[
    'password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'apikey', 
    'api-key', 'authorization', 'auth_token', 'access_token', 'refresh_token',
    'bearer', 'credential', 'private_key', 'privatekey', 'secret_key', 
    'secretkey', 'encryption_key', 'stripe_key', 'elevenlabs_api_key',
    'openai_key', 'gemini_api_key', 'replicate_api_token', 'ssn', 
    'credit_card', 'card_number', 'cvv', 'cvc'
  ];
  key_pattern TEXT;
BEGIN
  -- If details is null, nothing to sanitize
  IF NEW.details IS NULL THEN
    RETURN NEW;
  END IF;

  sanitized_details := NEW.details;

  -- Recursively sanitize known sensitive keys (case-insensitive)
  FOREACH key_pattern IN ARRAY sensitive_keys
  LOOP
    -- Replace values of sensitive keys with [REDACTED]
    sanitized_details := (
      SELECT COALESCE(
        jsonb_object_agg(
          key,
          CASE 
            WHEN lower(key) LIKE '%' || key_pattern || '%' THEN '"[REDACTED]"'::jsonb
            WHEN jsonb_typeof(value) = 'object' THEN (
              SELECT COALESCE(
                jsonb_object_agg(
                  k2,
                  CASE 
                    WHEN lower(k2) LIKE '%' || key_pattern || '%' THEN '"[REDACTED]"'::jsonb
                    ELSE v2
                  END
                ),
                '{}'::jsonb
              )
              FROM jsonb_each(value) AS nested(k2, v2)
            )
            ELSE value
          END
        ),
        '{}'::jsonb
      )
      FROM jsonb_each(sanitized_details)
    );
  END LOOP;

  -- Sanitize string values that look like API keys or tokens (patterns)
  sanitized_details := (
    SELECT COALESCE(
      jsonb_object_agg(
        key,
        CASE 
          -- Stripe keys (sk_live_, sk_test_, pk_live_, pk_test_)
          WHEN jsonb_typeof(value) = 'string' AND (
            value::text ~ '^"sk_(live|test)_[a-zA-Z0-9]+"$' OR
            value::text ~ '^"pk_(live|test)_[a-zA-Z0-9]+"$'
          ) THEN '"[REDACTED_STRIPE_KEY]"'::jsonb
          -- Bearer tokens
          WHEN jsonb_typeof(value) = 'string' AND 
            value::text ~* '^"bearer\s+[a-zA-Z0-9._-]+"$' 
          THEN '"[REDACTED_BEARER_TOKEN]"'::jsonb
          -- JWT tokens (has 3 parts separated by dots)
          WHEN jsonb_typeof(value) = 'string' AND 
            value::text ~ '^"eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+"$'
          THEN '"[REDACTED_JWT]"'::jsonb
          -- Generic API key patterns (32+ chars alphanumeric)
          WHEN jsonb_typeof(value) = 'string' AND 
            length(value::text) > 40 AND
            value::text ~ '^"[a-zA-Z0-9_-]{32,}"$'
          THEN '"[REDACTED_API_KEY]"'::jsonb
          ELSE value
        END
      ),
      '{}'::jsonb
    )
    FROM jsonb_each(sanitized_details)
  );

  NEW.details := sanitized_details;
  RETURN NEW;
END;
$$;

-- Create trigger on system_logs table
DROP TRIGGER IF EXISTS sanitize_system_logs_trigger ON public.system_logs;
CREATE TRIGGER sanitize_system_logs_trigger
  BEFORE INSERT OR UPDATE ON public.system_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_log_details();

-- Add comment for documentation
COMMENT ON FUNCTION public.sanitize_log_details() IS 
  'Sanitizes sensitive data (API keys, tokens, passwords, credentials) from JSONB log details before storage';