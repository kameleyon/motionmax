import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

/**
 * Hook to track the number of infographics (SmartFlow) generated in the current month
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

        // Query generations table for smartflow projects created this month
        const { count, error: queryError } = await supabase
          .from("generations")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id)
          .eq("project_type", "smartflow")
          .gte("created_at", firstDayOfMonth.toISOString());

        if (queryError) throw queryError;

        setCount(count ?? 0);
      } catch (err) {
        console.error("Error fetching infographics usage:", err);
        setError(err instanceof Error ? err.message : "Failed to load usage data");
        setCount(0);
      } finally {
        setIsLoading(false);
      }
    };

    fetchUsage();

    // Refresh count when a new generation is created
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
        (payload) => {
          if (payload.new && (payload.new as { project_type: string }).project_type === "smartflow") {
            setCount((prev) => prev + 1);
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
