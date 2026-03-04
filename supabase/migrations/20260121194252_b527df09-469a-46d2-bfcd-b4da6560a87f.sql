-- Fix 1: Make source_uploads bucket private
UPDATE storage.buckets 
SET public = false 
WHERE id = 'source_uploads';

-- Fix 2: Update handle_new_user function with input validation and sanitization
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    safe_display_name TEXT;
BEGIN
    -- Sanitize and validate display name with length limit
    safe_display_name := COALESCE(
        substring(NEW.raw_user_meta_data->>'full_name', 1, 100),
        split_part(NEW.email, '@', 1)
    );
    
    -- Remove potentially dangerous characters (keep only safe alphanumeric, spaces, and common punctuation)
    safe_display_name := regexp_replace(safe_display_name, '[^a-zA-Z0-9 ''._-]', '', 'g');
    
    -- Ensure we have at least something for display name
    IF safe_display_name IS NULL OR length(trim(safe_display_name)) = 0 THEN
        safe_display_name := 'User';
    END IF;
    
    -- Trim to final safe value
    safe_display_name := trim(safe_display_name);
    
    -- Insert with exception handling to prevent blocking user creation
    BEGIN
        INSERT INTO public.profiles (user_id, display_name)
        VALUES (NEW.id, safe_display_name);
    EXCEPTION WHEN OTHERS THEN
        -- Log the error but don't fail user creation
        RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
    END;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;