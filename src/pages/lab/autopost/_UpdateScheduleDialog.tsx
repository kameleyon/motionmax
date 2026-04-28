/**
 * UpdateScheduleDialog — frequency picker + cost preview.
 *
 * Mirrors the Autonomux ScheduleDialog. Frequency is picked from the
 * shared SCHEDULE_INTERVALS list (Wave B1), each value maps to a cron
 * expression in INTERVAL_TO_CRON. On save we update both
 * `cron_expression` and recompute `next_fire_at` client-side using the
 * existing cron preview helper. The worker still re-resolves
 * `next_fire_at` via its RPC after each fire — this client value is
 * just a best-effort placeholder so the card shows a sensible countdown
 * immediately.
 *
 * "Disable" simply sets `active=false` and closes; the card flips to
 * the yellow Paused pill on the next realtime event.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Clock, CheckCircle2, Lightbulb } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  SCHEDULE_INTERVALS,
  INTERVAL_TO_CRON,
  RUNS_PER_MONTH,
  type ScheduleInterval,
} from "@/components/intake/_scheduleConstants";
import { nextFireFromCron, formatRelativeTime } from "./_utils";
import type { AutomationSchedule } from "./_automationTypes";

interface UpdateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: AutomationSchedule;
}

/** Pick the first interval whose cron equals the row's cron, falling back
 *  to "daily" when nothing matches (rows authored before B1's intake). */
function deriveCurrentInterval(cron: string): ScheduleInterval {
  for (const opt of SCHEDULE_INTERVALS) {
    if (INTERVAL_TO_CRON[opt.value] === cron) return opt.value;
  }
  return "daily";
}

export function UpdateScheduleDialog({
  open, onOpenChange, schedule,
}: UpdateScheduleDialogProps) {
  const queryClient = useQueryClient();
  const [interval, setInterval] = useState<ScheduleInterval>(
    () => deriveCurrentInterval(schedule.cron_expression),
  );

  useEffect(() => {
    if (open) setInterval(deriveCurrentInterval(schedule.cron_expression));
  }, [open, schedule.cron_expression]);

  const intervalMeta = useMemo(
    () => SCHEDULE_INTERVALS.find(o => o.value === interval),
    [interval],
  );

  // Estimated credits assume ~1 credit per second of finished video,
  // matching the rest of the dashboard's heuristic. Multiply by the
  // monthly run count for a back-of-the-napkin monthly bill.
  const monthlyCredits = useMemo(() => {
    const runs = RUNS_PER_MONTH[interval] ?? 0;
    const creditsPerRun = Math.max(1, Math.round(schedule.duration_seconds ?? 30));
    return runs * creditsPerRun;
  }, [interval, schedule.duration_seconds]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const cron = INTERVAL_TO_CRON[interval];
      const nextFire = nextFireFromCron(cron, schedule.timezone, new Date());
      const payload = {
        cron_expression: cron,
        next_fire_at: (nextFire ?? new Date(Date.now() + 60_000)).toISOString(),
        active: true,
      };
      const { error } = await supabase
        .from("autopost_schedules")
        .update(payload)
        .eq("id", schedule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Schedule updated");
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Update failed");
    },
  });

  const disableMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("autopost_schedules")
        .update({ active: false })
        .eq("id", schedule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Automation disabled");
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Disable failed");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[#ECEAE4] flex items-center gap-2">
            <Clock className="h-4 w-4 text-[#11C4D0]" />
            Update schedule
          </DialogTitle>
          <DialogDescription className="text-[#8A9198]">
            How often should this automation run?
          </DialogDescription>
        </DialogHeader>

        {schedule.active && (
          <div className="rounded-md border border-[#7BD389]/25 bg-[#7BD389]/[0.06] px-3 py-2 text-[12px] text-[#7BD389] flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              Schedule active · Running {intervalMeta?.label.toLowerCase() ?? "on cadence"} · Next run {formatRelativeTime(schedule.next_fire_at)}
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-[12px] text-[#ECEAE4]">Frequency</Label>
          <Select
            value={interval}
            onValueChange={(v) => setInterval(v as ScheduleInterval)}
          >
            <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
              {SCHEDULE_INTERVALS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="text-[#ECEAE4]">{opt.label}</span>
                  <span className="text-[#8A9198]"> — {opt.hint}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-2 text-[12px] text-[#ECEAE4] flex items-center gap-2">
          <Lightbulb className="h-3.5 w-3.5 text-[#E4C875] shrink-0" />
          <span>
            Estimated cost: <span className="font-medium">~{monthlyCredits.toLocaleString()} credits/month</span> at this frequency
          </span>
        </div>

        <DialogFooter className="gap-2 flex-col-reverse sm:flex-row">
          <Button
            variant="outline"
            onClick={() => disableMutation.mutate()}
            disabled={disableMutation.isPending || !schedule.active}
            className="border-white/10 bg-transparent text-[#8A9198] hover:bg-white/5 hover:text-[#ECEAE4]"
          >
            {disableMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Disable
          </Button>
          <Button
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
            className="bg-gradient-to-r from-[#11C4D0] to-[#E4C875] text-[#0A0D0F] hover:opacity-90"
          >
            {updateMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Update Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default UpdateScheduleDialog;
