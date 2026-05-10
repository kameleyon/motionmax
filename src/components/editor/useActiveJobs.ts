import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** In-flight job tracking for a single project. Drives the scene
 *  thumbnail spinners + Inspector button loaders + "Update all" bulk
 *  loaders so users can SEE that something's actually happening after
 *  they click regen.
 *
 *  Wave D §C-5 polling refactor:
 *    realtime healthy  → 30 s keep-alive poll (safety net only)
 *    realtime degraded → 5 s active poll  (fast recovery if WS drops)
 *  The realtime channel is the primary signal; this hook adapts the
 *  poll cadence based on `channel.subscribe` status so the DB QPS is
 *  near-zero in steady state but recovers quickly when the WebSocket
 *  is unhealthy on weak connections. */

export type ActiveTask =
  | 'regenerate_image'
  | 'regenerate_audio'
  | 'cinematic_video'
  | 'cinematic_image'
  | 'cinematic_audio'
  | 'master_audio'
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
    'master_audio',
    'export_video',
  ].includes(t);
}

export function useActiveJobs(projectId: string | null | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Wave D §C-5: track realtime channel health so we can dial down
  // the poll to a keep-alive cadence when WS is healthy and crank it
  // up when the channel drops. 'SUBSCRIBED' = realtime alive →
  // safety-net only; anything else (CLOSED / CHANNEL_ERROR / TIMED_OUT)
  // means we can't trust realtime, so poll faster to bridge the gap.
  const [realtimeHealthy, setRealtimeHealthy] = useState(false);

  const query = useQuery<ActiveJob[]>({
    queryKey: ['active-jobs', projectId, user?.id],
    enabled: !!user && !!projectId,
    // §5 PERF (Wave D §C-5 follow-up) — adaptive poll based on the
    // realtime channel's reported status. With realtime alive the
    // page invalidates this query on INSERT/UPDATE, so 30 s is just
    // a safety net for missed reconnects. When realtime is degraded
    // (offline / CHANNEL_ERROR / TIMED_OUT) we fall back to 5 s so
    // the UI doesn't go stale during a flaky connection.
    refetchInterval: realtimeHealthy ? 30_000 : 5_000,
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
  // Channel filter narrowed to (project_id, user_id) so an admin
  // viewing user A's project can't have user B's job updates
  // accidentally invalidate their cache when both happen to share the
  // same project_id (extremely rare with uuid v4, but the queryKey
  // already varies on user.id so the channel filter must match).
  useEffect(() => {
    if (!projectId || !user?.id) return;
    const channel = supabase
      .channel(`active-jobs-${projectId}-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'video_generation_jobs',
          // Supabase realtime accepts only one filter expression — we
          // pick project_id (the higher-cardinality column) and rely on
          // the queryKey + the queryFn's RLS-scoped read to enforce the
          // user_id boundary on the actual data.
          filter: `project_id=eq.${projectId}`,
        },
        () => queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId, user.id] }),
      )
      .subscribe((status) => {
        // Wave D §C-5: realtime-first polling. SUBSCRIBED means the WS
        // is alive and we'll receive INSERT/UPDATE events; flip to the
        // long keep-alive poll. Any other status (CHANNEL_ERROR,
        // TIMED_OUT, CLOSED) means we can't trust realtime so the
        // hook falls back to a fast 5 s poll until the next attempt.
        setRealtimeHealthy(status === 'SUBSCRIBED');
      });
    return () => {
      setRealtimeHealthy(false);
      supabase.removeChannel(channel);
    };
  }, [projectId, user?.id, queryClient]);

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
