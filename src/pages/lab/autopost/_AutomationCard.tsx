/**
 * AutomationCard — a single "pulse" tile in the My Automations grid.
 *
 * Restyled (2026-05-06) to match the Autopost Lab pulse-system design:
 *   - Flow label + serif title + status pill on top.
 *   - 14-bar sparkline of the most recent run statuses (cyan/gold/skip).
 *   - Two-cell timeline strip: LAST RUN | NEXT FIRE.
 *   - Foot row with success %, avg credits, platform glyphs.
 *   - 5-button footer rail: Run now / Edit / Topics / Schedule / Pause.
 *     A trash icon was intentionally omitted from the footer rail to
 *     keep it the 5 columns the design specified — Delete is reachable
 *     via the Edit dialog (or could be re-added by the operator if we
 *     find users want a one-click destruct). NOTE: the delete *flow*
 *     is preserved (mutation + AlertDialog) and surfaced inline as a
 *     small "del" button row below the actions strip.
 *
 * State derivation (unchanged):
 *   active=true + topic_pool has entries  → "ACTIVE" (cyan pulse)
 *   active=true + empty topic_pool        → "IDLE" (muted)
 *   active=false                           → "PAUSED" (gold)
 *
 * The "Run now" action calls the autopost_fire_now(p_schedule_id) RPC.
 * That SECURITY DEFINER function mirrors what pg_cron's autopost_tick
 * does for a single schedule: round-robin topic, resolve prompt, insert
 * an autopost_runs row + the matching video_generation_jobs(autopost_
 * render). The worker picks the render job up and walks the full
 * generation pipeline; AutopostHome's realtime subscription updates
 * Last Run / Next Run automatically.
 */

import { useState, useMemo } from "react";
import {
  Zap, Settings, Wand2, Clock, Pause, Play, Trash2, Loader2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { humanizeCron, formatRelativeTime, nextFireFromCron } from "./_utils";
import { EditAutomationDialog } from "./_EditAutomationDialog";
import { GenerateTopicsDialog } from "./_GenerateTopicsDialog";
import { UpdateScheduleDialog } from "./_UpdateScheduleDialog";
import { AUTOPOST_CREDITS_PER_RUN } from "@/lib/planLimits";
import type { AutomationSchedule } from "./_automationTypes";

interface AutomationCardProps {
  schedule: AutomationSchedule;
  /** Most-recent fired_at for this schedule, if any. */
  lastRunAt: string | null;
}

type StatusKey = "active" | "paused" | "idle";

function deriveStatus(s: AutomationSchedule): StatusKey {
  if (!s.active) return "paused";
  if (!s.topic_pool || s.topic_pool.length === 0) return "idle";
  return "active";
}

const STATUS_LABEL: Record<StatusKey, string> = {
  active: "ACTIVE",
  paused: "PAUSED",
  idle:   "IDLE",
};

const FLOW_LABEL = (s: AutomationSchedule): string => {
  const mode = (s.config_snapshot as Record<string, unknown> | null)?.mode;
  const m = typeof mode === "string" ? mode.toLowerCase() : "";
  if (m === "cinematic") return "CINEMATIC";
  if (m === "doc2video") return "EXPLAINER";
  return "SMART FLOW";
};

const PLATFORM_KEY: Record<string, "yt" | "ig" | "tt" | "x"> = {
  youtube: "yt", instagram: "ig", tiktok: "tt", x: "x", twitter: "x",
};
const PLIC: Record<"yt" | "ig" | "tt" | "x", string> = {
  yt: "plic-yt", ig: "plic-ig", tt: "plic-tt", x: "plic-x",
};
const PLATFORM_GLYPH: Record<"yt" | "ig" | "tt" | "x", string> = {
  yt: "YT", ig: "IG", tt: "TT", x: "X",
};

/** Map a target_account id list onto the 4-platform short-key set.
 *  We don't have account → platform metadata wired here, so we infer
 *  from the publish_jobs table — but for the card foot we just want
 *  *some* hint. Until we plumb a richer query, default to the 3 real
 *  publish targets when the schedule is active and has at least one
 *  account, plus X if there are 4+ accounts (heuristic).
 */
function inferPlatforms(s: AutomationSchedule): Array<"yt" | "ig" | "tt" | "x"> {
  const n = (s.target_account_ids ?? []).length;
  if (n === 0) return [];
  if (n === 1) return ["yt"];
  if (n === 2) return ["yt", "ig"];
  if (n === 3) return ["yt", "ig", "tt"];
  return ["yt", "ig", "tt", "x"];
}

/** Recent-run sparkline data per schedule.
 *
 *  We piggy-back on the existing realtime subscription in AutopostHome
 *  (no new channels here) — this query is invalidated alongside the
 *  schedules-list / last-runs queries. Returns up to 14 status values,
 *  newest LAST so the bars render left→right oldest→newest.
 */
function useScheduleSpark(scheduleId: string) {
  return useQuery<string[]>({
    queryKey: ["autopost", "schedule-spark", scheduleId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("autopost_runs")
        .select("status, fired_at")
        .eq("schedule_id", scheduleId)
        .order("fired_at", { ascending: false })
        .limit(14);
      if (error) return [];
      return ((data ?? []) as Array<{ status: string }>)
        .map(r => r.status)
        .reverse();
    },
    staleTime: 30_000,
  });
}

interface FootButton {
  key: string;
  icon: React.ComponentType<{ width?: number; height?: number }>;
  label: string;
  onClick: () => void;
  loading?: boolean;
  className?: string;
}

export function AutomationCard({ schedule, lastRunAt }: AutomationCardProps) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const status = deriveStatus(schedule);
  const sparkQuery = useScheduleSpark(schedule.id);

  const fireMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("autopost_fire_now", {
        p_schedule_id: schedule.id,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Run queued — check Run History in a moment");
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      void queryClient.invalidateQueries({ queryKey: ["autopost", "last-runs"] });
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedule-spark", schedule.id] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Run-now failed");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const next = !schedule.active;
      // Resuming a long-paused schedule used to fire one run per minute
      // until the stored next_fire_at caught up to wall-clock (a
      // catch-up storm). When unpausing, re-anchor next_fire_at to the
      // next valid cron slot strictly AFTER NOW so the schedule honors
      // its declared cadence (every hour = every hour, not 4-in-a-row
      // after a 4-hour pause). The autopost_tick SQL function applies
      // the same GREATEST(...) clamp server-side as a safety net.
      const patch: Record<string, unknown> = { active: next };
      if (next) {
        const nextFire = nextFireFromCron(
          schedule.cron_expression,
          schedule.timezone || "UTC",
          new Date(),
        );
        if (nextFire) patch.next_fire_at = nextFire.toISOString();
      }
      const { error } = await supabase
        .from("autopost_schedules")
        .update(patch)
        .eq("id", schedule.id);
      if (error) throw error;
      return next;
    },
    onSuccess: (next) => {
      toast.success(next ? "Automation resumed" : "Automation paused");
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not toggle");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("autopost_schedules")
        .delete()
        .eq("id", schedule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`"${schedule.name}" deleted`);
      setDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const cadence = useMemo(
    () => humanizeCron(schedule.cron_expression, schedule.timezone),
    [schedule.cron_expression, schedule.timezone],
  );

  const flow = FLOW_LABEL(schedule);
  const platforms = inferPlatforms(schedule);

  // Sparkline bars. We have up to 14 status values; pad with empty
  // "skip" cells on the left so the bar density stays visually
  // consistent for new schedules (one run shouldn't make the only
  // bar fill the whole strip).
  const sparkBars = useMemo(() => {
    const recent = sparkQuery.data ?? [];
    const padded: Array<"ok" | "fail" | "skip"> = [];
    const slots = 14;
    const start = Math.max(0, slots - recent.length);
    for (let i = 0; i < start; i++) padded.push("skip");
    for (const s of recent) {
      if (s === "failed" || s === "cancelled") padded.push("fail");
      else if (s === "completed" || s === "publishing" || s === "rendered" || s === "generating" || s === "queued") padded.push("ok");
      else padded.push("skip");
    }
    return padded;
  }, [sparkQuery.data]);

  // Heights are deterministic per index so they don't reflow on render.
  const sparkHeights = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < 14; i++) out.push(18 + ((i * 7) % 22));
    return out;
  }, []);

  // Success rate from same recent window (only counting non-skip).
  const successPct = useMemo(() => {
    const recent = sparkQuery.data ?? [];
    if (recent.length === 0) return null;
    const realRuns = recent.filter(s => s !== "queued" && s !== "cancelled");
    if (realRuns.length === 0) return null;
    const ok = realRuns.filter(s => s === "completed" || s === "publishing" || s === "rendered" || s === "generating").length;
    return Math.round((ok / realRuns.length) * 100);
  }, [sparkQuery.data]);

  const footButtons: FootButton[] = [
    {
      key: "run",
      icon: Zap,
      label: "Run now",
      onClick: () => fireMutation.mutate(),
      loading: fireMutation.isPending,
      className: "zap",
    },
    {
      key: "edit",
      icon: Settings,
      label: "Edit",
      onClick: () => setEditOpen(true),
    },
    {
      key: "topics",
      icon: Wand2,
      label: "Topics",
      onClick: () => setTopicsOpen(true),
    },
    {
      key: "sched",
      icon: Clock,
      label: "Schedule",
      onClick: () => setScheduleOpen(true),
    },
    {
      key: "pause",
      icon: schedule.active ? Pause : Play,
      label: schedule.active ? "Pause" : "Resume",
      onClick: () => toggleMutation.mutate(),
      loading: toggleMutation.isPending,
    },
  ];

  return (
    <>
      <div className={`pulse ${status}`}>
        <div className="pulse-h">
          <div className="ttl">
            <div className="flow">{flow}</div>
            <h3>{schedule.name}</h3>
          </div>
          <span className={`status-pill ${status}`}>{STATUS_LABEL[status]}</span>
        </div>

        <div className="spark" aria-label="recent runs">
          {sparkBars.map((kind, i) => {
            const cls = kind === "fail" ? "fail" : kind === "skip" ? "skip" : "";
            const h = kind === "skip" ? 6 : sparkHeights[i];
            return <div key={i} className={`b ${cls}`} style={{ height: `${h}px` }} />;
          })}
        </div>

        <div className="tl">
          <div className="seg">
            <div className="lb">LAST RUN</div>
            <div className="tm">
              <span className="dim">{lastRunAt ? formatRelativeTime(lastRunAt) : "—"}</span>
            </div>
          </div>
          <div className="div" />
          <div className="seg next">
            <div className="lb"><b>NEXT FIRE</b></div>
            <div className="tm cd">
              {schedule.active ? (schedule.next_fire_at ? formatRelativeTime(schedule.next_fire_at) : "—") : "Paused"}
            </div>
          </div>
        </div>

        <div className="pulse-foot">
          <div className="meta">
            {successPct !== null && (
              <>
                <span><b>{successPct}%</b> success</span>
                <span className="dot" />
              </>
            )}
            <span>{cadence}</span>
            <span className="dot" />
            <span>{AUTOPOST_CREDITS_PER_RUN} cr/run</span>
          </div>
          <div className="platforms">
            {platforms.map(p => (
              <span key={p} className={`pl-ic ${PLIC[p]}`}>{PLATFORM_GLYPH[p]}</span>
            ))}
          </div>
        </div>

        <div className="pulse-actions">
          {footButtons.map(b => {
            const Icon = b.icon;
            return (
              <button
                key={b.key}
                type="button"
                className={b.className}
                onClick={b.onClick}
                disabled={b.loading}
                aria-label={b.label}
                title={b.label}
              >
                {b.loading ? (
                  <Loader2 className="autopost-spin" width={13} height={13} />
                ) : (
                  <Icon width={13} height={13} />
                )}
                <span className="lbl">{b.label}</span>
              </button>
            );
          })}
        </div>

        {/* Inline destructive button — kept reachable but visually
            secondary to the primary 5-button rail above. */}
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            aria-label="Delete automation"
            title="Delete automation"
            style={{
              background: "transparent",
              border: 0,
              padding: "4px 8px",
              borderRadius: 6,
              color: "var(--ink-mute)",
              cursor: "pointer",
              fontFamily: "var(--mono)",
              fontSize: 9.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "#E4C875"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--ink-mute)"; }}
          >
            <Trash2 width={11} height={11} />
            Delete
          </button>
        </div>
      </div>

      <EditAutomationDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        schedule={schedule}
      />
      <GenerateTopicsDialog
        open={topicsOpen}
        onOpenChange={setTopicsOpen}
        schedule={schedule}
      />
      <UpdateScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        schedule={schedule}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#ECEAE4]">
              Delete "{schedule.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              This deletes the automation and stops all future runs. Past
              runs and already-published posts are unaffected. This action
              can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#E4C875]/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 autopost-spin" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default AutomationCard;
