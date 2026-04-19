-- RPC for admin dashboard to read real emails from auth.users.
-- SECURITY DEFINER + postgres ownership grants access to auth schema.
-- The is_admin check ensures only admins can invoke it.
CREATE OR REPLACE FUNCTION public.admin_get_user_emails(user_ids uuid[])
RETURNS TABLE(user_id uuid, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT u.id, u.email
  FROM auth.users u
  WHERE u.id = ANY(user_ids)
    AND public.is_admin(auth.uid())
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_user_emails(uuid[]) TO authenticated;
