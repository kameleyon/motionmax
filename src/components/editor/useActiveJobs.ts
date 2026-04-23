import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** In-flight job tracking for a single project. Drives the scene
 *  thumbnail spinners + Inspector button loaders + "Update all" bulk
 *  loaders so users can SEE that something's actually happening after
 *  they click regen. Polls every 3 s on top of a realtime channel —
 *  realtime misses events sometimes, so the interval is a safety net. */

export type ActiveTask =
  | 'regenerate_image'
  | 'regenerate_audio'
  | 'cinematic_video'
  | 'cinematic_image'
  | 'cinematic_audio'
  | 'export_video';

export interface ActiveJob {
  id: string;
  taskType: ActiveTask;
  sceneIndex: number | null;
  status: 'pending' | 'processing';
  /** When set, this job is part of a project-wide bulk operation
   *  (export, voice-apply-all, captions-apply, motion-apply-all).
   *  Drives the project-wide lock UI so per-scene work isn't gated by
   *  individual regens but IS gated by global re-renders. */
  bulkKind:
    | 'export'
    | 'voice-apply-all'
    | 'captions-apply'
    | 'motion-apply-all'
    | null;
  /** 0–100. Worker writes this on processing rows; pending rows
   *  default to 0. Used by the bulk-op progress modal. */
  progress: number;
}

type Row = {
  id: string;
  task_type: string;
  status: string;
  payload: Record<string, unknown> | null;
  progress: number | null;
};

function isActiveTask(t: string): t is ActiveTask {
  return [
    'regenerate_image', 'regenerate_audio',
    'cinematic_video', 'cinematic_image', 'cinematic_audio',
    'export_video',
  ].includes(t);
}

export function useActiveJobs(projectId: string | null | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery<ActiveJob[]>({
    queryKey: ['active-jobs', projectId, user?.id],
    enabled: !!user && !!projectId,
    refetchInterval: 3000, // belt-and-suspenders on top of realtime
    queryFn: async () => {
      const { data, error } = await supabase
        .from('video_generation_jobs')
        .select('id, task_type, status, payload, progress')
        .eq('project_id', projectId!)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return ((data ?? []) as Row[])
        .filter((r) => isActiveTask(r.task_type))
        .map((r) => {
          // export_video is always a bulk op. Other task types only
          // count as bulk when explicitly tagged via payload._bulk so
          // a normal per-scene regen doesn't accidentally lock the
          // whole project.
          const explicit = r.payload?._bulk as ActiveJob['bulkKind'] | undefined;
          const bulkKind: ActiveJob['bulkKind'] =
            r.task_type === 'export_video'
              ? 'export'
              : (explicit ?? null);
          return {
            id: r.id,
            taskType: r.task_type as ActiveTask,
            sceneIndex: typeof r.payload?.sceneIndex === 'number'
              ? (r.payload.sceneIndex as number)
              : null,
            status: r.status as 'pending' | 'processing',
            bulkKind,
            progress: typeof r.progress === 'number' ? r.progress : 0,
          };
        });
    },
  });

  // Realtime on top — invalidates instantly when a job flips status.
  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`active-jobs-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'video_generation_jobs', filter: `project_id=eq.${projectId}` },
        () => queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [projectId, queryClient]);

  const jobs = query.data ?? [];

  /** Which task types are currently in flight for a given scene?
   *  Returns a Set so callers can do `sceneInFlight.has('regenerate_image')`. */
  const tasksForScene = (sceneIndex: number): Set<ActiveTask> => {
    const s = new Set<ActiveTask>();
    for (const j of jobs) {
      if (j.sceneIndex === sceneIndex) s.add(j.taskType);
    }
    return s;
  };

  /** True when at least one scene has an in-flight regenerate_audio
   *  job. Used for the "Update all" bulk loader. */
  const bulkAudioRegenActive = jobs.filter((j) => j.taskType === 'regenerate_audio').length > 1;

  /** Any regen of any kind running anywhere in the project. Kept for
   *  legacy callers — UI should prefer per-scene tasksForScene() so
   *  one scene's regen doesn't block edits on another scene. */
  const anyRegenActive = jobs.length > 0;

  /** True only while a project-wide operation is running: an export,
   *  a voice-apply-all bulk regen, a captions-apply re-render, or a
   *  motion-apply-all re-render. THIS is the flag UI uses to gate
   *  global edits — per-scene regens DO NOT trip it, so the user can
   *  edit scene 1 image, regen scene 7 video, and queue scene 5
   *  audio all at the same time without locking each other out. */
  const bulkOp = jobs.find((j) => j.bulkKind !== null) ?? null;
  const bulkOpActive = !!bulkOp;
  const bulkOpKind = bulkOp?.bulkKind ?? null;

  // Aggregate progress across every in-flight job in the bulk batch.
  // Sharing the same bulkKind = same user-initiated operation. For an
  // export there's typically one job; for voice/motion-apply-all there
  // are N parallel jobs and we average their progress so the modal
  // shows realistic project-wide completion. Pending rows count as 0.
  const bulkBatch = bulkOpKind ? jobs.filter((j) => j.bulkKind === bulkOpKind) : [];
  const bulkOpProgress = bulkBatch.length > 0
    ? Math.round(bulkBatch.reduce((acc, j) => acc + j.progress, 0) / bulkBatch.length)
    : 0;
  const bulkOpJobCount = bulkBatch.length;

  return {
    jobs,
    tasksForScene,
    bulkAudioRegenActive,
    anyRegenActive,
    bulkOpActive,
    bulkOpKind,
    bulkOpProgress,
    bulkOpJobCount,
  };
}
