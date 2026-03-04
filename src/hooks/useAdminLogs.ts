import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAdminAuth } from "@/hooks/useAdminAuth";

/**
 * Shared hook to fetch admin-visible generation logs for both success and error states.
 */
export function useAdminLogs(generationId: string | null, step: string) {
  const { isAdmin } = useAdminAuth();
  const [adminLogs, setAdminLogs] = useState<any[]>([]);
  const [showAdminLogs, setShowAdminLogs] = useState(false);

  const fetchAdminLogs = useCallback(async (genId: string) => {
    if (!isAdmin) return;
    const { data } = await supabase
      .from("system_logs")
      .select("*")
      .eq("generation_id", genId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setAdminLogs(data);
  }, [isAdmin]);

  // Fetch logs on both success AND error
  useEffect(() => {
    if (isAdmin && generationId && (step === "complete" || step === "error")) {
      fetchAdminLogs(generationId);
    }
  }, [isAdmin, generationId, step, fetchAdminLogs]);

  return { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs };
}
