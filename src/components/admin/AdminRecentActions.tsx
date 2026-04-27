import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type AdminLogRow = {
  id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: string;
  details: Record<string, unknown> | null;
};

/**
 * Pill in the admin header showing the last 3 admin_logs entries by the
 * currently signed-in admin. Lets an admin recall what they just did
 * without opening AdminLogs. Clicking expands to show the full last-3
 * list with timestamps.
 *
 * Refreshes on a 30s interval — fast enough that a just-taken action
 * appears within half a minute, slow enough that the header doesn't
 * flicker. Uses postgres_changes realtime where possible.
 */
export function AdminRecentActions() {
  const { user } = useAuth();
  const [recent, setRecent] = useState<AdminLogRow[]>([]);

  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("admin_logs")
        .select("id, action, target_type, target_id, created_at, details")
        .eq("admin_id", user.id)
        .order("created_at", { ascending: false })
        .limit(3);
      if (!cancelled) setRecent((data ?? []) as AdminLogRow[]);
    };

    load();
    const tick = setInterval(load, 30_000);

    // Also subscribe to realtime so newly-written admin_logs rows by
    // *this admin* appear immediately. We filter client-side rather than
    // server-side because postgres_changes has limited filter syntax.
    const channel = supabase
      .channel("admin-recent-actions")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_logs" },
        (payload) => {
          const row = payload.new as AdminLogRow & { admin_id?: string };
          if (row.admin_id !== user.id) return;
          setRecent((prev) => [row, ...prev].slice(0, 3));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(tick);
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  if (recent.length === 0) return null;

  const last = recent[0];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="hidden md:flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5 transition-colors"
          aria-label="Recent admin actions"
        >
          <Clock className="h-3 w-3" />
          <span className="font-mono uppercase tracking-wide">{last.action.replace(/_/g, " ")}</span>
          <span className="text-[10px] text-[#5A6268]">
            {formatDistanceToNow(new Date(last.created_at), { addSuffix: false })}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="end">
        <p className="text-[11px] font-mono tracking-[0.14em] uppercase text-muted-foreground px-2 pt-1 pb-2">
          Your recent actions
        </p>
        <div className="space-y-1">
          {recent.map((r) => (
            <div key={r.id} className="px-2 py-1.5 rounded text-xs hover:bg-muted/40">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium capitalize">{r.action.replace(/_/g, " ")}</span>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </span>
              </div>
              {(r.target_type || r.target_id) && (
                <div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
                  {r.target_type ?? "?"} · {r.target_id ? r.target_id.slice(0, 12) + "…" : "—"}
                </div>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
