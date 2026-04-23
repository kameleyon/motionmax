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
}

type Row = {
  id: string;
  task_type: string;
  status: string;
  payload: Record<string, unknown> | null;
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
        .select('id, task_type, status, payload')
        .eq('project_id', projectId!)
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return ((data ?? []) as Row[])
        .filter((r) => isActiveTask(r.task_type))
        .map((r) => ({
          id: r.id,
          taskType: r.task_type as ActiveTask,
          sceneIndex: typeof r.payload?.sceneIndex === 'number'
            ? (r.payload.sceneIndex as number)
            : null,
          status: r.status as 'pending' | 'processing',
        }));
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

  /** Any regen of any kind running anywhere in the project. Used to
   *  lock the timeline clips + Inspector tabs so the user can't
   *  layer a new change onto a scene while its previous regen is
   *  still in flight (the second change would silently lose to the
   *  first worker's write-back). */
  const anyRegenActive = jobs.length > 0;

  return { jobs, tasksForScene, bulkAudioRegenActive, anyRegenActive };
}
