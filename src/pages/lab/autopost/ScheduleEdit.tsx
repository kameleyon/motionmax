/**
 * Schedule edit — `/lab/autopost/schedules/:id`
 *
 * Same field set as the wizard but rendered as four stacked Cards on
 * one screen so power-users can scan and tweak without re-traversing
 * a wizard. Fires a single `update` on save and a hard `delete` (with
 * confirm) on the trash icon.
 *
 * The "Generate test video now" button calls `/api/autopost/schedules/:id/fire`,
 * which Wave 2a built. We pass the user's Supabase JWT so `requireAdmin`
 * can validate the request server-side.
 */

import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Calendar, Loader2, Send, Trash2, Wand2, Zap } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { LabLayout } from "../_LabLayout";
import {
  Step1WhatToMake,
  Step2When,
  Step3Where,
  fetchPickerAccounts,
  validateAll,
  type AccountForPicker,
  type ScheduleDraft,
} from "./_ScheduleForm";
import { CADENCE_PRESETS, nextFireFromCron, parseCron } from "./_utils";

interface DbSchedule {
  id: string;
  user_id: string;
  name: string;
  active: boolean;
  prompt_template: string;
  topic_pool: string[] | null;
  motion_preset: string | null;
  duration_seconds: number;
  resolution: string;
  cron_expression: string;
  timezone: string;
  next_fire_at: string;
  target_account_ids: string[];
  caption_template: string | null;
  hashtags: string[] | null;
  ai_disclosure: boolean;
  created_at: string;
  updated_at: string;
}

async function fetchSchedule(id: string): Promise<DbSchedule | null> {
  const { data, error } = await supabase
    .from("autopost_schedules")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as DbSchedule | null;
}

function dbToDraft(row: DbSchedule): ScheduleDraft {
  // Reverse the wizard's combined-caption format so per-platform fields
  // show up populated. If the user wrote a single caption (no [Platform]
  // header) we treat it as a YouTube default.
  const captions = { youtube: "", instagram: "", tiktok: "" };
  const tpl = row.caption_template ?? "";
  if (tpl) {
    const sections = tpl.split(/\n\n(?=\[(?:YouTube|Instagram|TikTok)\])/);
    let matchedAny = false;
    for (const section of sections) {
      const m = section.match(/^\[(YouTube|Instagram|TikTok)\]\n([\s\S]*)$/);
      if (m) {
        matchedAny = true;
        const platform = m[1].toLowerCase() as keyof typeof captions;
        captions[platform] = m[2];
      }
    }
    if (!matchedAny) captions.youtube = tpl;
  }

  // Recover cadence preset + time-of-day for the chip UI.
  let cadencePreset = "custom";
  for (const preset of CADENCE_PRESETS) {
    if (!preset.cron) continue;
    const presetParsed = parseCron(preset.cron);
    const rowParsed = parseCron(row.cron_expression);
    if (
      presetParsed && rowParsed &&
      presetParsed.dom === rowParsed.dom &&
      presetParsed.month === rowParsed.month &&
      presetParsed.dow === rowParsed.dow
    ) {
      cadencePreset = preset.id;
      break;
    }
  }
  const parsed = parseCron(row.cron_expression);
  const timeOfDay = parsed && /^\d+$/.test(parsed.hour) && /^\d+$/.test(parsed.minute)
    ? `${parsed.hour.padStart(2, "0")}:${parsed.minute.padStart(2, "0")}`
    : "09:00";

  return {
    name: row.name,
    prompt_template: row.prompt_template,
    topic_pool: (row.topic_pool ?? []).join("\n"),
    motion_preset: row.motion_preset ?? "random",
    duration_seconds: row.duration_seconds,
    resolution: (row.resolution === "1920x1080" ? "1920x1080" : "1080x1920"),
    cron_expression: row.cron_expression,
    cadence_preset: cadencePreset,
    time_of_day: timeOfDay,
    timezone: row.timezone,
    target_account_ids: row.target_account_ids,
    caption_youtube: captions.youtube,
    caption_instagram: captions.instagram,
    caption_tiktok: captions.tiktok,
    hashtags: row.hashtags ?? [],
    ai_disclosure: row.ai_disclosure,
  };
}

function draftToUpdate(draft: ScheduleDraft): Record<string, unknown> {
  const next = nextFireFromCron(draft.cron_expression, draft.timezone, new Date());
  const combinedCaption =
    [
      draft.caption_youtube ? `[YouTube]\n${draft.caption_youtube}` : "",
      draft.caption_instagram ? `[Instagram]\n${draft.caption_instagram}` : "",
      draft.caption_tiktok ? `[TikTok]\n${draft.caption_tiktok}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || null;
  return {
    name: draft.name.trim(),
    prompt_template: draft.prompt_template.trim(),
    topic_pool: draft.topic_pool
      ? draft.topic_pool.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : null,
    motion_preset: draft.motion_preset === "random" ? null : draft.motion_preset,
    duration_seconds: draft.duration_seconds,
    resolution: draft.resolution,
    cron_expression: draft.cron_expression,
    timezone: draft.timezone,
    next_fire_at: (next ?? new Date()).toISOString(),
    target_account_ids: draft.target_account_ids,
    caption_template: combinedCaption,
    hashtags: draft.hashtags.length > 0 ? draft.hashtags : null,
    ai_disclosure: draft.ai_disclosure,
  };
}

async function getJwt(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function ScheduleEdit() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const scheduleQuery = useQuery({
    queryKey: ["autopost-schedule", id],
    queryFn: () => fetchSchedule(id),
    enabled: Boolean(id),
  });

  const accountsQuery = useQuery({
    queryKey: ["autopost-accounts-picker"],
    queryFn: fetchPickerAccounts,
  });

  const [draft, setDraft] = useState<ScheduleDraft | null>(null);

  useEffect(() => {
    if (scheduleQuery.data && !draft) {
      setDraft(dbToDraft(scheduleQuery.data));
    }
  }, [scheduleQuery.data, draft]);

  const onChange = (patch: Partial<ScheduleDraft>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Nothing to save");
      const v = validateAll(draft);
      if (!v.ok) throw new Error(v.error || "Validation failed");
      const { error } = await supabase
        .from("autopost_schedules")
        .update(draftToUpdate(draft))
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Schedule updated");
      void queryClient.invalidateQueries({ queryKey: ["autopost-schedule", id] });
      void queryClient.invalidateQueries({ queryKey: ["autopost-schedules"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("autopost_schedules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Schedule deleted");
      void queryClient.invalidateQueries({ queryKey: ["autopost-schedules"] });
      navigate("/lab/autopost/schedules");
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    },
  });

  const fireMutation = useMutation({
    mutationFn: async () => {
      const jwt = await getJwt();
      if (!jwt) throw new Error("Not signed in");
      const res = await fetch(`/api/autopost/schedules/${id}/fire`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Fire failed (${res.status})`);
      }
    },
    onSuccess: () => {
      toast.success("Test fire enqueued — check Run History in a moment");
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Test fire failed");
    },
  });

  const accountsLookup: Record<string, AccountForPicker> = {};
  for (const a of accountsQuery.data ?? []) accountsLookup[a.id] = a;

  const shortId = id ? `${id.slice(0, 8)}…` : "—";

  if (scheduleQuery.isLoading) {
    return (
      <LabLayout
        heading="Edit schedule"
        breadcrumbs={[
          { label: "Autopost", to: "/lab/autopost" },
          { label: "Schedules", to: "/lab/autopost/schedules" },
          { label: shortId },
        ]}
      >
        <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>
        <div className="space-y-4">
          <Skeleton className="h-32 w-full bg-white/5" />
          <Skeleton className="h-64 w-full bg-white/5" />
          <Skeleton className="h-64 w-full bg-white/5" />
        </div>
      </LabLayout>
    );
  }

  if (!scheduleQuery.data || !draft) {
    return (
      <LabLayout
        heading="Schedule not found"
        breadcrumbs={[
          { label: "Autopost", to: "/lab/autopost" },
          { label: "Schedules", to: "/lab/autopost/schedules" },
          { label: shortId },
        ]}
      >
        <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-12 flex flex-col items-center text-center gap-3">
            <p className="text-[14px] text-[#ECEAE4]">No schedule with that ID.</p>
            <p className="text-[12px] text-[#8A9198]">It may have been deleted, or you don't have access.</p>
            <Button asChild variant="outline" className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              <Link to="/lab/autopost/schedules">
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Back to schedules
              </Link>
            </Button>
          </CardContent>
        </Card>
      </LabLayout>
    );
  }

  const saving = saveMutation.isPending;
  const firing = fireMutation.isPending;
  const deleting = deleteMutation.isPending;

  return (
    <LabLayout
      heading="Edit schedule"
      title={`${draft.name || "Edit schedule"} · Autopost · Lab`}
      description="Update an existing schedule's prompt, cadence, or target accounts."
      breadcrumbs={[
        { label: "Autopost", to: "/lab/autopost" },
        { label: "Schedules", to: "/lab/autopost/schedules" },
        { label: draft.name || shortId },
      ]}
      actions={
        <Button
          type="button"
          onClick={() => fireMutation.mutate()}
          disabled={firing}
          className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#E4C875]/90"
        >
          {firing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Zap className="h-4 w-4 mr-1.5" />}
          Generate test video
        </Button>
      }
    >
      <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>

      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              scheduleQuery.data.active
                ? "border-[#11C4D0]/30 bg-[#11C4D0]/10 text-[#11C4D0]"
                : "border-white/10 bg-white/5 text-[#8A9198]"
            }
          >
            {scheduleQuery.data.active ? "Active" : "Paused"}
          </Badge>
          <span className="text-[11px] text-[#5A6268] font-mono">ID {shortId}</span>
        </div>
      </div>

      <div className="space-y-5">
        <Card className="bg-[#10151A] border-white/8">
          <CardHeader className="border-b border-white/8">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
                <Wand2 className="h-5 w-5 text-[#11C4D0]" />
              </div>
              <div>
                <CardTitle className="text-[#ECEAE4] text-base">What to make</CardTitle>
                <CardDescription className="text-[#8A9198] mt-0.5">
                  Prompt template, topic pool, motion, duration.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="py-6">
            <Step1WhatToMake draft={draft} onChange={onChange} />
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8">
          <CardHeader className="border-b border-white/8">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
                <Calendar className="h-5 w-5 text-[#11C4D0]" />
              </div>
              <div>
                <CardTitle className="text-[#ECEAE4] text-base">When</CardTitle>
                <CardDescription className="text-[#8A9198] mt-0.5">
                  Cadence, time of day, timezone — preview the next fires.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="py-6">
            <Step2When draft={draft} onChange={onChange} />
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8">
          <CardHeader className="border-b border-white/8">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
                <Send className="h-5 w-5 text-[#11C4D0]" />
              </div>
              <div>
                <CardTitle className="text-[#ECEAE4] text-base">Where</CardTitle>
                <CardDescription className="text-[#8A9198] mt-0.5">
                  Pick accounts, write captions, set hashtags.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="py-6">
            <Step3Where draft={draft} onChange={onChange} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete schedule
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{draft.name}"?</AlertDialogTitle>
              <AlertDialogDescription className="text-[#8A9198]">
                Removes the schedule and stops future fires. Past runs and already-published posts stay intact.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate()}
                className="bg-red-500 text-white hover:bg-red-500/90"
              >
                {deleting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          <Button
            asChild
            variant="outline"
            className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
            disabled={saving}
          >
            <Link to="/lab/autopost/schedules">Cancel</Link>
          </Button>
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={saving}
            className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
          >
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Save changes
          </Button>
        </div>
      </div>
    </LabLayout>
  );
}
