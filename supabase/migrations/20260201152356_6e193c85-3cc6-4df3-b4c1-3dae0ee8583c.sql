-- Create app_role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

-- Create user_roles table
CREATE TABLE public.user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    role app_role NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (user_id, role)
);

-- Enable RLS
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Force RLS for all users including table owner
ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;

-- Create security definer function to check roles (prevents RLS recursion)
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Create function to check if user is admin
CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = 'admin'
  )
$$;

-- RLS Policies for user_roles
CREATE POLICY "Admins can view all roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can insert roles"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Admins can update roles"
ON public.user_roles
FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can delete roles"
ON public.user_roles
FOR DELETE
TO authenticated
USING (public.is_admin(auth.uid()));

-- Deny anonymous access
CREATE POLICY "Deny anonymous access to user_roles"
ON public.user_roles
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

-- Create user_flags table for flagging/suspending users
CREATE TABLE public.user_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    flag_type TEXT NOT NULL CHECK (flag_type IN ('warning', 'flagged', 'suspended', 'banned')),
    reason TEXT NOT NULL,
    details TEXT,
    flagged_by UUID NOT NULL,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolved_by UUID,
    resolution_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on user_flags
ALTER TABLE public.user_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_flags FORCE ROW LEVEL SECURITY;

-- RLS Policies for user_flags (admin only)
CREATE POLICY "Admins can view all flags"
ON public.user_flags
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can create flags"
ON public.user_flags
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Admins can update flags"
ON public.user_flags
FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can delete flags"
ON public.user_flags
FOR DELETE
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Deny anonymous access to user_flags"
ON public.user_flags
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

-- Create admin_logs table for audit trail
CREATE TABLE public.admin_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID,
    details JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on admin_logs
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_logs FORCE ROW LEVEL SECURITY;

-- RLS Policies for admin_logs
CREATE POLICY "Admins can view all logs"
ON public.admin_logs
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Admins can insert logs"
ON public.admin_logs
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Deny anonymous access to admin_logs"
ON public.admin_logs
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

-- Add triggers for updated_at
CREATE TRIGGER update_user_roles_updated_at
BEFORE UPDATE ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_user_flags_updated_at
BEFORE UPDATE ON public.user_flags
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create generation_archives table to track deleted generations
CREATE TABLE public.generation_archives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_id UUID NOT NULL,
    project_id UUID NOT NULL,
    user_id UUID NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    scenes JSONB,
    script TEXT,
    audio_url TEXT,
    video_url TEXT,
    error_message TEXT,
    original_created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    original_completed_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on generation_archives
ALTER TABLE public.generation_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_archives FORCE ROW LEVEL SECURITY;

-- RLS Policies for generation_archives (admin only for viewing, service role for insert)
CREATE POLICY "Admins can view all archives"
ON public.generation_archives
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));

CREATE POLICY "Deny anonymous access to generation_archives"
ON public.generation_archives
FOR ALL
TO anon
USING (false)
WITH CHECK (false);