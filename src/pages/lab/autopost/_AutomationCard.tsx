/**
 * AutomationCard — single row in the My Automations stack.
 *
 * Mirrors the Autonomux "automation card" pattern: schedule name + status
 * pill on top, action icon row below, then a 4-col details grid (Schedule
 * / Next Run / Last Run / Credits/Run). Each icon button opens its own
 * inline modal (Edit / Generate Topics / Update Schedule) — no separate
 * page navigation needed.
 *
 * State derivation:
 *   active=true + topic_pool has entries  → green "Active"
 *   active=true + empty topic_pool        → gray "Out of topics"
 *   active=false (and any topic state)    → yellow "Paused"
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
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

interface StatusMeta {
  label: string;
  className: string;
}

function deriveStatus(s: AutomationSchedule): StatusKey {
  if (!s.active) return "paused";
  if (!s.topic_pool || s.topic_pool.length === 0) return "idle";
  return "active";
}

const STATUS_META: Record<StatusKey, StatusMeta> = {
  active: {
    label: "Active",
    className:
      "bg-[#11C4D0]/10 border-[#11C4D0]/30 text-[#11C4D0] hover:bg-[#11C4D0]/15",
  },
  paused: {
    label: "Paused",
    className:
      "bg-[#E4C875]/10 border-[#E4C875]/30 text-[#E4C875] hover:bg-[#E4C875]/15",
  },
  idle: {
    label: "Out of topics",
    className:
      "bg-white/5 border-white/15 text-[#8A9198] hover:bg-white/10",
  },
};

/**
 * Credits-per-run estimate. Autopost charges a flat
 * AUTOPOST_CREDITS_PER_RUN (=45) per run regardless of mode/length —
 * mirrors the SQL `autopost_credits_required(mode,length)` deduction.
 */
function estimateCredits(_s: AutomationSchedule): string {
  return `${AUTOPOST_CREDITS_PER_RUN} cr`;
}

/**
 * Counts down to next_fire_at. We rely on the formatRelativeTime helper
 * which already handles future ("in X") and past ("X ago") framings; the
 * card just renders whatever it produces.
 */
function countdown(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatRelativeTime(iso);
}

interface IconButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  /** Cyan-tinted only fires for the active/selected state — the action
   *  the operator most-likely wants right now (e.g. "Run now"). All
   *  other icons default to the muted-ink convention. */
  active?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  active,
  destructive,
  disabled,
  loading,
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled || loading}
          onClick={onClick}
          className={cn(
            // Default: muted-ink, hover→ink (matches Dashboard convention).
            "h-8 w-8 text-[#5A6268] hover:bg-white/5 hover:text-[#ECEAE4]",
            active && "text-[#11C4D0] hover:text-[#11C4D0] hover:bg-[#11C4D0]/10",
            destructive && "hover:text-[#E4C875] hover:bg-[#E4C875]/10",
          )}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 autopost-spin" />
          ) : (
            <Icon className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="bg-[#10151A] border-white/10 text-[#ECEAE4] text-[12px]"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-[#5A6268]">
        {label}
      </div>
      <div className="text-[#ECEAE4] truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

export function AutomationCard({ schedule, lastRunAt }: AutomationCardProps) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const status = deriveStatus(schedule);
  const statusMeta = STATUS_META[status];

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

  // Surface the project flow this schedule was created with.
  // config_snapshot.mode is the canonical key (set by IntakeForm) —
  // values are 'cinematic' | 'doc2video' | 'smartflow'. Default to
  // smartflow for legacy rows that pre-date the snapshot column.
  const flowLabel = useMemo(() => {
    const mode = (schedule.config_snapshot as Record<string, unknown> | null)?.mode;
    const m = typeof mode === "string" ? mode.toLowerCase() : "";
    if (m === "cinematic") return "Cinematic";
    if (m === "doc2video") return "Explainer";
    return "Smart Flow";
  }, [schedule.config_snapshot]);

  return (
    <TooltipProvider>
      <Card className="bg-[#10151A] border-white/8 hover:border-white/12 transition-colors">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-white/70 leading-none mb-1">
                {flowLabel}
              </div>
              <h3
                className="font-serif font-medium text-[18px] leading-tight text-[#ECEAE4] truncate"
                style={{ fontFamily: 'Fraunces, Georgia, serif' }}
              >
                {schedule.name}
              </h3>
            </div>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-[10px] uppercase tracking-wide border",
                statusMeta.className,
              )}
            >
              {statusMeta.label}
            </Badge>
          </div>

          <div className="flex items-center gap-1 -ml-1">
            <IconButton
              icon={Zap}
              label="Run now"
              active
              onClick={() => fireMutation.mutate()}
              loading={fireMutation.isPending}
            />
            <IconButton
              icon={Settings}
              label="Edit instructions"
              onClick={() => setEditOpen(true)}
            />
            <IconButton
              icon={Wand2}
              label="Generate more topics"
              onClick={() => setTopicsOpen(true)}
            />
            <IconButton
              icon={Clock}
              label="Update schedule"
              onClick={() => setScheduleOpen(true)}
            />
            <IconButton
              icon={schedule.active ? Pause : Play}
              label={schedule.active ? "Pause" : "Resume"}
              onClick={() => toggleMutation.mutate()}
              loading={toggleMutation.isPending}
            />
            <IconButton
              icon={Trash2}
              label="Delete"
              destructive
              onClick={() => setDeleteOpen(true)}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px] pt-1 border-t border-white/8">
            <Field label="Schedule" value={cadence} />
            <Field label="Next Run" value={countdown(schedule.next_fire_at)} />
            <Field label="Last Run" value={lastRunAt ? formatRelativeTime(lastRunAt) : "—"} />
            <Field label="Credits/Run" value={estimateCredits(schedule)} />
          </div>
        </CardContent>
      </Card>

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
    </TooltipProvider>
  );
}

export default AutomationCard;
