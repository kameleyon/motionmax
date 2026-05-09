import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { adminDirectQuery } from "@/lib/adminDirectQueries";
import { createScopedLogger } from "@/lib/logger";

const log = createScopedLogger("AdminAuth");

export function useAdminAuth() {
  const { user, session, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  // Phase 18.5 — admin check lifted out of useEffect so the focus /
   // visibility listeners can call it without a nested closure that
   // captures stale `user` / `authLoading`.
  const checkAdminStatus = useCallback(async () => {
    if (!user || authLoading) {
      setIsAdmin(false);
      setLoading(authLoading);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();

      if (error) {
        setIsAdmin(false);
      } else {
        setIsAdmin(!!data);
      }
    } catch (err) {
      log.error("Error checking admin status:", err);
      setIsAdmin(false);
    } finally {
      setLoading(false);
    }
  }, [user, authLoading]);

  useEffect(() => {
    checkAdminStatus();
  }, [checkAdminStatus]);

  // Phase 18.5 — revalidate on focus / visibility change. If a user's
  // admin role is revoked while their tab is in the background, the
  // next focus event flips `isAdmin` to false within ~1s of return.
  // Without this, a stale isAdmin=true persists until next full page
  // load. One DB hit per focus event — not a polling loop.
  useEffect(() => {
    if (!user || authLoading) return;
    const onFocus = () => { void checkAdminStatus(); };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void checkAdminStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, authLoading, checkAdminStatus]);

  const callAdminApi = useCallback(async (action: string, params?: Record<string, unknown>) => {
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    if (!freshSession) throw new Error("Not authenticated");

    return adminDirectQuery(action, params);
  }, []);

  return {
    isAdmin,
    loading,
    callAdminApi,
    user,
  };
}