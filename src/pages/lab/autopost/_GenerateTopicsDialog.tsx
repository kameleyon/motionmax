/**
 * GenerateTopicsDialog — async topic-pool builder.
 *
 * Mirrors the Autonomux GenerateTitlesDialog flow:
 *   1. Show a counter banner with current queue size + "past excluded".
 *   2. User clicks Generate; we INSERT a video_generation_jobs row with
 *      task_type='generate_topics' and poll until the worker completes
 *      (or fails). Wave B1 added the worker handler.
 *   3. Render the 15 returned topics with checkboxes; user picks any
 *      subset and clicks "Add N Topics to Queue".
 *   4. The current queue is shown at the bottom with hover-revealed X
 *      buttons so people can prune drift.
 *
 * Polling is deliberately simple — interval based, capped at ~60s. The
 * generate path is synchronous-feeling but doesn't block UI: the user
 * can close the dialog mid-flight; the next reopen shows the current
 * queue (the in-flight job result is discarded if the dialog is gone).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Wand2, X, Lightbulb } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import type { AutomationSchedule } from "./_automationTypes";

interface GenerateTopicsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: AutomationSchedule;
}

/** How many candidates the worker job is asked to return. */
const TARGET_COUNT = 15;

/** Polling cadence and ceiling for the topic-generation job. */
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 90_000;

interface GenerationResultPayload {
  topics?: string[];
}

interface JobRow {
  id: string;
  status: string;
  result: GenerationResultPayload | null;
  error_message: string | null;
}

async function fetchJob(jobId: string): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("video_generation_jobs")
    .select("id, status, result, error_message")
    .eq("id", jobId)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as JobRow | null;
}

export function GenerateTopicsDialog({
  open, onOpenChange, schedule,
}: GenerateTopicsDialogProps) {
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Total topics ever excluded across past generations — best-effort
   *  client-side counter; persisted via config_snapshot in a future
   *  iteration. */
  const [excludedCount, setExcludedCount] = useState(0);
  const cancelRef = useRef(false);

  // Reset transient state every time the dialog opens, so a previous
  // generation's candidates don't leak across schedules.
  useEffect(() => {
    if (open) {
      setCandidates([]);
      setSelected(new Set());
      cancelRef.current = false;
    } else {
      cancelRef.current = true;
    }
  }, [open]);

  const queue = schedule.topic_pool ?? [];

  const generate = async () => {
    setGenerating(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Not signed in");

      const insertPayload = {
        prompt: schedule.prompt_template,
        count: TARGET_COUNT,
        existingTopics: queue,
        scheduleId: schedule.id,
      };
      const { data: inserted, error: insertErr } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: userId,
          task_type: "generate_topics",
          status: "pending",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payload: insertPayload as any,
        })
        .select("id")
        .single();
      if (insertErr || !inserted) {
        throw new Error(insertErr?.message || "Could not enqueue topic job");
      }

      const jobId = inserted.id as string;
      const startedAt = Date.now();

      // Poll until completion / failure / cancellation / timeout.
      while (!cancelRef.current) {
        if (Date.now() - startedAt > POLL_MAX_MS) {
          throw new Error("Topic generation timed out — try again");
        }
        const job = await fetchJob(jobId);
        if (job?.status === "completed") {
          const topics = (job.result?.topics ?? []).filter(
            (t): t is string => typeof t === "string" && t.trim().length > 0,
          );
          if (topics.length === 0) {
            throw new Error("Worker returned no topics");
          }
          setCandidates(topics);
          setSelected(new Set(topics));
          return;
        }
        if (job?.status === "failed") {
          throw new Error(job.error_message || "Topic generation failed");
        }
        await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Topic generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const addMutation = useMutation({
    mutationFn: async () => {
      const additions = Array.from(selected).filter(t => !queue.includes(t));
      if (additions.length === 0) {
        throw new Error("Nothing new to add");
      }
      const next = [...queue, ...additions];
      const { error } = await supabase
        .from("autopost_schedules")
        .update({ topic_pool: next })
        .eq("id", schedule.id);
      if (error) throw error;
      // Anything in candidates that we didn't pick counts as excluded.
      const skipped = candidates.filter(t => !selected.has(t)).length;
      setExcludedCount(prev => prev + skipped);
      return additions.length;
    },
    onSuccess: (added) => {
      toast.success(`Added ${added} topic${added === 1 ? "" : "s"} to queue`);
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      setCandidates([]);
      setSelected(new Set());
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Add failed");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (topic: string) => {
      const next = queue.filter(t => t !== topic);
      const { error } = await supabase
        .from("autopost_schedules")
        .update({ topic_pool: next })
        .eq("id", schedule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not remove topic");
    },
  });

  const allSelected = useMemo(
    () => candidates.length > 0 && candidates.every(t => selected.has(t)),
    [candidates, selected],
  );

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(candidates));
  };

  const toggleOne = (topic: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };

  const hasGenerated = candidates.length > 0;
  const generateLabel = hasGenerated ? "Regenerate Topics" : `Generate ${TARGET_COUNT} Topic Ideas`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[#ECEAE4] flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-[#11C4D0]" />
            Generate more topics
          </DialogTitle>
          <DialogDescription className="text-[#8A9198]">
            Builds a fresh batch of topic ideas using the automation's prompt
            and the current queue as exclusions.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-2.5 text-[12px] text-[#ECEAE4] flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            <Lightbulb className="h-3.5 w-3.5 text-[#E4C875]" />
            <span className="font-medium">{queue.length}</span>
            <span className="text-[#8A9198]">topic{queue.length === 1 ? "" : "s"} in queue</span>
          </span>
          <span className="text-[#8A9198]">
            <span className="font-medium text-[#ECEAE4]">{excludedCount}</span> past excluded
          </span>
        </div>

        <Button
          variant="outline"
          onClick={generate}
          disabled={generating}
          className="w-full border-[#11C4D0]/30 bg-[#11C4D0]/5 text-[#11C4D0] hover:bg-[#11C4D0]/10 hover:text-[#11C4D0]"
        >
          {generating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 autopost-spin" />
              Generating…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4 mr-2" />
              {generateLabel}
            </>
          )}
        </Button>

        {hasGenerated && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[12px]">
              <button
                type="button"
                onClick={toggleAll}
                className="text-[#11C4D0] hover:text-[#11C4D0]/80 underline-offset-2 hover:underline"
              >
                {allSelected ? "Clear selection" : "Select all"}
              </button>
              <span className="text-[#8A9198]">
                <span className="text-[#ECEAE4] font-medium">{selected.size}</span> of {candidates.length} selected
              </span>
            </div>
            <ScrollArea className="max-h-64 rounded-md border border-white/8">
              <ul className="divide-y divide-white/8">
                {candidates.map(topic => {
                  const isSelected = selected.has(topic);
                  return (
                    <li
                      key={topic}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.03]",
                        isSelected && "bg-[#11C4D0]/[0.04]",
                      )}
                      onClick={() => toggleOne(topic)}
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleOne(topic)}
                        className="border-white/20 data-[state=checked]:bg-[#11C4D0] data-[state=checked]:border-[#11C4D0]"
                      />
                      <span className="text-[13px] text-[#ECEAE4] flex-1 min-w-0">{topic}</span>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </div>
        )}

        {queue.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[11px] uppercase tracking-wider text-[#5A6268]">
              Current queue
            </p>
            <div className="rounded-md border border-white/8 max-h-40 overflow-y-auto">
              <ul className="divide-y divide-white/8">
                {queue.map(topic => (
                  <li
                    key={topic}
                    className="group flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03]"
                  >
                    <Badge
                      variant="outline"
                      className="shrink-0 border-white/15 bg-white/5 text-[#8A9198] text-[10px]"
                    >
                      queued
                    </Badge>
                    <span className="text-[12px] text-[#ECEAE4] flex-1 min-w-0 truncate">
                      {topic}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeMutation.mutate(topic)}
                      disabled={removeMutation.isPending}
                      aria-label={`Remove ${topic}`}
                      className="shrink-0 rounded p-1 text-[#5A6268] opacity-0 group-hover:opacity-100 hover:bg-[#F47272]/10 hover:text-[#F47272] transition-opacity"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
          >
            Close
          </Button>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={selected.size === 0 || addMutation.isPending}
            className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
          >
            {addMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Add {selected.size > 0 ? selected.size : ""} Topic{selected.size === 1 ? "" : "s"} to Queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GenerateTopicsDialog;
