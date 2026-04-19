-- RPC for admin dashboard to resolve an email address to a user UUID.
-- SECURITY DEFINER + postgres ownership grants access to auth schema.
-- The is_admin check ensures only admins can invoke it.
CREATE OR REPLACE FUNCTION public.admin_get_user_id_by_email(email_param text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT u.id
  FROM auth.users u
  WHERE lower(u.email) = lower(email_param)
    AND public.is_admin(auth.uid())
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_user_id_by_email(text) TO authenticated;
