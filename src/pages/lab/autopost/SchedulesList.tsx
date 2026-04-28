/**
 * Schedule list — `/lab/autopost/schedules`
 *
 * Table of all autopost schedules owned by the current admin (RLS).
 * Above 768 px we render a compact data table; below it the rows
 * collapse into stacked Cards so the iPhone view stays usable.
 *
 * Mutations:
 *   - Toggle Active   → `update autopost_schedules set active = ?`
 *   - Delete          → `delete from autopost_schedules where id = ?`
 *   - Duplicate       → insert a copy with " (copy)" suffix and active=false
 *
 * The fetch joins the schedule's `target_account_ids` to
 * `autopost_social_accounts` so we can render a per-row icon stack of
 * the platforms it actually publishes to.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Calendar, Plus, MoreHorizontal, Edit, Copy, Trash2, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { LabLayout } from "../_LabLayout";
import { humanizeCron, formatRelativeTime, platformIcon, type AutopostPlatform } from "./_utils";

interface ScheduleRow {
  id: string;
  name: string;
  active: boolean;
  cron_expression: string;
  timezone: string;
  next_fire_at: string;
  target_account_ids: string[];
  prompt_template: string;
  topic_pool: string[] | null;
  motion_preset: string | null;
  duration_seconds: number;
  resolution: string;
  caption_template: string | null;
  hashtags: string[] | null;
  ai_disclosure: boolean;
  user_id: string;
  created_at: string;
  updated_at: string;
}

interface AccountStub {
  id: string;
  platform: AutopostPlatform;
}

interface RunStub {
  schedule_id: string;
  fired_at: string;
}

async function fetchSchedules(): Promise<ScheduleRow[]> {
  const { data, error } = await supabase
    .from("autopost_schedules")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ScheduleRow[];
}

async function fetchAccountPlatforms(): Promise<Record<string, AutopostPlatform>> {
  const { data, error } = await supabase
    .from("autopost_social_accounts")
    .select("id, platform");
  if (error) throw error;
  const out: Record<string, AutopostPlatform> = {};
  for (const a of (data ?? []) as AccountStub[]) out[a.id] = a.platform;
  return out;
}

async function fetchLastRuns(): Promise<Record<string, string>> {
  // Most-recent fire per schedule. RLS gates rows; small dataset, so a
  // single non-aggregated select is fine.
  const { data, error } = await supabase
    .from("autopost_runs")
    .select("schedule_id, fired_at")
    .order("fired_at", { ascending: false })
    .limit(500);
  if (error) return {};
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as RunStub[]) {
    if (!out[row.schedule_id]) out[row.schedule_id] = row.fired_at;
  }
  return out;
}

function PlatformStack({ accountIds, lookup }: { accountIds: string[]; lookup: Record<string, AutopostPlatform> }) {
  const platforms = useMemo(() => {
    const set = new Set<AutopostPlatform>();
    for (const id of accountIds) {
      const p = lookup[id];
      if (p) set.add(p);
    }
    return Array.from(set);
  }, [accountIds, lookup]);

  if (platforms.length === 0) {
    return <span className="text-[12px] text-[#5A6268]">—</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {platforms.map((p) => (
        <span
          key={p}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#11C4D0]/10 text-[#11C4D0]"
          title={p}
        >
          {platformIcon(p, "h-3.5 w-3.5")}
        </span>
      ))}
    </div>
  );
}

function RowActions({
  schedule,
  onDuplicate,
  onDeleteClick,
}: {
  schedule: ScheduleRow;
  onDuplicate: (s: ScheduleRow) => void;
  onDeleteClick: (s: ScheduleRow) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-[#10151A] border-white/10 text-[#ECEAE4]"
      >
        <DropdownMenuItem asChild className="cursor-pointer focus:bg-white/5">
          <Link to={`/lab/autopost/schedules/${schedule.id}`}>
            <Edit className="h-3.5 w-3.5 mr-2" />
            Edit
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDuplicate(schedule)} className="cursor-pointer focus:bg-white/5">
          <Copy className="h-3.5 w-3.5 mr-2" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-white/8" />
        <DropdownMenuItem
          onClick={() => onDeleteClick(schedule)}
          className="cursor-pointer text-red-400 focus:bg-red-500/10 focus:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function SchedulesList() {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<ScheduleRow | null>(null);

  const schedulesQuery = useQuery({ queryKey: ["autopost-schedules"], queryFn: fetchSchedules });
  const platformsQuery = useQuery({ queryKey: ["autopost-account-platforms"], queryFn: fetchAccountPlatforms });
  const lastRunsQuery = useQuery({ queryKey: ["autopost-last-runs"], queryFn: fetchLastRuns });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from("autopost_schedules")
        .update({ active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.active ? "Schedule activated" : "Schedule paused");
      void queryClient.invalidateQueries({ queryKey: ["autopost-schedules"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Toggle failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("autopost_schedules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Schedule deleted");
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["autopost-schedules"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async (src: ScheduleRow) => {
      const { error } = await supabase.from("autopost_schedules").insert({
        user_id: src.user_id,
        name: `${src.name} (copy)`,
        active: false,
        prompt_template: src.prompt_template,
        topic_pool: src.topic_pool,
        motion_preset: src.motion_preset,
        duration_seconds: src.duration_seconds,
        resolution: src.resolution,
        cron_expression: src.cron_expression,
        timezone: src.timezone,
        next_fire_at: src.next_fire_at,
        target_account_ids: src.target_account_ids,
        caption_template: src.caption_template,
        hashtags: src.hashtags,
        ai_disclosure: src.ai_disclosure,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Schedule duplicated");
      void queryClient.invalidateQueries({ queryKey: ["autopost-schedules"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Duplicate failed");
    },
  });

  const schedules = schedulesQuery.data ?? [];
  const platformLookup = platformsQuery.data ?? {};
  const lastRuns = lastRunsQuery.data ?? {};
  const isLoading = schedulesQuery.isLoading;

  const newScheduleBtn = (
    <Button asChild className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90">
      <Link to="/lab/autopost/schedules/new">
        <Plus className="h-4 w-4 mr-1.5" />
        New schedule
      </Link>
    </Button>
  );

  return (
    <LabLayout
      heading="Schedules"
      title="Schedules · Autopost · Lab"
      description="Recurring generation cadences. Each schedule fires on cron, picks a topic, renders a video, and publishes to its target accounts."
      breadcrumbs={[
        { label: "Autopost", to: "/lab/autopost" },
        { label: "Schedules" },
      ]}
      actions={newScheduleBtn}
    >
      <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>

      {isLoading ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-6 space-y-3">
            <Skeleton className="h-10 w-full bg-white/5" />
            <Skeleton className="h-10 w-full bg-white/5" />
            <Skeleton className="h-10 w-full bg-white/5" />
          </CardContent>
        </Card>
      ) : schedules.length === 0 ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-12 sm:py-16">
            <div className="flex flex-col items-center text-center max-w-md mx-auto space-y-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#11C4D0]/10">
                <Calendar className="h-7 w-7 text-[#11C4D0]" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-serif text-xl text-[#ECEAE4]">No schedules yet</h2>
                <p className="text-[13px] text-[#8A9198] leading-relaxed">
                  Schedules generate and publish videos to your connected accounts on a cadence.
                </p>
              </div>
              {newScheduleBtn}
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Mobile-only stacked cards */}
          <div className="md:hidden space-y-3">
            {schedules.map((s) => (
              <Card key={s.id} className="bg-[#10151A] border-white/8">
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      to={`/lab/autopost/schedules/${s.id}`}
                      className="font-medium text-[14px] text-[#ECEAE4] hover:text-[#11C4D0] truncate min-w-0"
                    >
                      {s.name}
                    </Link>
                    <RowActions
                      schedule={s}
                      onDuplicate={(row) => duplicateMutation.mutate(row)}
                      onDeleteClick={(row) => setPendingDelete(row)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[12px]">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[#5A6268]">Cadence</div>
                      <div className="text-[#ECEAE4] truncate">{humanizeCron(s.cron_expression, s.timezone)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[#5A6268]">Platforms</div>
                      <PlatformStack accountIds={s.target_account_ids} lookup={platformLookup} />
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[#5A6268]">Next fire</div>
                      <div className="text-[#ECEAE4]">{formatRelativeTime(s.next_fire_at)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[#5A6268]">Last fire</div>
                      <div className="text-[#ECEAE4]">{formatRelativeTime(lastRuns[s.id] ?? null)}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-1 border-t border-white/8">
                    <span className="text-[11px] text-[#8A9198]">{s.active ? "Active" : "Paused"}</span>
                    <Switch
                      checked={s.active}
                      disabled={toggleMutation.isPending && toggleMutation.variables?.id === s.id}
                      onCheckedChange={(checked) => toggleMutation.mutate({ id: s.id, active: checked })}
                      aria-label={s.active ? "Pause schedule" : "Activate schedule"}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Desktop table */}
          <Card className="hidden md:block bg-[#10151A] border-white/8 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-white/8 hover:bg-transparent">
                  <TableHead className="text-[#8A9198]">Name</TableHead>
                  <TableHead className="text-[#8A9198]">Cadence</TableHead>
                  <TableHead className="text-[#8A9198]">Platforms</TableHead>
                  <TableHead className="text-[#8A9198]">Active</TableHead>
                  <TableHead className="text-[#8A9198]">Next fire</TableHead>
                  <TableHead className="text-[#8A9198]">Last fire</TableHead>
                  <TableHead className="w-[44px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => {
                  const isToggling = toggleMutation.isPending && toggleMutation.variables?.id === s.id;
                  return (
                    <TableRow key={s.id} className="border-white/8 hover:bg-white/[0.02]">
                      <TableCell>
                        <Link
                          to={`/lab/autopost/schedules/${s.id}`}
                          className="text-[#ECEAE4] hover:text-[#11C4D0] font-medium"
                        >
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-[#ECEAE4] text-[13px]">
                        {humanizeCron(s.cron_expression, s.timezone)}
                      </TableCell>
                      <TableCell>
                        <PlatformStack accountIds={s.target_account_ids} lookup={platformLookup} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={s.active}
                            disabled={isToggling}
                            onCheckedChange={(checked) => toggleMutation.mutate({ id: s.id, active: checked })}
                            aria-label={s.active ? "Pause schedule" : "Activate schedule"}
                          />
                          {isToggling && <Loader2 className="h-3 w-3 animate-spin text-[#11C4D0]" />}
                        </div>
                      </TableCell>
                      <TableCell className="text-[#ECEAE4] text-[13px]">
                        {formatRelativeTime(s.next_fire_at)}
                      </TableCell>
                      <TableCell className="text-[#ECEAE4] text-[13px]">
                        {formatRelativeTime(lastRuns[s.id] ?? null)}
                      </TableCell>
                      <TableCell>
                        <RowActions
                          schedule={s}
                          onDuplicate={(row) => duplicateMutation.mutate(row)}
                          onDeleteClick={(row) => setPendingDelete(row)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              This deletes the schedule and stops all future fires. Past runs and already-published
              posts are unaffected. This action can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
              disabled={deleteMutation.isPending}
              className="bg-red-500 text-white hover:bg-red-500/90"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mobile new-schedule CTA — sticky-ish bottom button so the
          actions slot is reachable without the desktop header. */}
      <div className="sm:hidden mt-4 flex justify-end">
        {newScheduleBtn}
      </div>
    </LabLayout>
  );
}
