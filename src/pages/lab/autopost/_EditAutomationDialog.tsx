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

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Slider } from "@/components/ui/slider";
import { supabase } from "@/integrations/supabase/client";
import type { AutomationSchedule, IntakeSettings } from "./_automationTypes";

interface EditAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: AutomationSchedule;
}

interface DraftState {
  name: string;
  prompt_template: string;
  caption_template: string;
  hashtags: string;
  resolution: string;
  duration_seconds: number;
}

function buildDraft(s: AutomationSchedule): DraftState {
  // Prefer the snapshot when it's present (it carries the intake-form
  // values verbatim), but always fall back to the live column so
  // pre-snapshot rows still edit cleanly.
  const snap = (s.config_snapshot ?? {}) as IntakeSettings;
  return {
    name: s.name,
    prompt_template: s.prompt_template ?? snap.prompt ?? "",
    caption_template: s.caption_template ?? "",
    hashtags: (s.hashtags ?? []).join(", "),
    resolution: s.resolution ?? snap.resolution ?? "1080x1920",
    duration_seconds: s.duration_seconds ?? snap.duration_seconds ?? 30,
  };
}

function parseHashtags(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map(t => t.trim().replace(/^#/, ""))
    .filter(Boolean)
    .map(t => `#${t}`);
}

export function EditAutomationDialog({
  open, onOpenChange, schedule,
}: EditAutomationDialogProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(() => buildDraft(schedule));

  // Re-seed when the source schedule changes or the dialog reopens, so
  // we don't show stale local edits after a realtime update.
  useEffect(() => {
    if (open) setDraft(buildDraft(schedule));
  }, [open, schedule]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft.name.trim()) throw new Error("Name required");
      if (!draft.prompt_template.trim()) throw new Error("Prompt template required");

      const hashtags = parseHashtags(draft.hashtags);
      const prevSnap = (schedule.config_snapshot ?? {}) as IntakeSettings;
      const nextSnap: IntakeSettings = {
        ...prevSnap,
        prompt: draft.prompt_template,
        caption_template: draft.caption_template,
        hashtags,
        resolution: draft.resolution,
        duration_seconds: draft.duration_seconds,
      };

      // The generated supabase types may not yet include `config_snapshot`
      // (it's introduced by Wave B1's migration). Cast through unknown so
      // the update payload type-checks while still being typo-safe.
      const updatePayload = {
        name: draft.name.trim(),
        prompt_template: draft.prompt_template,
        caption_template: draft.caption_template || null,
        hashtags: hashtags.length > 0 ? hashtags : null,
        resolution: draft.resolution,
        duration_seconds: draft.duration_seconds,
        config_snapshot: nextSnap,
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

          <div className="space-y-1.5">
            <Label htmlFor="auto-edit-caption" className="text-[12px] text-[#ECEAE4]">
              Caption template
            </Label>
            <Textarea
              id="auto-edit-caption"
              value={draft.caption_template}
              onChange={e => setDraft(d => ({ ...d, caption_template: e.target.value }))}
              rows={3}
              className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4] resize-none"
              placeholder="Each platform truncates differently — keep the hook in the first 80 chars."
            />
            <p className="text-[11px] text-[#5A6268]">
              YouTube allows up to 5,000 chars; IG ~2,200; TikTok ~2,200. Hook in the first 80.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-edit-hashtags" className="text-[12px] text-[#ECEAE4]">
              Hashtags
            </Label>
            <Input
              id="auto-edit-hashtags"
              value={draft.hashtags}
              onChange={e => setDraft(d => ({ ...d, hashtags: e.target.value }))}
              placeholder="#shorts, #reels, #foryou"
              className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]"
            />
            <p className="text-[11px] text-[#5A6268]">
              Comma-separated. The leading # is added automatically if missing.
            </p>
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
                <SelectContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
                  <SelectItem value="1080x1920">1080×1920 (vertical)</SelectItem>
                  <SelectItem value="1920x1080">1920×1080 (horizontal)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[12px] text-[#ECEAE4]">
                Duration · {draft.duration_seconds}s
              </Label>
              <Slider
                min={5}
                max={90}
                step={1}
                value={[draft.duration_seconds]}
                onValueChange={(values: number[]) =>
                  setDraft(d => ({ ...d, duration_seconds: values[0] ?? d.duration_seconds }))
                }
                className="pt-2"
              />
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
