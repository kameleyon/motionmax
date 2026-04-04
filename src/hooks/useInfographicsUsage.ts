import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { createScopedLogger } from "@/lib/logger";

const log = createScopedLogger("InfographicsUsage");

/**
 * Hook to track the number of infographics (SmartFlow) generated in the current month.
 *
 * `project_type` lives on the `projects` table, not `generations`, so we
 * join through the FK relationship: generations → projects.
 */
export function useInfographicsUsage() {
  const { user } = useAuth();
  const [count, setCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setIsLoading(false);
      return;
    }

    const fetchUsage = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Get first day of current month
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Join generations → projects to filter by project_type on the projects table
        const { count, error: queryError } = await supabase
          .from("generations")
          .select("*, projects!inner(project_type)", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("projects.project_type", "smartflow")
          .gte("created_at", firstDayOfMonth.toISOString());

        if (queryError) throw queryError;

        setCount(count ?? 0);
      } catch (err) {
        log.error("Error fetching infographics usage:", err);
        setError(err instanceof Error ? err.message : "Failed to load usage data");
        setCount(0);
      } finally {
        setIsLoading(false);
      }
    };

    fetchUsage();

    // Refresh count when a new generation is created for this user
    const channel = supabase
      .channel("infographics-usage")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "generations",
          filter: `user_id=eq.${user.id}`,
        },
        async () => {
          // Re-fetch the count since we can't reliably determine project_type
          // from the realtime payload (it's on the projects table, not generations)
          try {
            const now = new Date();
            const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

            const { count: freshCount } = await supabase
              .from("generations")
              .select("*, projects!inner(project_type)", { count: "exact", head: true })
              .eq("user_id", user.id)
              .eq("projects.project_type", "smartflow")
              .gte("created_at", firstDayOfMonth.toISOString());

            setCount(freshCount ?? 0);
          } catch {
            // Non-critical — count will refresh on next mount
          }
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [user?.id]);

  return { count, isLoading, error };
}
