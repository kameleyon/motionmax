import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { adminDirectQuery } from "@/lib/adminDirectQueries";

const LOG = "[useAdminAuth]";

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

  // Primary: direct DB queries (no edge function dependency).
  // Fallback: edge function if direct queries fail (e.g., missing RLS policies).
  const callAdminApi = useCallback(async (action: string, params?: Record<string, unknown>) => {
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    if (!freshSession) throw new Error("Not authenticated");

    // Try direct DB queries first — faster and no edge function dependency
    try {
      const result = await adminDirectQuery(action, params);
      return result;
    } catch (dbErr) {
      console.warn(LOG, `Direct query failed for "${action}":`, (dbErr as Error).message);
    }

    // Fallback: edge function (if deployed)
    try {
      const { data, error } = await supabase.functions.invoke("admin-stats", {
        body: { action, params },
      });
      if (error) throw new Error(error.message || "Admin API error");
      return data;
    } catch (edgeErr) {
      console.error(LOG, `Edge function also failed for "${action}":`, (edgeErr as Error).message);
      throw new Error(`Admin query failed: ${(edgeErr as Error).message}`);
    }
  }, []);

  return {
    isAdmin,
    loading,
    callAdminApi,
    user,
  };
}