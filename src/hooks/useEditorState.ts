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

function classifySceneStatus(raw: Record<string, unknown>): EditorScene['status'] {
  const hasError = Boolean((raw._meta as Record<string, unknown> | undefined)?.error);
  if (hasError) return 'fail';
  if (raw.videoUrl) return 'done';
  if ((raw._meta as Record<string, unknown> | undefined)?.rendering) return 'render';
  if (raw.imageUrl) return 'image';
  if (raw.audioUrl) return 'audio';
  return 'queue';
}

/** Coerce the jsonb `scenes` array into typed EditorScene objects. */
export function normalizeScenes(raw: unknown): EditorScene[] {
  if (!Array.isArray(raw)) return [];
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
      status: classifySceneStatus(r),
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
}

function phaseFromGeneration(g: Generation | null): EditorPhase {
  if (!g) return 'idle';
  const s = (g.status ?? '').toLowerCase();
  if (s === 'complete' || s === 'completed' || s === 'done') return 'ready';
  if (s === 'failed' || s === 'error') return 'error';
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
    refetchInterval: 3000,
    // Keep polling even when the tab is backgrounded. Users commonly
    // switch tabs during a 3-5 min cinematic render; if refetch only
    // fires in foreground, the query can serve stale null for the
    // entire duration and the page looks frozen when they switch back.
    refetchIntervalInBackground: true,
    // staleTime: 0 guarantees every refetch hits the network instead
    // of returning the cached (possibly null) generation. Without
    // this, React Query can decide a 3s-old result is still "fresh"
    // and skip re-running queryFn, trapping the UI in the awaiting
    // state long after the worker has written the row.
    staleTime: 0,
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

      // Stale-complete race guard — if the row says status='complete'
      // but `scenes` is null/empty/not-an-array, the worker is mid-flush
      // (finalize wrote status before the jsonb UPDATE landed, OR a
      // concurrent read-modify-write race with the atomic RPC fallback
      // path blew away scenes temporarily). Prefer any previously-cached
      // state over an empty "complete" snapshot so the UI doesn't jump
      // from rendering → empty-ready → ready-with-scenes. Without this
      // guard the Editor briefly paints "0 scenes" after finalize.
      const rawScenes = generation?.scenes;
      const isComplete = (generation?.status ?? '').toLowerCase() === 'complete';
      const scenesLookEmpty = !Array.isArray(rawScenes) || rawScenes.length === 0;
      if (isComplete && scenesLookEmpty) {
        const prev = queryClient.getQueryData<EditorState>(
          editorStateKey(projectId, user?.id),
        );
        if (prev && prev.scenes.length > 0) {
          console.warn(
            '[useEditorState] complete+empty scenes detected — keeping previous cache until next poll',
          );
          return prev;
        }
      }

      const scenes = normalizeScenes(rawScenes);
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
        phase: phaseFromGeneration(generation),
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
  });
}
