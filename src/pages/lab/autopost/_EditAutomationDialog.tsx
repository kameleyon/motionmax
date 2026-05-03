/**
 * EditAutomationDialog — inline editor for an automation's "instructions".
 *
 * Surfaces the most-edited fields without recreating the full intake
 * form: name, prompt template, caption template, hashtags, resolution,
 * and duration. On save we update both the directly-editable columns on
 * `autopost_schedules` AND the corresponding keys inside
 * `config_snapshot` so the next intake-style edit picks up the latest
 * values. Anything else inside `config_snapshot` is preserved verbatim.
 *
 * Hashtags are stored as `text[]` in Postgres but edited as a single
 * comma-separated string here so people can paste a typical "#foo, #bar"
 * blob without thinking about chip pickers.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Send, Mail, FolderHeart, X as XIcon } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { getSpeakersForLanguage, getDefaultSpeaker, type SpeakerVoice } from "@/components/workspace/SpeakerSelector";
import type { AutomationSchedule, IntakeSettings } from "./_automationTypes";

// Match the inline LANGUAGES list in IntakeForm so the Edit dialog
// surfaces every language the schedule could have been created with.
const LANGUAGES: Array<{ code: string; label: string; flag: string }> = [
  { code: 'en', label: 'English',         flag: '\u{1F1FA}\u{1F1F8}' },
  { code: 'fr', label: 'Français',        flag: '\u{1F1EB}\u{1F1F7}' },
  { code: 'es', label: 'Español',         flag: '\u{1F1EA}\u{1F1F8}' },
  { code: 'ht', label: 'Kreyòl Ayisyen',  flag: '\u{1F1ED}\u{1F1F9}' },
  { code: 'de', label: 'Deutsch',         flag: '\u{1F1E9}\u{1F1EA}' },
  { code: 'it', label: 'Italiano',        flag: '\u{1F1EE}\u{1F1F9}' },
  { code: 'nl', label: 'Nederlands',      flag: '\u{1F1F3}\u{1F1F1}' },
  { code: 'ru', label: 'Русский',         flag: '\u{1F1F7}\u{1F1FA}' },
  { code: 'zh', label: '中文',            flag: '\u{1F1E8}\u{1F1F3}' },
  { code: 'ja', label: '日本語',          flag: '\u{1F1EF}\u{1F1F5}' },
  { code: 'ko', label: '한국어',          flag: '\u{1F1F0}\u{1F1F7}' },
];

// Mirror of the IntakeForm STYLES list — every visual style autopost
// can render in. Kept as a flat (id, label) pair here so the Select
// stays light; the heavier preview thumbnails live in IntakeForm
// where the picker is a visual grid.
const VISUAL_STYLES: Array<{ id: string; label: string }> = [
  { id: 'realistic',  label: 'Realistic' },
  { id: '3d-pixar',   label: '3D Style' },
  { id: 'anime',      label: 'Anime' },
  { id: 'claymation', label: 'Claymation' },
  { id: 'storybook',  label: 'Storybook' },
  { id: 'caricature', label: 'Caricature' },
  { id: 'doodle',     label: 'Urban Doodle' },
  { id: 'stick',      label: 'Stick Figure' },
  { id: 'sketch',     label: 'Papercut 3D' },
  { id: 'crayon',     label: 'Crayon' },
  { id: 'minimalist', label: 'Minimalist' },
  { id: 'moody',      label: 'Moody' },
  { id: 'chalkboard', label: 'Chalkboard' },
  { id: 'lego',       label: 'LEGO' },
  { id: 'cardboard',  label: 'Cardboard' },
  { id: 'babie',      label: 'Babie' },
  { id: 'custom',     label: 'Custom' },
];

// Mirror of the workspace CaptionStyleSelector list.
const CAPTION_STYLES: Array<{ value: string; label: string }> = [
  { value: "none",           label: "None (no captions)" },
  { value: "cleanPop",       label: "Clean Pop" },
  { value: "toxicBounce",    label: "Toxic Bounce" },
  { value: "proShortForm",   label: "Pro Block" },
  { value: "orangeBox",      label: "Orange Box" },
  { value: "yellowSlanted",  label: "Yellow Slant" },
  { value: "redSlantedBox",  label: "Red Slant" },
  { value: "cyanOutline",    label: "Cyan Outline" },
  { value: "motionBlur",     label: "Motion Blur" },
  { value: "thickStroke",    label: "Thick Stroke" },
  { value: "karaokePop",     label: "Karaoke" },
  { value: "neonTeal",       label: "Neon Teal" },
  { value: "goldLuxury",     label: "Gold" },
  { value: "bouncyPill",     label: "Pill" },
  { value: "glitch",         label: "Glitch" },
  { value: "comicBurst",     label: "Comic" },
  { value: "redTag",         label: "Red Tag" },
  { value: "blackBox",       label: "Black Box" },
  { value: "typewriter",     label: "Typewriter" },
  { value: "cinematicFade",  label: "Cinematic" },
  { value: "retroTerminal",  label: "Terminal" },
  { value: "heavyDropShadow",label: "Shadow" },
  { value: "yellowSmall",    label: "Small Yellow" },
];

type DeliveryMethod = 'social' | 'email' | 'library_only';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface EditAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: AutomationSchedule;
}

interface DraftState {
  name: string;
  prompt_template: string;
  resolution: string;
  language: string;
  voice: SpeakerVoice;
  caption_style: string;
  /** Visual style id (matches the IntakeForm STYLES list). Persisted
   *  on save into config_snapshot.style and into
   *  config_snapshot.intake_settings.visualStyle so the worker's
   *  Imagen / Kling prompt builder picks it up the same way it
   *  would for a fresh intake. */
  style: string;
  delivery_method: DeliveryMethod;
  email_recipients: string[];
}

function buildDraft(s: AutomationSchedule): DraftState {
  // Prefer the snapshot when it's present (it carries the intake-form
  // values verbatim), but always fall back to the live column so
  // pre-snapshot rows still edit cleanly.
  const snap = (s.config_snapshot ?? {}) as IntakeSettings & {
    language?: string;
    voice_name?: string;
    style?: string;
    intake_settings?: { captionStyle?: string; visualStyle?: string };
  };
  const language = snap.language ?? "en";
  const voice = (snap.voice_name as SpeakerVoice | undefined) ?? getDefaultSpeaker(language);
  const captionStyle = snap.intake_settings?.captionStyle ?? "none";
  // Style source priority: top-level config_snapshot.style (what
  // IntakeForm writes today) → intake_settings.visualStyle (legacy
  // shape) → 'realistic' as the safest default.
  const style = snap.style ?? snap.intake_settings?.visualStyle ?? "realistic";
  return {
    name: s.name,
    prompt_template: s.prompt_template ?? snap.prompt ?? "",
    resolution: s.resolution ?? snap.resolution ?? "1080x1920",
    language,
    voice,
    caption_style: captionStyle,
    style,
    // Default to 'library_only' when reading rows authored before Wave
    // E (and surface only library-only / email until social
    // verification clears).
    delivery_method: (s.delivery_method ?? 'library_only') as DeliveryMethod,
    email_recipients: Array.isArray(s.email_recipients) ? s.email_recipients : [],
  };
}

export function EditAutomationDialog({
  open, onOpenChange, schedule,
}: EditAutomationDialogProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(() => buildDraft(schedule));
  const [emailDraft, setEmailDraft] = useState("");

  // Re-seed when the source schedule changes or the dialog reopens, so
  // we don't show stale local edits after a realtime update.
  useEffect(() => {
    if (open) {
      setDraft(buildDraft(schedule));
      setEmailDraft("");
    }
  }, [open, schedule]);

  // Voices available for the currently-selected language. Keep the
  // currently-saved voice visible even if it isn't in the language's
  // standard list (e.g. a clone or a cross-language test pick).
  const voiceOptions = useMemo(() => {
    const list = getSpeakersForLanguage(draft.language);
    if (!list.some((s) => s.id === draft.voice)) {
      return [{ id: draft.voice, label: draft.voice }, ...list];
    }
    return list;
  }, [draft.language, draft.voice]);

  function tryAddEmail(raw: string): boolean {
    const candidate = raw.trim().replace(/[,;]+$/, "");
    if (!candidate) return false;
    if (!EMAIL_RE.test(candidate)) {
      toast.error(`"${candidate}" doesn't look like a valid email.`);
      return false;
    }
    if (draft.email_recipients.includes(candidate)) return false;
    setDraft((d) => ({ ...d, email_recipients: [...d.email_recipients, candidate] }));
    return true;
  }
  function removeEmail(addr: string) {
    setDraft((d) => ({
      ...d,
      email_recipients: d.email_recipients.filter((e) => e !== addr),
    }));
  }
  function handleEmailKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      if (tryAddEmail(emailDraft)) setEmailDraft("");
    } else if (e.key === "Backspace" && emailDraft === "" && draft.email_recipients.length > 0) {
      setDraft((d) => ({
        ...d,
        email_recipients: d.email_recipients.slice(0, -1),
      }));
    }
  }
  function handleEmailBlur() {
    if (emailDraft.trim() && tryAddEmail(emailDraft)) setEmailDraft("");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft.name.trim()) throw new Error("Name required");
      if (!draft.prompt_template.trim()) throw new Error("Prompt template required");

      // Wave E validation: email mode requires at least one recipient.
      // Library-only and social modes have no extra requirement here —
      // social can be saved with an empty target list (the run will fall
      // back to library-only at trigger time rather than stalling).
      if (draft.delivery_method === 'email' && draft.email_recipients.length === 0) {
        throw new Error("Add at least one email recipient before saving.");
      }

      const prevSnap = (schedule.config_snapshot ?? {}) as IntakeSettings & {
        intake_settings?: Record<string, unknown>;
      };
      const prevIntake = (prevSnap.intake_settings ?? {}) as Record<string, unknown>;
      const nextSnap = {
        ...prevSnap,
        prompt: draft.prompt_template,
        resolution: draft.resolution,
        language: draft.language,
        voice_name: draft.voice,
        // Persist the visual style at both the canonical snapshot key
        // (where IntakeForm writes it) and inside intake_settings
        // (where legacy autopost rows / older worker code paths read
        // from). Worker prompt builders read style from the project
        // row that handleAutopostRun inserts via config.style, which
        // is sourced from this snapshot, so writing both keys keeps
        // the runtime behavior identical to a fresh intake save.
        style: draft.style,
        intake_settings: {
          ...prevIntake,
          captionStyle: draft.caption_style,
          visualStyle: draft.style,
        },
      };

      // Captions, hashtags, and the per-schedule duration cap have been
      // dropped from the editor — captions/hashtags will be AI-generated
      // when social publishing comes back online, and per-flow scene
      // pacing already controls duration. We still null those columns
      // out on save so legacy values don't leak into new runs.
      const updatePayload = {
        name: draft.name.trim(),
        prompt_template: draft.prompt_template,
        caption_template: null,
        hashtags: null,
        resolution: draft.resolution,
        duration_seconds: null,
        config_snapshot: nextSnap,
        delivery_method: draft.delivery_method,
        email_recipients: draft.email_recipients,
        ...(draft.delivery_method !== 'social' ? { target_account_ids: [] } : {}),
      } as unknown as Record<string, unknown>;

      const { error } = await supabase
        .from("autopost_schedules")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(updatePayload as any)
        .eq("id", schedule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Automation updated");
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Save failed");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[#ECEAE4]">Edit instructions</DialogTitle>
          <DialogDescription className="text-[#8A9198]">
            Update what this automation generates on its next run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="auto-edit-name" className="text-[12px] text-[#ECEAE4]">
              Name
            </Label>
            <Input
              id="auto-edit-name"
              value={draft.name}
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-edit-prompt" className="text-[12px] text-[#ECEAE4]">
              Prompt template
            </Label>
            <Textarea
              id="auto-edit-prompt"
              value={draft.prompt_template}
              onChange={e => setDraft(d => ({ ...d, prompt_template: e.target.value }))}
              rows={4}
              className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4] resize-none"
              placeholder="e.g. A 30-second motivational reel about resilience for entrepreneurs"
            />
          </div>

          {/* ── Delivery method (Wave E) ── */}
          <div className="space-y-2">
            <Label className="text-[12px] text-[#ECEAE4]">Where it goes</Label>
            <div role="radiogroup" aria-label="Delivery method" className="grid gap-2">
              {[
                { value: 'social' as const,       label: 'Publish to social media',       Icon: Send,        disabled: true  },
                { value: 'email' as const,        label: 'Email when each video is ready', Icon: Mail,        disabled: false },
                { value: 'library_only' as const, label: 'Just save to my library',       Icon: FolderHeart, disabled: false },
              ].map(({ value, label, Icon, disabled }) => {
                const selected = draft.delivery_method === value;
                const inputId = `edit-delivery-${value}`;
                return (
                  <label
                    key={value}
                    htmlFor={inputId}
                    aria-disabled={disabled}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-colors ${
                      disabled
                        ? 'border-white/10 bg-[#0A0D0F] opacity-50 cursor-not-allowed'
                        : selected
                          ? 'border-[#11C4D0]/50 bg-[#11C4D0]/[0.06] cursor-pointer'
                          : 'border-white/10 bg-[#0A0D0F] hover:border-white/20 cursor-pointer'
                    }`}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="edit-delivery-method"
                      value={value}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => { if (!disabled) setDraft((d) => ({ ...d, delivery_method: value })); }}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center ${
                        selected && !disabled ? 'border-[#11C4D0]' : 'border-white/25'
                      }`}
                    >
                      {selected && !disabled && <span className="w-1.5 h-1.5 rounded-full bg-[#11C4D0]" />}
                    </span>
                    <Icon className="w-3.5 h-3.5 text-[#11C4D0] shrink-0" />
                    <span className="text-[12.5px] text-[#ECEAE4] truncate">{label}</span>
                    {disabled && (
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[#E4C875] border border-[#E4C875]/30 bg-[#E4C875]/5 rounded px-1.5 py-0.5">
                        coming soon
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            {draft.delivery_method === 'email' && (
              <div className="space-y-1.5">
                <Label className="text-[11.5px] text-[#8A9198]">Email recipients</Label>
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 rounded-md bg-[#0A0D0F] border border-white/10 focus-within:border-[#11C4D0]/40">
                  {draft.email_recipients.map((addr) => (
                    <span
                      key={addr}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#11C4D0]/10 border border-[#11C4D0]/30 text-[#11C4D0] text-[12px]"
                    >
                      <Mail className="w-3 h-3" />
                      <span className="truncate max-w-[180px]">{addr}</span>
                      <button
                        type="button"
                        onClick={() => removeEmail(addr)}
                        className="hover:text-[#ECEAE4] transition-colors"
                        aria-label={`Remove ${addr}`}
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <Input
                    type="email"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    onKeyDown={handleEmailKeyDown}
                    onBlur={handleEmailBlur}
                    placeholder={draft.email_recipients.length === 0 ? 'name@example.com' : 'Add another…'}
                    className="flex-1 min-w-[160px] bg-transparent border-0 px-1 h-7 text-[12.5px] text-[#ECEAE4] focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-[#5A6268]"
                  />
                </div>
                <p className="text-[11px] text-[#5A6268]">Press Enter or comma to add. Backspace removes the last chip.</p>
              </div>
            )}

            {draft.delivery_method === 'library_only' && (
              <p className="text-[11px] text-[#5A6268] leading-[1.5] pl-1">
                Note: videos will appear in your Run History only — nothing is published or emailed.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-[12px] text-[#ECEAE4]">Resolution</Label>
              <Select
                value={draft.resolution}
                onValueChange={v => setDraft(d => ({ ...d, resolution: v }))}
              >
                <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000] bg-[#10151A] border-white/10 text-[#ECEAE4]">
                  <SelectItem value="1080x1920">1080×1920 (vertical)</SelectItem>
                  <SelectItem value="1920x1080">1920×1080 (horizontal)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[12px] text-[#ECEAE4]">Language</Label>
              <Select
                value={draft.language}
                onValueChange={(code) => {
                  // Auto-swap to a default voice for the new language so we
                  // don't carry a French voice into a Spanish run, etc.
                  const defaultVoice = getDefaultSpeaker(code);
                  setDraft(d => ({ ...d, language: code, voice: defaultVoice }));
                }}
              >
                <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000] bg-[#10151A] border-white/10 text-[#ECEAE4] max-h-72">
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.flag} {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-[12px] text-[#ECEAE4]">Voice</Label>
              <Select
                value={draft.voice as string}
                onValueChange={(v) => setDraft(d => ({ ...d, voice: v as SpeakerVoice }))}
              >
                <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000] bg-[#10151A] border-white/10 text-[#ECEAE4] max-h-72">
                  {voiceOptions.map((opt) => (
                    <SelectItem key={opt.id as string} value={opt.id as string}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[12px] text-[#ECEAE4]">Closed caption</Label>
              <Select
                value={draft.caption_style}
                onValueChange={(v) => setDraft(d => ({ ...d, caption_style: v }))}
              >
                <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000] bg-[#10151A] border-white/10 text-[#ECEAE4] max-h-72">
                  {CAPTION_STYLES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Visual style — matches IntakeForm's STYLES list. The
                worker reads `style` from the project row inserted by
                handleAutopostRun, which it sources from
                config_snapshot.style. saveMutation writes the chosen
                value to both `style` (top-level) and
                `intake_settings.visualStyle` for back-compat with any
                legacy code path that reads the older key. */}
            <div className="space-y-1.5">
              <Label className="text-[12px] text-[#ECEAE4]">Visual style</Label>
              <Select
                value={draft.style}
                onValueChange={(v) => setDraft(d => ({ ...d, style: v }))}
              >
                <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10000] bg-[#10151A] border-white/10 text-[#ECEAE4] max-h-72">
                  {VISUAL_STYLES.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
          >
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EditAutomationDialog;
