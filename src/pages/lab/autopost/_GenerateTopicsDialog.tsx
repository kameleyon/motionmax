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
import { Loader2, Wand2, X, Lightbulb, GripVertical } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { serializeAttachmentsForWorker } from "@/lib/attachmentProcessor";
import type { SourceAttachment } from "@/components/workspace/SourceInput";
import type { AutomationSchedule, PersistedSourceAttachment } from "./_automationTypes";

interface GenerateTopicsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: AutomationSchedule;
}

/** How many candidates the worker job is asked to return. */
const TARGET_COUNT = 15;

/** Polling cadence and ceiling for the topic-generation job. */
const POLL_INTERVAL_MS = 1500;
// Worker callGemini timeout for search-grounded topic gen is 180s, and
// the retryClassifier auto-retries up to 3x on AbortError, so worst-
// case end-to-end is ~9 min. We poll for 5 min — enough to cover one
// retry attempt without leaving the dialog spinning forever.
const POLL_MAX_MS = 300_000;

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
  /** Total topics ever excluded across past generations. Persisted as
   *  `config_snapshot.skipped_topics` (an array of strings) on the
   *  schedule row so re-opening the dialog after a session restart
   *  shows an accurate count, not a fresh 0. */
  const initialSkipped = useMemo(() => {
    const raw = (schedule.config_snapshot ?? {}).skipped_topics;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }, [schedule.config_snapshot]);
  const [excludedCount, setExcludedCount] = useState(initialSkipped.length);
  const cancelRef = useRef(false);

  // Reset transient state every time the dialog opens, so a previous
  // generation's candidates don't leak across schedules. The persisted
  // excluded count is re-hydrated from the schedule's config_snapshot
  // each time so it reflects the latest server-side total.
  useEffect(() => {
    if (open) {
      setCandidates([]);
      setSelected(new Set());
      setExcludedCount(initialSkipped.length);
      setLocalQueueOrder(null);
      cancelRef.current = false;
      // Force-refresh the schedules-list query each time the dialog
      // opens so any topics that were head-popped by autopost runs
      // (via the autopost_runs_pop_topic trigger) drop off the visible
      // queue immediately. Without this, the cached `schedule.topic_pool`
      // can show topics that have already been generated, confusing
      // users about which topic fires next.
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
    } else {
      cancelRef.current = true;
    }
  }, [open, initialSkipped.length, queryClient]);

  // Local override for the queue array so drag-and-drop reorders feel
  // instant. We clear it whenever the dialog reopens (because the
  // user may have re-dragged in another tab) and whenever the
  // reorderMutation persists successfully (the invalidated server
  // value becomes the source of truth again).
  const [localQueueOrder, setLocalQueueOrder] = useState<string[] | null>(null);
  const queue = localQueueOrder ?? schedule.topic_pool ?? [];

  // Drag-and-drop state — index of the item the user is currently
  // dragging. Used both to set the dragged row's visual style and to
  // compute the reordered array on drop.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const generate = async () => {
    setGenerating(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Not signed in");

      // Wave F — forward the schedule's persisted source attachments
      // (PDFs / URLs / images / inline text) to the topic generator so
      // candidates are grounded in the user's actual sources, not just
      // the prompt-template text. Worker handleGenerateTopics injects
      // payload.sources directly into its userPrompt, and
      // processContentAttachments expands [PDF_URL]/[FETCH_URL]/etc
      // tags before the model sees them. Empty list → empty string,
      // pre-Wave-F behaviour.
      const persisted = Array.isArray(schedule.source_attachments)
        ? (schedule.source_attachments as PersistedSourceAttachment[]).map<SourceAttachment>((a) => ({
            id: a.id ?? Math.random().toString(36).substring(2, 10),
            type: a.type,
            name: a.name,
            value: a.value,
          }))
        : [];
      const sources = serializeAttachmentsForWorker(persisted);

      // Schedule language lives in config_snapshot.language (set by
      // EditAutomationDialog). Default to English when missing so
      // pre-language schedules behave like before.
      const snap = (schedule.config_snapshot ?? {}) as Record<string, unknown>;
      const language = typeof snap.language === "string" ? snap.language : "en";

      const insertPayload = {
        prompt: schedule.prompt_template,
        count: TARGET_COUNT,
        existingTopics: queue,
        scheduleId: schedule.id,
        sources,
        language,
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
      // Anything in candidates that we didn't pick is recorded as a
      // permanent skip in config_snapshot.skipped_topics so the count
      // survives dialog re-opens and page reloads. We dedupe to avoid
      // counting the same topic twice if the worker happens to suggest
      // it again on a later regeneration.
      const skippedTopics = candidates.filter(t => !selected.has(t));
      const existingSnapshot = (schedule.config_snapshot ?? {}) as Record<string, unknown>;
      const existingSkipped = Array.isArray(existingSnapshot.skipped_topics)
        ? (existingSnapshot.skipped_topics as string[])
        : [];
      const mergedSkipped = Array.from(new Set([...existingSkipped, ...skippedTopics]));

      const patch: Record<string, unknown> = { topic_pool: next };
      if (mergedSkipped.length !== existingSkipped.length) {
        patch.config_snapshot = {
          ...existingSnapshot,
          skipped_topics: mergedSkipped,
        };
      }

      const { error } = await supabase
        .from("autopost_schedules")
        .update(patch)
        .eq("id", schedule.id);
      if (error) throw error;
      setExcludedCount(mergedSkipped.length);
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
      setLocalQueueOrder(null);
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not remove topic");
    },
  });

  /** Persist a new topic order to the schedule. The cron worker fires
   *  topics in array index order (round-robin from the head), so a
   *  reorder genuinely changes "what gets generated next." Optimistic:
   *  we already updated localQueueOrder before this fires, and we
   *  clear it on success so the server value takes over. */
  const reorderMutation = useMutation({
    mutationFn: async (next: string[]) => {
      const { error } = await supabase
        .from("autopost_schedules")
        .update({ topic_pool: next })
        .eq("id", schedule.id);
      if (error) throw error;
    },
    onSuccess: () => {
      // NOTE: we keep `localQueueOrder` set here so the rendered list
      // doesn't flicker to the server cache while the schedules-list
      // query refetches. The next prop refresh from the parent will
      // bring `schedule.topic_pool` in line with the local order, at
      // which point the next reseed effect (open-dialog or schedule-id
      // change) clears localQueueOrder back to null.
      void queryClient.invalidateQueries({ queryKey: ["autopost", "schedules-list"] });
      toast.success("Topic order saved");
    },
    onError: (err: unknown) => {
      // Roll back the optimistic reorder so the user sees the previous
      // (server-truthful) order if the write fails.
      setLocalQueueOrder(null);
      toast.error(err instanceof Error ? err.message : "Could not reorder topics");
    },
  });

  /** Move queue[from] to position `to`. PURELY LOCAL — no server write
   *  until the user clicks "Save order". This was previously auto-saving
   *  on every drop, which (a) gave no visible feedback and (b) raced
   *  with rapid successive drags. The explicit Save button puts the
   *  user in control + makes the persistence point obvious. */
  const reorderQueue = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
    const next = [...queue];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setLocalQueueOrder(next);
  };

  /** True when the user has dragged but not yet saved. The Save button
   *  enables only in this state — matches the design's "save changes"
   *  affordance from the EditAutomationDialog. */
  const hasPendingReorder =
    localQueueOrder !== null &&
    JSON.stringify(localQueueOrder) !== JSON.stringify(schedule.topic_pool ?? []);

  const saveOrder = () => {
    if (!localQueueOrder) return;
    reorderMutation.mutate(localQueueOrder);
  };

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
      {/* Sizing fix: max-w-xl alone let the dialog overflow on
          narrow viewports because internal flex rows had no min-w-0
          and footer / counter text could push wider than the
          container. Pin the width to viewport-minus-padding on
          mobile and let max-w-xl cap it on larger screens; hide
          horizontal overflow at the root; let the interior scroll
          vertically. */}
      <DialogContent className="autopost-modal-content w-[calc(100vw-2rem)] sm:w-auto max-w-xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="text-[#ECEAE4] flex items-center gap-2 min-w-0">
            <Wand2 className="h-4 w-4 text-[#11C4D0] shrink-0" />
            <span className="truncate">Generate more topics</span>
          </DialogTitle>
          <DialogDescription className="text-[#8A9198]">
            Builds a fresh batch of topic ideas using the automation's prompt
            and the current queue as exclusions.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-2.5 text-[12px] text-[#ECEAE4] flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <Lightbulb className="h-3.5 w-3.5 text-[#E4C875] shrink-0" />
            <span className="font-medium">{queue.length}</span>
            <span className="text-[#8A9198] truncate">topic{queue.length === 1 ? "" : "s"} in queue</span>
          </span>
          <span className="text-[#8A9198] whitespace-nowrap">
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
            <div
              className="rounded-md border border-white/8 overflow-y-auto overscroll-contain"
              style={{
                maxHeight: '260px',
                scrollbarWidth: 'thin',
                scrollbarColor: '#11C4D0 #1B2228',
              }}
            >
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
                        className="border-white/20 data-[state=checked]:bg-[#11C4D0] data-[state=checked]:border-[#11C4D0] shrink-0"
                      />
                      <span className="text-[13px] text-[#ECEAE4] flex-1 min-w-0 break-words">{topic}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {queue.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[11px] uppercase tracking-wider text-[#5A6268]">
              Current queue ({queue.length})
            </p>
            <div
              className="rounded-md border border-white/8 overflow-y-auto overscroll-contain"
              style={{
                maxHeight: '180px',
                scrollbarWidth: 'thin',
                scrollbarColor: '#11C4D0 #1B2228',
              }}
            >
              <ul className="divide-y divide-white/8">
                {queue.map((topic, index) => {
                  const isDragging = dragIndex === index;
                  const isDropTarget = dragOverIndex === index && dragIndex !== null && dragIndex !== index;
                  return (
                    <li
                      key={topic}
                      draggable
                      onDragStart={(e) => {
                        setDragIndex(index);
                        // dataTransfer required by Firefox or the drag won't fire.
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(index));
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverIndex !== index) setDragOverIndex(index);
                      }}
                      onDragLeave={() => {
                        if (dragOverIndex === index) setDragOverIndex(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragIndex;
                        setDragIndex(null);
                        setDragOverIndex(null);
                        if (from === null) return;
                        reorderQueue(from, index);
                      }}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setDragOverIndex(null);
                      }}
                      className={cn(
                        "group flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] transition-opacity",
                        isDragging && "opacity-40",
                        isDropTarget && "bg-[#11C4D0]/[0.06] outline outline-1 outline-[#11C4D0]/40",
                      )}
                    >
                      <span
                        className="shrink-0 cursor-grab active:cursor-grabbing text-[#5A6268] hover:text-[#ECEAE4] -ml-1 px-0.5 py-1"
                        title="Drag to reorder — earlier topics fire first"
                        aria-hidden
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                      <Badge
                        variant="outline"
                        className="shrink-0 border-white/15 bg-white/5 text-[#8A9198] text-[10px]"
                      >
                        queued
                      </Badge>
                      <span className="text-[12px] text-[#ECEAE4] flex-1 min-w-0 break-words">
                        {topic}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeMutation.mutate(topic)}
                        disabled={removeMutation.isPending}
                        aria-label={`Remove ${topic}`}
                        className="shrink-0 rounded p-1 text-[#5A6268] opacity-0 group-hover:opacity-100 hover:bg-[#E4C875]/10 hover:text-[#E4C875] transition-opacity"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {/* Footer: full-width column on every breakpoint where Add's
            label could outgrow its row. The previous mix of
            whitespace-normal on the button + truncate on an inner span
            was contradictory (truncate needs nowrap+overflow:hidden;
            whitespace-normal undoes nowrap), so the label rendered as
            a single overflowing line that pushed the button past the
            dialog's right edge. Drop both classes; let the label show
            in full and stack the buttons vertically up through the
            sm breakpoint so the Add button never has to share a row
            with Close on cramped widths. */}
        <DialogFooter className="gap-2 flex-col-reverse md:flex-row">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5 w-full md:w-auto"
          >
            Close
          </Button>
          {/* Save order — visible only after the user drags. Lives next
              to Close so the user gets explicit confirmation that their
              new order has been persisted. */}
          {hasPendingReorder && (
            <Button
              variant="outline"
              onClick={saveOrder}
              disabled={reorderMutation.isPending}
              className="border-[#11C4D0]/40 bg-[#11C4D0]/[0.08] text-[#11C4D0] hover:bg-[#11C4D0]/[0.16] w-full md:w-auto"
            >
              {reorderMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin shrink-0" />
              ) : null}
              Save order
            </Button>
          )}
          <Button
            onClick={() => addMutation.mutate()}
            disabled={selected.size === 0 || addMutation.isPending}
            className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90 w-full md:w-auto"
          >
            {addMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin shrink-0" />
            ) : null}
            Add {selected.size > 0 ? selected.size : ""} Topic{selected.size === 1 ? "" : "s"} to Queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GenerateTopicsDialog;
