/**
 * Shared schedule form fields — used by both ScheduleWizard (4-step
 * progressive flow) and ScheduleEdit (all-on-one-screen form).
 *
 * Each `<StepN>` component is a self-contained block that reads from
 * and writes to a shared `ScheduleDraft`. Validation lives in the
 * parent so the wizard can gate progression and the edit page can do
 * a single pre-save check.
 *
 * The "where" picker only renders accounts the admin has actually
 * connected on `/lab/autopost/connect`. Empty-state nudges them back
 * there with a Link.
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { Info, Cable, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import {
  CADENCE_PRESETS,
  CAPTION_LIMITS,
  MOTION_PRESETS,
  PLATFORM_LABEL,
  TIMEZONES,
  humanizeCron,
  nextNFiresFromCron,
  platformIcon,
  timeOfDayOptions,
  validateCron,
  withTimeOfDay,
  type AutopostPlatform,
} from "./_utils";

export interface ScheduleDraft {
  name: string;
  prompt_template: string;
  topic_pool: string;            // textarea, one-per-line; serialized on save
  motion_preset: string;          // "random" maps to null on save
  duration_seconds: number;
  resolution: "1080x1920" | "1920x1080";
  cron_expression: string;
  cadence_preset: string;         // ui-only; tracks active chip
  time_of_day: string;            // "HH:MM" 30-min slots
  timezone: string;
  target_account_ids: string[];
  caption_youtube: string;
  caption_instagram: string;
  caption_tiktok: string;
  hashtags: string[];
  ai_disclosure: boolean;
}

export const EMPTY_DRAFT: ScheduleDraft = {
  name: "",
  prompt_template: "",
  topic_pool: "",
  motion_preset: "random",
  duration_seconds: 30,
  resolution: "1080x1920",
  cron_expression: "0 9 * * *",
  cadence_preset: "daily",
  time_of_day: "09:00",
  timezone: "America/New_York",
  target_account_ids: [],
  caption_youtube: "",
  caption_instagram: "",
  caption_tiktok: "",
  hashtags: [],
  ai_disclosure: true,
};

export interface AccountForPicker {
  id: string;
  platform: AutopostPlatform;
  display_name: string;
  avatar_url: string | null;
  status: string;
}

export async function fetchPickerAccounts(): Promise<AccountForPicker[]> {
  const { data, error } = await supabase
    .from("autopost_social_accounts")
    .select("id, platform, display_name, avatar_url, status")
    .order("platform", { ascending: true })
    .order("display_name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AccountForPicker[];
}

/* Validation helpers shared with the wizard. */
export interface StepValidation {
  ok: boolean;
  error?: string;
}

export function validateStep1(draft: ScheduleDraft): StepValidation {
  if (!draft.name.trim()) return { ok: false, error: "Schedule name is required" };
  if (!draft.prompt_template.trim()) return { ok: false, error: "Prompt template is required" };
  if (draft.duration_seconds < 5 || draft.duration_seconds > 90) {
    return { ok: false, error: "Duration must be 5–90 seconds" };
  }
  return { ok: true };
}

export function validateStep2(draft: ScheduleDraft): StepValidation {
  const v = validateCron(draft.cron_expression);
  if (!v.valid) return { ok: false, error: v.error };
  // Confirm cron actually fires within the next 30 days.
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const fires = nextNFiresFromCron(draft.cron_expression, draft.timezone, 1, now);
  if (!fires.length || fires[0] > horizon) {
    return { ok: false, error: "This cron expression will not fire in the next 30 days" };
  }
  return { ok: true };
}

export function validateStep3(draft: ScheduleDraft): StepValidation {
  if (draft.target_account_ids.length === 0) {
    return { ok: false, error: "Select at least one account to publish to" };
  }
  return { ok: true };
}

export function validateAll(draft: ScheduleDraft): StepValidation {
  const s1 = validateStep1(draft);
  if (!s1.ok) return s1;
  const s2 = validateStep2(draft);
  if (!s2.ok) return s2;
  const s3 = validateStep3(draft);
  if (!s3.ok) return s3;
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────── */
/* Step 1 — What to make                                           */
/* ────────────────────────────────────────────────────────────── */

interface StepProps {
  draft: ScheduleDraft;
  onChange: (patch: Partial<ScheduleDraft>) => void;
}

const inputCx =
  "bg-black/30 border-white/10 text-[#ECEAE4] placeholder:text-[#5A6268] focus-visible:ring-[#11C4D0]/40";
const labelCx = "block text-[12px] font-medium text-[#ECEAE4]";
const helpCx = "mt-1 text-[11px] text-[#5A6268]";

export function Step1WhatToMake({ draft, onChange }: StepProps) {
  return (
    <div className="space-y-5">
      <div>
        <label htmlFor="sched-name" className={labelCx}>
          Schedule name <span className="text-red-400">*</span>
        </label>
        <Input
          id="sched-name"
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Daily motivation shorts"
          className={cn(inputCx, "mt-1.5")}
        />
        <p className={helpCx}>Internal label only — never shown on social posts.</p>
      </div>

      <div>
        <label htmlFor="sched-prompt" className={labelCx}>
          Prompt template <span className="text-red-400">*</span>
        </label>
        <Textarea
          id="sched-prompt"
          rows={3}
          value={draft.prompt_template}
          onChange={(e) => onChange({ prompt_template: e.target.value })}
          placeholder={`e.g. "{day} motivation: {topic}"`}
          className={cn(inputCx, "mt-1.5 resize-y")}
        />
        <p className={helpCx}>
          Variables: <code className="text-[#11C4D0]">{`{day}`}</code>,{" "}
          <code className="text-[#11C4D0]">{`{topic}`}</code>,{" "}
          <code className="text-[#11C4D0]">{`{date}`}</code>.
        </p>
      </div>

      <div>
        <label htmlFor="sched-topics" className={labelCx}>
          Topic pool
        </label>
        <Textarea
          id="sched-topics"
          rows={4}
          value={draft.topic_pool}
          onChange={(e) => onChange({ topic_pool: e.target.value })}
          placeholder={"discipline\nresilience\ngratitude\nfocus"}
          className={cn(inputCx, "mt-1.5 resize-y font-mono text-[12px]")}
        />
        <p className={helpCx}>One topic per line. Each fire picks one at random.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCx}>Motion preset</label>
          <Select value={draft.motion_preset} onValueChange={(v) => onChange({ motion_preset: v })}>
            <SelectTrigger className={cn(inputCx, "mt-1.5")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
              {MOTION_PRESETS.map((m) => (
                <SelectItem key={m.value} value={m.value} className="focus:bg-white/5">
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className={labelCx}>Resolution</label>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {[
              { v: "1080x1920", label: "9:16 Vertical", sub: "1080×1920" },
              { v: "1920x1080", label: "16:9 Horizontal", sub: "1920×1080" },
            ].map((r) => (
              <button
                key={r.v}
                type="button"
                onClick={() => onChange({ resolution: r.v as ScheduleDraft["resolution"] })}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition-colors",
                  draft.resolution === r.v
                    ? "border-[#11C4D0]/50 bg-[#11C4D0]/10"
                    : "border-white/10 bg-black/30 hover:border-white/20",
                )}
              >
                <div className="text-[12px] font-medium text-[#ECEAE4]">{r.label}</div>
                <div className="text-[10px] text-[#5A6268]">{r.sub}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className={labelCx}>Duration</label>
          <span className="text-[12px] font-mono text-[#11C4D0]">{draft.duration_seconds}s</span>
        </div>
        <Slider
          min={5}
          max={90}
          step={5}
          value={[draft.duration_seconds]}
          onValueChange={(vals) => onChange({ duration_seconds: vals[0] ?? 30 })}
          className="mt-3"
        />
        <div className="mt-1 flex justify-between text-[10px] text-[#5A6268]">
          <span>5s</span>
          <span>90s</span>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Step 2 — When                                                    */
/* ────────────────────────────────────────────────────────────── */

export function Step2When({ draft, onChange }: StepProps) {
  const { time_of_day, timezone, cron_expression, cadence_preset } = draft;
  const cronValid = validateCron(cron_expression);
  const fires = cronValid.valid ? nextNFiresFromCron(cron_expression, timezone, 5) : [];
  const horizon30d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const noFireSoon = cronValid.valid && (fires.length === 0 || fires[0] > horizon30d);

  const handlePreset = (presetId: string) => {
    const preset = CADENCE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    if (presetId === "custom") {
      onChange({ cadence_preset: "custom" });
      return;
    }
    onChange({
      cadence_preset: presetId,
      cron_expression: withTimeOfDay(preset.cron, time_of_day),
    });
  };

  const handleTimeChange = (newTime: string) => {
    if (cadence_preset === "custom") {
      onChange({ time_of_day: newTime, cron_expression: withTimeOfDay(cron_expression, newTime) });
    } else {
      const preset = CADENCE_PRESETS.find((p) => p.id === cadence_preset);
      const base = preset?.cron || cron_expression;
      onChange({ time_of_day: newTime, cron_expression: withTimeOfDay(base, newTime) });
    }
  };

  const tzAwareFormat = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <label className={labelCx}>Cadence</label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {CADENCE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handlePreset(p.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-[12px] transition-colors",
                cadence_preset === p.id
                  ? "border-[#11C4D0]/50 bg-[#11C4D0]/15 text-[#11C4D0]"
                  : "border-white/10 bg-black/30 text-[#8A9198] hover:border-white/20 hover:text-[#ECEAE4]",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {cadence_preset === "custom" && (
        <div>
          <label htmlFor="sched-cron" className={labelCx}>
            Custom cron expression
          </label>
          <Input
            id="sched-cron"
            value={cron_expression}
            onChange={(e) => onChange({ cron_expression: e.target.value })}
            placeholder="0 9 * * 1,3,5"
            className={cn(inputCx, "mt-1.5 font-mono")}
          />
          <p className={helpCx}>
            5 fields: <code>min hour dom month dow</code>. Day-of-week 0–6 (Sun=0).
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCx}>Time of day</label>
          <Select value={time_of_day} onValueChange={handleTimeChange}>
            <SelectTrigger className={cn(inputCx, "mt-1.5")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] max-h-72">
              {timeOfDayOptions().map((o) => (
                <SelectItem key={o.value} value={o.value} className="focus:bg-white/5">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className={labelCx}>Timezone</label>
          <Select value={timezone} onValueChange={(v) => onChange({ timezone: v })}>
            <SelectTrigger className={cn(inputCx, "mt-1.5")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] max-h-72">
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz.value} value={tz.value} className="focus:bg-white/5">
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="bg-black/20 border-white/8">
        <CardContent className="py-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-[#5A6268]">Schedule preview</span>
            {!cronValid.valid && (
              <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-400 text-[10px]">
                Invalid
              </Badge>
            )}
          </div>
          {cronValid.valid ? (
            <>
              <p className="text-[13px] text-[#ECEAE4]">
                {humanizeCron(cron_expression, timezone)}{" "}
                <span className="text-[#5A6268] font-mono text-[11px] ml-1">({cron_expression})</span>
              </p>
              {noFireSoon ? (
                <p className="text-[12px] text-red-400">
                  This cron will not fire in the next 30 days. Adjust the cadence.
                </p>
              ) : (
                <div className="space-y-1">
                  <p className="text-[11px] uppercase tracking-wider text-[#5A6268]">Next 5 fires</p>
                  <ul className="space-y-0.5 text-[12px] text-[#ECEAE4] font-mono">
                    {fires.map((d, i) => (
                      <li key={i}>{tzAwareFormat(d)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="text-[12px] text-red-400">{cronValid.error}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Step 3 — Where                                                   */
/* ────────────────────────────────────────────────────────────── */

function HashtagInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const addTag = (raw: string) => {
    const cleaned = raw.replace(/^#/, "").trim();
    if (!cleaned) return;
    if (value.includes(cleaned)) return;
    onChange([...value, cleaned]);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input);
      setInput("");
    } else if (e.key === "Backspace" && !input && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-2 py-1.5",
        "focus-within:border-[#11C4D0]/40",
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-[#11C4D0]/15 text-[#11C4D0] px-2 py-0.5 text-[11px]"
        >
          #{tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="hover:text-red-400"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => {
          if (input.trim()) {
            addTag(input);
            setInput("");
          }
        }}
        placeholder={value.length === 0 ? "Type a hashtag and press Enter…" : ""}
        className="flex-1 min-w-[120px] bg-transparent text-[12px] text-[#ECEAE4] placeholder:text-[#5A6268] outline-none"
      />
    </div>
  );
}

function CaptionField({
  platform,
  value,
  onChange,
}: {
  platform: AutopostPlatform;
  value: string;
  onChange: (v: string) => void;
}) {
  const max = CAPTION_LIMITS[platform];
  const len = value.length;
  const over = len > max;
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-[12px] font-medium text-[#ECEAE4]">
          <span className="inline-flex h-4 w-4 items-center justify-center text-[#11C4D0]">
            {platformIcon(platform, "h-3.5 w-3.5")}
          </span>
          {PLATFORM_LABEL[platform]} caption
        </label>
        <span className={cn("text-[10px] font-mono", over ? "text-red-400" : "text-[#5A6268]")}>
          {len}/{max}
        </span>
      </div>
      <Textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Caption template for ${PLATFORM_LABEL[platform]} (supports {topic}, {date})`}
        className={cn(inputCx, "mt-1.5 resize-y")}
      />
    </div>
  );
}

export function Step3Where({ draft, onChange }: StepProps) {
  const accountsQuery = useQuery({ queryKey: ["autopost-accounts-picker"], queryFn: fetchPickerAccounts });
  const accounts = accountsQuery.data ?? [];
  const grouped: Record<AutopostPlatform, AccountForPicker[]> = {
    youtube: accounts.filter((a) => a.platform === "youtube"),
    instagram: accounts.filter((a) => a.platform === "instagram"),
    tiktok: accounts.filter((a) => a.platform === "tiktok"),
  };

  const toggle = (id: string) => {
    const next = draft.target_account_ids.includes(id)
      ? draft.target_account_ids.filter((x) => x !== id)
      : [...draft.target_account_ids, id];
    onChange({ target_account_ids: next });
  };

  if (accountsQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full bg-white/5" />
        <Skeleton className="h-24 w-full bg-white/5" />
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <Card className="bg-black/20 border-dashed border-white/10">
        <CardContent className="py-10 flex flex-col items-center text-center gap-3">
          <Cable className="h-8 w-8 text-[#11C4D0]" />
          <p className="text-[13px] text-[#ECEAE4]">No accounts connected yet.</p>
          <p className="text-[12px] text-[#8A9198] max-w-sm">
            Connect at least one YouTube, Instagram, or TikTok account before targeting it from a schedule.
          </p>
          <Link
            to="/lab/autopost/connect"
            className="inline-flex items-center gap-1.5 rounded-md bg-[#11C4D0] text-[#0A0D0F] px-3 py-1.5 text-[12px] font-medium hover:bg-[#11C4D0]/90"
          >
            Go to Connect
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        {(["youtube", "instagram", "tiktok"] as AutopostPlatform[]).map((p) => {
          const list = grouped[p];
          if (list.length === 0) return null;
          return (
            <div key={p}>
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex h-5 w-5 items-center justify-center text-[#11C4D0]">
                  {platformIcon(p, "h-4 w-4")}
                </span>
                <span className="text-[11px] uppercase tracking-wider text-[#8A9198]">
                  {PLATFORM_LABEL[p]}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {list.map((acc) => {
                  const checked = draft.target_account_ids.includes(acc.id);
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      onClick={() => toggle(acc.id)}
                      className={cn(
                        "flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                        checked
                          ? "border-[#11C4D0]/50 bg-[#11C4D0]/10"
                          : "border-white/10 bg-black/30 hover:border-white/20",
                      )}
                      aria-pressed={checked}
                    >
                      <Avatar className="h-8 w-8">
                        {acc.avatar_url && <AvatarImage src={acc.avatar_url} alt={acc.display_name} />}
                        <AvatarFallback className="bg-[#11C4D0]/15 text-[10px] font-medium text-[#11C4D0]">
                          {acc.display_name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-[#ECEAE4] truncate">{acc.display_name}</div>
                        <div className="text-[11px] text-[#5A6268]">{acc.status}</div>
                      </div>
                      <span
                        className={cn(
                          "inline-flex h-4 w-4 items-center justify-center rounded border",
                          checked ? "border-[#11C4D0] bg-[#11C4D0]" : "border-white/30 bg-transparent",
                        )}
                        aria-hidden="true"
                      >
                        {checked && (
                          <svg viewBox="0 0 12 12" className="h-3 w-3 text-[#0A0D0F]" fill="none">
                            <path d="M2 6.5L5 9.5L10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-4 pt-4 border-t border-white/8">
        <CaptionField
          platform="youtube"
          value={draft.caption_youtube}
          onChange={(v) => onChange({ caption_youtube: v })}
        />
        <CaptionField
          platform="instagram"
          value={draft.caption_instagram}
          onChange={(v) => onChange({ caption_instagram: v })}
        />
        <CaptionField
          platform="tiktok"
          value={draft.caption_tiktok}
          onChange={(v) => onChange({ caption_tiktok: v })}
        />

        <div>
          <label className={labelCx}>Hashtags</label>
          <HashtagInput value={draft.hashtags} onChange={(next) => onChange({ hashtags: next })} />
          <p className={helpCx}>Applied to all platforms. Press Enter or comma to add.</p>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border border-white/8 bg-black/20 px-3 py-3">
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-[#ECEAE4]">
              AI-generated content disclosure
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-[#8A9198]" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Required for compliance on all three platforms (YouTube, Instagram, TikTok). Always on.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-[11px] text-[#5A6268] mt-0.5">
              Marks each post as AI-generated where the platform exposes the flag.
            </p>
          </div>
          <Switch checked={true} disabled aria-label="AI disclosure (required, always on)" />
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Step 4 — Review                                                  */
/* ────────────────────────────────────────────────────────────── */

export function Step4Review({
  draft,
  accountsLookup,
}: {
  draft: ScheduleDraft;
  accountsLookup: Record<string, AccountForPicker>;
}) {
  const fires = nextNFiresFromCron(draft.cron_expression, draft.timezone, 3);
  const tzAwareFormat = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: draft.timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  };
  const targets = draft.target_account_ids
    .map((id) => accountsLookup[id])
    .filter((a): a is AccountForPicker => Boolean(a));
  const motionLabel =
    MOTION_PRESETS.find((m) => m.value === draft.motion_preset)?.label ?? draft.motion_preset;

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-white/8 last:border-0">
      <span className="text-[11px] uppercase tracking-wider text-[#5A6268] shrink-0 pt-0.5 w-24">{label}</span>
      <div className="text-[13px] text-[#ECEAE4] text-right min-w-0 flex-1">{children}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card className="bg-black/20 border-white/8">
        <CardContent className="py-1">
          <Row label="Name">{draft.name || "—"}</Row>
          <Row label="Prompt">
            <span className="break-words font-mono text-[11px]">{draft.prompt_template || "—"}</span>
          </Row>
          <Row label="Topics">
            {draft.topic_pool.trim()
              ? `${draft.topic_pool.split(/\n/).filter(Boolean).length} topic(s)`
              : "—"}
          </Row>
          <Row label="Motion">{motionLabel}</Row>
          <Row label="Duration">{draft.duration_seconds}s</Row>
          <Row label="Resolution">{draft.resolution.replace("x", "×")}</Row>
        </CardContent>
      </Card>

      <Card className="bg-black/20 border-white/8">
        <CardContent className="py-1">
          <Row label="Cadence">{humanizeCron(draft.cron_expression, draft.timezone)}</Row>
          <Row label="Timezone">{draft.timezone}</Row>
          <Row label="Cron">
            <code className="text-[11px] font-mono text-[#11C4D0]">{draft.cron_expression}</code>
          </Row>
          <Row label="Next fires">
            <span className="font-mono text-[11px]">
              {fires.length === 0 ? "—" : fires.map(tzAwareFormat).join(" · ")}
            </span>
          </Row>
        </CardContent>
      </Card>

      <Card className="bg-black/20 border-white/8">
        <CardContent className="py-1">
          <Row label="Targets">
            {targets.length === 0 ? "—" : (
              <div className="flex flex-wrap justify-end gap-1.5">
                {targets.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 rounded-full bg-[#11C4D0]/10 text-[#11C4D0] px-2 py-0.5 text-[11px]"
                  >
                    {platformIcon(t.platform, "h-3 w-3")}
                    {t.display_name}
                  </span>
                ))}
              </div>
            )}
          </Row>
          <Row label="Hashtags">
            {draft.hashtags.length === 0 ? "—" : draft.hashtags.map((t) => `#${t}`).join(" ")}
          </Row>
          <Row label="AI disclosure">{draft.ai_disclosure ? "Always on (required)" : "Off"}</Row>
        </CardContent>
      </Card>
    </div>
  );
}
