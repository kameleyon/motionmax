import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Hook to fetch generation logs from system_logs in real-time.
 * Works for ALL users (not admin-only), polls while generating.
 */
export function useGenerationLogs(
  generationId: string | null | undefined,
  projectId: string | null | undefined,
  isGenerating: boolean
) {
  const [logs, setLogs] = useState<any[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!generationId && !projectId) return;

    let query = supabase
      .from("system_logs")
      .select("id,created_at,message,category,event_type")
      .order("created_at", { ascending: false })
      .limit(100);

    if (generationId) {
      query = query.eq("generation_id", generationId);
    } else if (projectId) {
      query = query.eq("project_id", projectId);
    }

    const { data } = await query;
    if (data) setLogs(data);
  }, [generationId, projectId]);

  // Poll while generating, fetch once on complete/error
  useEffect(() => {
    if (!generationId && !projectId) return;

    fetchLogs();

    if (isGenerating) {
      intervalRef.current = setInterval(fetchLogs, 5000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
  }, [generationId, projectId, isGenerating, fetchLogs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { logs, showLogs, setShowLogs };
}
