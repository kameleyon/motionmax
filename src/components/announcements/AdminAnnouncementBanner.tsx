/**
 * AdminAnnouncementBanner — slim sticky bar at the top of every authenticated
 * surface that surfaces the most-relevant active announcement created by an
 * admin via Admin → Announcements.
 *
 * Data flow:
 *   - Calls `current_announcements_for_me()` (RPC defined in
 *     20260505240000_admin_phase11_17_rpcs.sql) which returns active
 *     announcement rows excluding ones the current user has already
 *     dismissed via `dismiss_announcement`.
 *   - Picks the highest-priority row (RPC sorts: critical → warn → feature
 *     → info, then created_at desc), so a critical incident notice always
 *     wins over a feature highlight.
 *   - Realtime channel on `announcements` invalidates the query so a new
 *     announcement surfaces within the realtime roundtrip.
 *
 * Dismissal:
 *   - Persists to `localStorage` keyed by announcement id so the banner
 *     stays hidden across page reloads (the same row may also be ignored
 *     server-side via dismiss_announcement, but localStorage gives us the
 *     immediate-hide UX without waiting for the RPC roundtrip).
 *   - Calls dismiss_announcement so the row is hidden on this user's
 *     other devices via the RPC's NOT EXISTS predicate.
 *
 * Theme: aqua + gold only (per docs/feedback_motionmax_theme_colors.md).
 *   - info / feature  → cyan accent (#14C8CC)
 *   - warn / critical → gold accent (#F5B049)
 *   - No red, no green.
 *
 * Mounted from `AppShell.tsx` at the topBanner slot. Composes with any
 * page-level topBanner so the existing pattern is preserved.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

type Severity = "info" | "warn" | "critical" | "feature";

interface AnnouncementRow {
  id: string;
  title: string;
  body_md: string;
  severity: Severity;
  cta_label: string | null;
  cta_url: string | null;
  audience: Record<string, unknown> | null;
  starts_at: string;
  ends_at: string | null;
  active: boolean;
  created_at: string;
}

const DISMISS_PREFIX = "mm_announce_dismissed:";

function isLocalDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

function setLocalDismissed(id: string): void {
  try {
    window.localStorage.setItem(DISMISS_PREFIX + id, "1");
  } catch {
    /* localStorage may be disabled (Safari private mode); fail-soft. */
  }
}

function severityAccent(s: Severity): { bg: string; text: string; dot: string; border: string } {
  // Aqua = info / feature (low-stakes notices). Gold = warn / critical
  // (high-attention). Stays inside the aqua/gold/neutral palette.
  if (s === "warn" || s === "critical") {
    return {
      bg: "linear-gradient(90deg,rgba(245,176,73,.16),rgba(245,176,73,.04))",
      text: "#FFD18C",
      dot: "#F5B049",
      border: "rgba(245,176,73,.3)",
    };
  }
  return {
    bg: "linear-gradient(90deg,rgba(20,200,204,.14),rgba(20,200,204,.02))",
    text: "#9FE3E6",
    dot: "#14C8CC",
    border: "rgba(20,200,204,.3)",
  };
}

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

async function fetchActiveForMe(): Promise<AnnouncementRow[]> {
  const { data, error } = await rpc<AnnouncementRow[]>("current_announcements_for_me");
  if (error) {
    // Don't toast — banner failures shouldn't pollute the user's UI. The
    // worst case is a missed announcement, which is recoverable.
    console.warn("[AdminAnnouncementBanner] current_announcements_for_me failed:", error.message);
    return [];
  }
  return data ?? [];
}

export default function AdminAnnouncementBanner() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());

  const enabled = !!user?.id;

  const query = useQuery({
    queryKey: ["announcements", "current", user?.id ?? "anon"],
    queryFn: fetchActiveForMe,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Realtime: any insert/update/delete on `announcements` re-runs the RPC.
  // RLS gates the channel to only emit rows the user can read, but we
  // refetch the RPC anyway because it filters dismissals + audience.
  useEffect(() => {
    if (!enabled) return;
    const channel = supabase
      .channel(`announcements-banner:${user?.id ?? "anon"}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "announcements" },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["announcements", "current"] });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [enabled, queryClient, user?.id]);

  const candidate = useMemo<AnnouncementRow | null>(() => {
    const rows = query.data ?? [];
    for (const r of rows) {
      if (hiddenIds.has(r.id)) continue;
      if (isLocalDismissed(r.id)) continue;
      return r;
    }
    return null;
  }, [query.data, hiddenIds]);

  if (!candidate) return null;

  const { bg, text, dot, border } = severityAccent(candidate.severity);

  const handleDismiss = (): void => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.add(candidate.id);
      return next;
    });
    setLocalDismissed(candidate.id);
    // Server-side dismissal: persists across devices. Fire-and-forget; the
    // local hide already gave the user an immediate response.
    void rpc<{ id: string; dismissed: boolean }>("dismiss_announcement", { p_id: candidate.id }).catch(() => {
      /* non-fatal — localStorage hide is enough for this session */
    });
  };

  return (
    <div
      role="region"
      aria-label="Admin announcement"
      style={{
        background: bg,
        borderBottom: `1px solid ${border}`,
        color: text,
        padding: "8px 18px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        fontFamily: "Inter, system-ui, sans-serif",
        lineHeight: 1.45,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: dot,
          boxShadow: `0 0 0 3px ${dot}33`,
          flexShrink: 0,
        }}
      />
      <strong style={{ color: "#ECEAE4", fontWeight: 500 }}>{candidate.title}</strong>
      <span style={{ color: "#B5BCC2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {candidate.body_md}
      </span>
      <span style={{ flex: 1 }} />
      {candidate.cta_url && (
        <a
          href={candidate.cta_url}
          target={candidate.cta_url.startsWith("http") ? "_blank" : undefined}
          rel="noreferrer noopener"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: dot,
            textDecoration: "none",
            padding: "4px 10px",
            borderRadius: 6,
            border: `1px solid ${border}`,
            background: "rgba(0,0,0,.15)",
            flexShrink: 0,
          }}
        >
          {candidate.cta_label ?? "Read more"} →
        </a>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss announcement"
        style={{
          background: "transparent",
          border: 0,
          color: "#8A9198",
          cursor: "pointer",
          padding: 4,
          lineHeight: 0,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
