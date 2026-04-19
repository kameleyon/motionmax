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

  useEffect(() => {
    const checkAdminStatus = async () => {
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
    };

    checkAdminStatus();
  }, [user, authLoading]);

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