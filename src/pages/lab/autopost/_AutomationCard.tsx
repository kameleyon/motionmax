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
 * The "Run now" action POSTs to /api/autopost/schedules/{id}/fire which
 * inserts a queued autopost_runs row; the worker dispatcher picks it up
 * on the next tick. Realtime invalidation in AutopostHome refreshes
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
import { humanizeCron, formatRelativeTime } from "./_utils";
import { EditAutomationDialog } from "./_EditAutomationDialog";
import { GenerateTopicsDialog } from "./_GenerateTopicsDialog";
import { UpdateScheduleDialog } from "./_UpdateScheduleDialog";
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
      "bg-[#7BD389]/10 border-[#7BD389]/30 text-[#7BD389] hover:bg-[#7BD389]/15",
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
 * Rough credits-per-run estimate. The render side of the pipeline scales
 * roughly linearly with duration; ~1 credit per second of finished video
 * is the heuristic the rest of the app uses for budgeting.
 */
function estimateCredits(s: AutomationSchedule): string {
  const seconds = s.duration_seconds ?? 30;
  return `~${Math.max(1, Math.round(seconds))} cr`;
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

async function getJwt(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

interface IconButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  amber?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  amber,
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
            "h-8 w-8 text-[#8A9198] hover:bg-white/5 hover:text-[#ECEAE4]",
            amber && "text-[#E4C875] hover:text-[#E4C875] hover:bg-[#E4C875]/10",
            destructive && "hover:text-[#F47272] hover:bg-[#F47272]/10",
          )}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
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
      const jwt = await getJwt();
      if (!jwt) throw new Error("Not signed in");
      // No request body — do NOT send `content-type: application/json`
      // (otherwise Vercel's runtime spins up a JSON body parser for an
      // empty payload and the function 500s before our handler runs).
      const res = await fetch(
        `/api/autopost/schedules/${schedule.id}/fire`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: "application/json",
          },
        },
      );
      if (!res.ok) {
        // Read as text first; the body may be Vercel's HTML error page
        // (FUNCTION_INVOCATION_FAILED etc.) rather than our JSON.
        // Surfacing a snippet beats showing "Fire failed (500)".
        const raw = await res.text().catch(() => "");
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        // Some error fields end up as nested objects (Postgres errors,
        // Supabase auth errors), so coerce to string and skip
        // "[object Object]" before falling back.
        const stringy = (v: unknown): string => {
          if (typeof v === "string") return v;
          if (v && typeof v === "object") {
            try { return JSON.stringify(v); } catch { return ""; }
          }
          return "";
        };
        const detail =
          stringy(parsed.message)
          || stringy(parsed.error)
          || raw.slice(0, 200).trim()
          || res.statusText
          || "unknown error";
        throw new Error(`Fire failed (${res.status}): ${detail}`);
      }
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
      const { error } = await supabase
        .from("autopost_schedules")
        .update({ active: next })
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

  return (
    <TooltipProvider>
      <Card className="bg-[#10151A] border-white/8 hover:border-white/12 transition-colors">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="font-semibold text-[14px] text-[#ECEAE4] truncate">
                {schedule.name}
              </h3>
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
          </div>

          <div className="flex items-center gap-1 -ml-1">
            <IconButton
              icon={Zap}
              label="Run now"
              amber
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
              className="bg-[#F47272] text-[#0A0D0F] hover:bg-[#F47272]/90"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
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
