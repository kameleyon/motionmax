/**
 * Schedule wizard — `/lab/autopost/schedules/new`
 *
 * Four-step flow that builds a `ScheduleDraft` and inserts a row into
 * `autopost_schedules` on save. The shared step components live in
 * `_ScheduleForm.tsx` so the edit page can reuse them verbatim.
 *
 * Step gating uses the `validateStepN` helpers — each "Next" press
 * runs the matching validator before advancing. Save runs every
 * validator one more time so a user who arrowed back never bypasses
 * a check.
 *
 * `next_fire_at` is computed client-side as a *seed value*; the
 * worker's `autopost_advance_next_fire` RPC takes over from the next
 * pg_cron tick onward.
 */

import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Calendar, Check, Loader2, Send, Wand2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { LabLayout } from "../_LabLayout";
import {
  EMPTY_DRAFT,
  Step1WhatToMake,
  Step2When,
  Step3Where,
  Step4Review,
  fetchPickerAccounts,
  validateStep1,
  validateStep2,
  validateStep3,
  validateAll,
  type AccountForPicker,
  type ScheduleDraft,
} from "./_ScheduleForm";
import { nextFireFromCron } from "./_utils";
import { useQuery } from "@tanstack/react-query";

interface StepDef {
  id: 1 | 2 | 3 | 4;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepDef[] = [
  { id: 1, title: "What to make", blurb: "Prompt template, topic pool, motion, duration.", icon: Wand2 },
  { id: 2, title: "When", blurb: "Cadence, time of day, timezone — preview the next fires.", icon: Calendar },
  { id: 3, title: "Where", blurb: "Pick accounts, write captions, set hashtags.", icon: Send },
  { id: 4, title: "Review", blurb: "Confirm everything, then save as draft or activate.", icon: Check },
];

function topicArrayFromTextarea(t: string): string[] | null {
  const parts = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 ? null : parts;
}

function buildInsertPayload(
  draft: ScheduleDraft,
  userId: string,
  active: boolean,
): Record<string, unknown> {
  const next = nextFireFromCron(draft.cron_expression, draft.timezone, new Date());
  const next_fire_at = (next ?? new Date()).toISOString();

  // We persist a single combined caption for now. Per-platform fields
  // are kept in the draft so future schema additions (e.g. caption_yt
  // / caption_ig / caption_tt) can drop in without rebuilding the UI.
  const combinedCaption =
    [
      draft.caption_youtube ? `[YouTube]\n${draft.caption_youtube}` : "",
      draft.caption_instagram ? `[Instagram]\n${draft.caption_instagram}` : "",
      draft.caption_tiktok ? `[TikTok]\n${draft.caption_tiktok}` : "",
    ]
      .filter(Boolean)
      .join("\n\n") || null;

  return {
    user_id: userId,
    name: draft.name.trim(),
    active,
    prompt_template: draft.prompt_template.trim(),
    topic_pool: topicArrayFromTextarea(draft.topic_pool),
    motion_preset: draft.motion_preset === "random" ? null : draft.motion_preset,
    duration_seconds: draft.duration_seconds,
    resolution: draft.resolution,
    cron_expression: draft.cron_expression,
    timezone: draft.timezone,
    next_fire_at,
    target_account_ids: draft.target_account_ids,
    caption_template: combinedCaption,
    hashtags: draft.hashtags.length > 0 ? draft.hashtags : null,
    ai_disclosure: draft.ai_disclosure,
  };
}

export default function ScheduleWizard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [draft, setDraft] = useState<ScheduleDraft>(EMPTY_DRAFT);

  const accountsQuery = useQuery({
    queryKey: ["autopost-accounts-picker"],
    queryFn: fetchPickerAccounts,
  });
  const accountsLookup: Record<string, AccountForPicker> = {};
  for (const a of accountsQuery.data ?? []) accountsLookup[a.id] = a;

  const onChange = (patch: Partial<ScheduleDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  const goBack = () => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3 | 4) : s));
  const goNext = () => {
    if (step === 1) {
      const v = validateStep1(draft);
      if (!v.ok) return toast.error(v.error || "Fix step 1 first");
    } else if (step === 2) {
      const v = validateStep2(draft);
      if (!v.ok) return toast.error(v.error || "Fix step 2 first");
    } else if (step === 3) {
      const v = validateStep3(draft);
      if (!v.ok) return toast.error(v.error || "Fix step 3 first");
    }
    setStep((s) => (s < 4 ? ((s + 1) as 1 | 2 | 3 | 4) : s));
  };

  const saveMutation = useMutation({
    mutationFn: async (active: boolean) => {
      if (!user?.id) throw new Error("Not signed in");
      const v = validateAll(draft);
      if (!v.ok) throw new Error(v.error || "Validation failed");
      const payload = buildInsertPayload(draft, user.id, active);
      const { error } = await supabase.from("autopost_schedules").insert(payload);
      if (error) throw error;
    },
    onSuccess: (_data, active) => {
      toast.success(active ? "Schedule activated" : "Saved as draft");
      navigate("/lab/autopost/schedules");
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save failed");
    },
  });

  const current = STEPS.find((s) => s.id === step) ?? STEPS[0];
  const Icon = current.icon;
  const saving = saveMutation.isPending;

  return (
    <LabLayout
      heading="New schedule"
      title="New schedule · Autopost · Lab"
      description="Walk through four steps to create a recurring autopost schedule."
      breadcrumbs={[
        { label: "Autopost", to: "/lab/autopost" },
        { label: "Schedules", to: "/lab/autopost/schedules" },
        { label: "New" },
      ]}
    >
      <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>

      {/* Step indicator */}
      <ol className="mb-6 grid grid-cols-4 gap-2 sm:gap-3" aria-label="Wizard progress">
        {STEPS.map((s) => {
          const isActive = s.id === step;
          const isDone = s.id < step;
          return (
            <li key={s.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setStep(s.id)}
                className={cn(
                  "w-full flex flex-col items-start gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                  "sm:px-3 sm:py-2.5",
                  isActive
                    ? "border-[#11C4D0]/50 bg-[#11C4D0]/10"
                    : isDone
                    ? "border-[#11C4D0]/20 bg-[#11C4D0]/5"
                    : "border-white/8 bg-[#10151A] hover:border-white/15",
                )}
                aria-current={isActive ? "step" : undefined}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-mono",
                      isActive
                        ? "bg-[#11C4D0] text-[#0A0D0F]"
                        : isDone
                        ? "bg-[#11C4D0]/30 text-[#11C4D0]"
                        : "bg-white/8 text-[#8A9198]",
                    )}
                  >
                    {isDone ? <Check className="h-3 w-3" /> : s.id}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[10px] tracking-[0.16em] uppercase",
                      isActive ? "text-[#11C4D0]" : "text-[#5A6268]",
                    )}
                  >
                    Step {s.id}
                  </span>
                </div>
                <span
                  className={cn(
                    "truncate text-[12px] sm:text-[13px]",
                    isActive ? "text-[#ECEAE4]" : "text-[#8A9198]",
                  )}
                >
                  {s.title}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <Card className="bg-[#10151A] border-white/8">
        <CardHeader className="border-b border-white/8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#11C4D0]/10">
              <Icon className="h-5 w-5 text-[#11C4D0]" />
            </div>
            <div>
              <CardTitle className="text-[#ECEAE4] text-base">{current.title}</CardTitle>
              <CardDescription className="text-[#8A9198] mt-0.5">
                {current.blurb}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="py-6">
          {step === 1 && <Step1WhatToMake draft={draft} onChange={onChange} />}
          {step === 2 && <Step2When draft={draft} onChange={onChange} />}
          {step === 3 && <Step3Where draft={draft} onChange={onChange} />}
          {step === 4 && <Step4Review draft={draft} accountsLookup={accountsLookup} />}
        </CardContent>
      </Card>

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={goBack}
          disabled={step === 1 || saving}
          className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5 disabled:opacity-40"
        >
          <ArrowLeft className="h-4 w-4 mr-1.5" />
          Back
        </Button>

        {step < 4 ? (
          <Button
            type="button"
            onClick={goNext}
            className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
          >
            Next
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        ) : (
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
              variant="outline"
              onClick={() => saveMutation.mutate(false)}
              disabled={saving}
              className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
            >
              {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Save as draft
            </Button>
            <Button
              type="button"
              onClick={() => saveMutation.mutate(true)}
              disabled={saving}
              className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
            >
              {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Save & activate
            </Button>
          </div>
        )}
      </div>
    </LabLayout>
  );
}
