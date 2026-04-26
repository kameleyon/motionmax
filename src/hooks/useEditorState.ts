import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

export type Project = Tables<'projects'>;
export type Generation = Tables<'generations'>;

/** Shape of `projects.intake_settings` — mirrors the form's
 *  IntakeSettings type. Keep the optional keys loose so old rows
 *  without certain fields parse cleanly. */
export interface IntakeSettings {
  visualStyle?: string;
  tone?: number;
  camera?: string;
  grade?: string;
  lipSync?: { on?: boolean; strength?: number };
  music?: { on?: boolean; genre?: string; intensity?: number; sfx?: boolean; uploadUrl?: string | null };
  cast?: Array<{ initial: string; name: string; role: 'Narrator' | 'Supporting'; locked: boolean }>;
  characterAppearance?: string;
  captionStyle?: string;
  brandName?: string;
}

/** Normalised per-scene shape. Casts the loose Json from generations
 *  into something the Editor can consume without repeatedly checking
 *  optional keys. */
export interface EditorScene {
  index: number;
  title?: string;
  voiceover?: string;
  visualPrompt?: string;
  imageUrl?: string | null;
  imageUrls?: string[];
  audioUrl?: string | null;
  videoUrl?: string | null;
  audioDurationMs?: number;
  estDurationMs?: number;
  waveformPeaks?: number[];
  status: 'done' | 'render' | 'image' | 'audio' | 'queue' | 'fail';
  meta: Record<string, unknown>;
}

export type EditorPhase = 'rendering' | 'ready' | 'editing' | 'error' | 'idle';

function classifySceneStatus(
  raw: Record<string, unknown>,
  opts: { genComplete?: boolean; isCinematic?: boolean } = {},
): EditorScene['status'] {
  const hasError = Boolean((raw._meta as Record<string, unknown> | undefined)?.error);
  if (hasError) return 'fail';

  // If the generation finalized but this scene is missing an asset
  // its project_type requires, treat it as a FAIL so the Inspector
  // surfaces the regen buttons in an obvious way. Previously these
  // scenes rendered as 'audio' (teal badge) which looked normal and
  // hid the fact that the image never landed.
  if (opts.genComplete) {
    if (!raw.imageUrl) return 'fail';
    if (!raw.audioUrl) return 'fail';
    if (opts.isCinematic && !raw.videoUrl) return 'fail';
  }

  if (raw.videoUrl) return 'done';
  if ((raw._meta as Record<string, unknown> | undefined)?.rendering) return 'render';
  if (raw.imageUrl) return 'image';
  if (raw.audioUrl) return 'audio';
  return 'queue';
}

/** Coerce the jsonb `scenes` array into typed EditorScene objects.
 *  Pass generation status + project type so scenes missing required
 *  assets after completion get promoted to 'fail' status. */
export function normalizeScenes(
  raw: unknown,
  opts: { genStatus?: string | null; projectType?: string | null } = {},
): EditorScene[] {
  if (!Array.isArray(raw)) return [];
  const genComplete = (opts.genStatus ?? '').toLowerCase() === 'complete';
  const isCinematic = opts.projectType === 'cinematic';
  return raw.map((row, i): EditorScene => {
    const r = (row as Record<string, unknown>) || {};
    const meta = (r._meta as Record<string, unknown>) || {};
    return {
      index: i,
      title: typeof r.title === 'string' ? r.title : undefined,
      voiceover: typeof r.voiceover === 'string' ? r.voiceover : undefined,
      visualPrompt: typeof r.visualPrompt === 'string'
        ? r.visualPrompt
        : typeof r.visual_prompt === 'string' ? r.visual_prompt : undefined,
      imageUrl: (r.imageUrl ?? r.image_url ?? null) as string | null,
      imageUrls: Array.isArray(r.imageUrls) ? (r.imageUrls as string[]) : undefined,
      audioUrl: (r.audioUrl ?? r.audio_url ?? null) as string | null,
      videoUrl: (r.videoUrl ?? r.video_url ?? null) as string | null,
      audioDurationMs: typeof meta.audioDurationMs === 'number' ? meta.audioDurationMs : undefined,
      estDurationMs: typeof meta.estDurationMs === 'number' ? meta.estDurationMs : 10_000,
      waveformPeaks: Array.isArray(meta.waveformPeaks) ? (meta.waveformPeaks as number[]) : undefined,
      status: classifySceneStatus(r, { genComplete, isCinematic }),
      meta,
    };
  });
}

export interface EditorState {
  project: Project | null;
  generation: Generation | null;
  scenes: EditorScene[];
  intake: IntakeSettings;
  phase: EditorPhase;
  progress: number;
  aspect: '16:9' | '9:16';
  totalDurationMs: number;
  /** Set by `hydrateEditorStateFromPipeline` — marks this cache entry
   *  as the authoritative in-memory result from the finalize job.
   *  While true, the queryFn refuses to downgrade `scenes` from a
   *  non-empty hydration to an empty DB response, closing the
   *  flash-and-disappear window where the finalize UPDATE hasn't
   *  propagated to the next `refetchInterval` read yet. The flag
   *  clears itself only when a fresh poll returns non-empty scenes
   *  (i.e. the DB has caught up). */
  hydratedFromPipeline?: boolean;
}

/** Unstuck threshold — a generation row sitting on `status='processing'`
 *  for this long without `updated_at` moving is almost certainly dead
 *  (failed upstream job blocked finalize). We flip the phase to 'ready'
 *  so the editor dismisses the rendering overlay and shows whatever
 *  scenes landed, letting the user regenerate the broken ones in-place
 *  instead of sitting on a forever-spinner after a page reload. */
const STALE_RENDERING_MS = 90_000;

function phaseFromGeneration(g: Generation | null, scenes: EditorScene[]): EditorPhase {
  if (!g) return 'idle';
  const s = (g.status ?? '').toLowerCase();
  if (s === 'complete' || s === 'completed' || s === 'done') return 'ready';
  if (s === 'failed' || s === 'error') return 'error';

  // Still nominally 'processing' / 'rendering'. Check if the worker has
  // actually moved recently — if the row hasn't been touched in 90s AND
  // we have at least one scene with an asset landed, treat this as a
  // stalled run and flip to ready. User can regen missing scenes from
  // the Inspector.
  const updatedAt = g.updated_at ? new Date(g.updated_at).getTime() : 0;
  const ageMs = updatedAt ? Date.now() - updatedAt : 0;
  const hasAnyAsset = scenes.some((s) => s.imageUrl || s.audioUrl || s.videoUrl);
  if (updatedAt && ageMs > STALE_RENDERING_MS && hasAnyAsset) {
    return 'ready';
  }

  return 'rendering';
}

/** Query key for the editor state. Exported so consumers (e.g. the
 *  pipeline-completion hydrator in Editor.tsx) can write the cache
 *  directly via `queryClient.setQueryData` without re-deriving the key. */
export const editorStateKey = (projectId: string | null, userId: string | null | undefined) =>
  ['editor-state', projectId, userId] as const;

/** Single source of truth hook for the Editor page. Subscribes to
 *  realtime updates on `generations`, `projects`, and the per-project
 *  `video_generation_jobs` so the UI reflects every scene-level tick.
 */
export function useEditorState(projectId: string | null): {
  state: EditorState | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
} {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: editorStateKey(projectId, user?.id),
    enabled: !!user && !!projectId,
    // Belt-and-suspenders on top of realtime. Supabase realtime can
    // drop INSERT events when the channel is mid-subscription — which
    // is exactly the race that keeps users stuck on "Creating your
    // content…" after a fresh autostart: the generation row is
    // inserted ~3s after the channel subscribes, and if the event
    // arrives first the client was still handshaking and misses it.
    // Polling every 3s guarantees the new generation row is picked up
    // within one cycle regardless of realtime state.
    // Back off to 10s polling once the cache is hydrated from the
    // pipeline — at that point the authoritative result is in memory
    // and the only reason to poll is to reconcile project/intake
    // metadata. Still 3s while rendering so scene-level progress
    // keeps flowing through. Returning `false` would stop polling
    // entirely, but we keep a slow heartbeat so edits (regens, caption
    // tab writes) that bump `generations.updated_at` still get picked
    // up without waiting on realtime.
    refetchInterval: (query) => {
      const data = query.state.data as EditorState | undefined;
      // Once the pipeline is fully hydrated AND the project is in a
      // terminal phase (`ready` / failed), stop polling entirely —
      // realtime + an explicit visibilitychange refetch (set up by
      // React Query's `refetchOnWindowFocus`) cover any drift. This
      // replaces the previous "always poll forever, even on backgrounded
      // tabs" behaviour which produced ~1200 SELECTs/hour per tab.
      if (data?.hydratedFromPipeline) {
        if (data.phase === 'ready') return false;       // stop entirely
        return 10_000;                                  // slow heartbeat
      }
      return 3000;
    },
    // Pause polling on backgrounded tabs to stop the unbounded SELECT
    // amplification on multi-tab sessions. Realtime + the on-focus
    // refetch (default true in React Query) reconcile state when the
    // user comes back; users no longer pay for an idle tab.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    // staleTime 1500 ms collapses duplicate refetches inside a single
    // visible tick (sibling components mounting simultaneously, etc.)
    // without sacrificing the originally intended freshness.
    staleTime: 1500,
    queryFn: async (): Promise<EditorState> => {
      const { data: project, error: projErr } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId!)
        .maybeSingle();
      if (projErr) throw projErr;
      if (!project) throw new Error('Project not found');

      // Generation query errors were previously swallowed silently,
      // which made it impossible to tell whether a null generation
      // meant "not created yet" or "RLS blocked" or "schema mismatch".
      // Log errors (but keep fallback behaviour of treating as idle)
      // so the issue is visible in console and Sentry.
      const { data: generation, error: genErr } = await supabase
        .from('generations')
        .select('*')
        .eq('project_id', projectId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (genErr) {
        console.warn('[useEditorState] generation fetch failed:', genErr.message);
      }

      // Stale-complete race guard — if a prior cache exists with
      // non-empty scenes AND the fresh DB read returns empty scenes,
      // keep the prior cache. This covers two distinct failure modes:
      //
      // 1. Finalize wrote `status='complete'` but the jsonb `scenes`
      //    UPDATE hasn't propagated to this read yet (sub-100ms race,
      //    but 3s polls can land inside it).
      // 2. Worker's `updateSceneFieldJson` fallback does read-modify-
      //    write on the whole `scenes` array. If a read lands during
      //    the write half of that cycle, the row is briefly empty.
      //
      // The guard is STRONGER when the cache was hydrated from the
      // pipeline's in-memory finalize result (`hydratedFromPipeline`) —
      // in that case we know the scenes are authoritative and refuse
      // to downgrade them, regardless of what the DB reports.
      const rawScenes = generation?.scenes;
      const scenesLookEmpty = !Array.isArray(rawScenes) || rawScenes.length === 0;
      if (scenesLookEmpty) {
        const prev = queryClient.getQueryData<EditorState>(
          editorStateKey(projectId, user?.id),
        );
        if (prev && prev.scenes.length > 0) {
          if (prev.hydratedFromPipeline) {
            // Pipeline hydration wins — return it unchanged so the
            // sticky flag keeps protecting scenes on every subsequent
            // poll until the DB catches up with a non-empty response.
            return prev;
          }
          const isComplete = (generation?.status ?? '').toLowerCase() === 'complete';
          if (isComplete) {
            console.warn(
              '[useEditorState] complete+empty scenes detected — keeping previous cache until next poll',
            );
            return prev;
          }
        }
      }

      const scenes = normalizeScenes(rawScenes, {
        genStatus: generation?.status,
        projectType: (project as { project_type?: string })?.project_type,
      });
      // Start from the real `intake_settings` column when present,
      // then merge in `scenes[0]._meta.intakeOverrides` — our silent
      // fallback store used when the prod DB hasn't run the
      // intake_settings migration yet (e.g. captions tab writes).
      const baseIntake = ((project.intake_settings ?? {}) as IntakeSettings) || {};
      const overrides = (scenes[0]?.meta?.intakeOverrides as IntakeSettings | undefined) ?? {};
      const intake: IntakeSettings = { ...baseIntake, ...overrides };
      const aspect: '16:9' | '9:16' = project.format === 'portrait' ? '9:16' : '16:9';
      const totalDurationMs = scenes.reduce(
        (a, s) => a + (s.audioDurationMs ?? s.estDurationMs ?? 10_000),
        0,
      );

      return {
        project,
        generation,
        scenes,
        intake,
        phase: phaseFromGeneration(generation, scenes),
        progress: generation?.progress ?? 0,
        aspect,
        totalDurationMs,
      };
    },
  });

  // Realtime channel — any update on the project, its generation, or a
  // scene-level job invalidates the query so the UI re-fetches once.
  useEffect(() => {
    if (!projectId) return;
    const channel = supabase
      .channel(`editor_${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'generations', filter: `project_id=eq.${projectId}` },
        () => { void queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] }); },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` },
        () => { void queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] }); },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'video_generation_jobs', filter: `project_id=eq.${projectId}` },
        () => { void queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] }); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [projectId, queryClient]);

  return {
    state: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/** Imperative hydrator — call this the moment `useGenerationPipeline`
 *  reports `step === 'complete'`. The finalize job's result payload is
 *  already in memory (the pipeline's in-hook `scenes`), so we can
 *  paint the Editor immediately instead of waiting for the next poll
 *  to re-read `generations.scenes` from Postgres. Mirrors what the
 *  legacy workspaces did implicitly via `generationState.scenes`.
 *
 *  Safe across races:
 *   - Returns early if pipelineScenes normalizes to empty so we never
 *     write a worse "complete+empty" cache than the queryFn already
 *     guards against.
 *   - Merges over any existing cache (preserving project + intake +
 *     aspect) so the next DB round-trip doesn't regress.
 *   - Seeds a minimal cache with no project row if the first poll
 *     hasn't landed yet — scenes render, other metadata fills in
 *     asynchronously. */
export function hydrateEditorStateFromPipeline(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  userId: string | null | undefined,
  pipelineScenes: unknown,
): void {
  const scenes = normalizeScenes(pipelineScenes);
  if (scenes.length === 0) return;

  const key = editorStateKey(projectId, userId);
  const prev = queryClient.getQueryData<EditorState>(key);

  const totalDurationMs = scenes.reduce(
    (a, s) => a + (s.audioDurationMs ?? s.estDurationMs ?? 10_000),
    0,
  );

  if (prev) {
    const nextGeneration: Generation | null = prev.generation
      ? ({ ...prev.generation, status: 'complete', progress: 100 } as Generation)
      : prev.generation;
    queryClient.setQueryData<EditorState>(key, {
      ...prev,
      generation: nextGeneration,
      scenes,
      phase: 'ready',
      progress: 100,
      totalDurationMs,
      hydratedFromPipeline: true,
    });
    return;
  }

  queryClient.setQueryData<EditorState>(key, {
    project: null,
    generation: null,
    scenes,
    intake: {},
    phase: 'ready',
    progress: 100,
    aspect: '16:9',
    totalDurationMs,
    hydratedFromPipeline: true,
  });
}
