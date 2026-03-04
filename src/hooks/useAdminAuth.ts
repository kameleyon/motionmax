import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

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
        console.error("Error checking admin status:", err);
        setIsAdmin(false);
      } finally {
        setLoading(false);
      }
    };

    checkAdminStatus();
  }, [user, authLoading]);

  // Stable callback that won't change between renders
  const callAdminApi = useCallback(async (action: string, params?: Record<string, unknown>) => {
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    if (!freshSession) {
      throw new Error("Not authenticated");
    }

    const { data, error } = await supabase.functions.invoke("admin-stats", {
      body: { action, params },
    });

    if (error) {
      throw new Error(error.message || "Admin API error");
    }

    return data;
  }, []); // Empty deps = stable reference

  return {
    isAdmin,
    loading,
    callAdminApi,
    user,
  };
}