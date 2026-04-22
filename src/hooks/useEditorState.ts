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
    queryKey: ['editor-state', projectId, user?.id],
    enabled: !!user && !!projectId,
    queryFn: async (): Promise<EditorState> => {
      const { data: project, error: projErr } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId!)
        .maybeSingle();
      if (projErr) throw projErr;
      if (!project) throw new Error('Project not found');

      const { data: generation } = await supabase
        .from('generations')
        .select('*')
        .eq('project_id', projectId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const scenes = normalizeScenes(generation?.scenes);
      const intake = ((project.intake_settings ?? {}) as IntakeSettings) || {};
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
