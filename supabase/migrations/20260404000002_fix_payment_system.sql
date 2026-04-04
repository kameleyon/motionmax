-- ============================================================
-- FIX 2.2: Grant free credits on signup (10 credits)
-- Update handle_new_user() to also create user_credits row
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    safe_display_name TEXT;
BEGIN
    -- Sanitize display name
    safe_display_name := COALESCE(
        substring(NEW.raw_user_meta_data->>'full_name', 1, 100),
        split_part(NEW.email, '@', 1)
    );
    safe_display_name := regexp_replace(safe_display_name, '[^a-zA-Z0-9 ''._-]', '', 'g');

    -- Create profile
    INSERT INTO public.profiles (user_id, display_name)
    VALUES (NEW.id, safe_display_name)
    ON CONFLICT (user_id) DO NOTHING;

    -- Provision 10 free credits for new users
    INSERT INTO public.user_credits (user_id, credits_balance, total_purchased, total_used)
    VALUES (NEW.id, 10, 10, 0)
    ON CONFLICT (user_id) DO NOTHING;

    -- Log the free credit grant
    INSERT INTO public.credit_transactions (user_id, amount, transaction_type, description)
    VALUES (NEW.id, 10, 'signup_bonus', 'Welcome bonus: 10 free credits');

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- Don't block signup if credit provisioning fails
        RAISE WARNING 'handle_new_user credit provisioning failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
