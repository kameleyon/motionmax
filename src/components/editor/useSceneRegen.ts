import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { EditorState } from '@/hooks/useEditorState';

/** Focused helper for per-scene edits + regen. Keeps all Supabase job
 *  inserts in one place so UI code stays clean. */
export function useSceneRegen(state: EditorState | null) {
  const { user } = useAuth();
  const [busy, setBusy] = useState<'idle' | 'apply' | 'regen'>('idle');

  const updateScenePrompt = useCallback(async (index: number, nextPrompt: string) => {
    if (!state?.generation) { toast.error('No generation loaded.'); return false; }
    const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
    const patched = scenes.map((s, i) =>
      i === index
        ? { ...s, visualPrompt: nextPrompt, visual_prompt: nextPrompt }
        : s,
    );
    const { error } = await supabase
      .from('generations')
      .update({ scenes: patched as unknown as never })
      .eq('id', state.generation.id);
    if (error) {
      toast.error(`Couldn't save prompt: ${error.message}`);
      return false;
    }
    return true;
  }, [state?.generation]);

  /** Shallow-merge a partial object into `scenes[index]._meta`. Used
   *  by the Shot + Duration sliders in the Inspector to persist
   *  camera params that handleCinematicVideo then threads into the
   *  Kling prompt. Read-modify-write is race-safe because per-scene
   *  jobs run serialised via depends_on. */
  const updateSceneMeta = useCallback(async (index: number, patch: Record<string, unknown>) => {
    if (!state?.generation) return false;
    const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
    const patched = scenes.map((s, i) => {
      if (i !== index) return s;
      const meta = (s._meta as Record<string, unknown> | undefined) ?? {};
      return { ...s, _meta: { ...meta, ...patch } };
    });
    const { error } = await supabase
      .from('generations')
      .update({ scenes: patched as unknown as never })
      .eq('id', state.generation.id);
    if (error) { toast.error(`Couldn't save: ${error.message}`); return false; }
    return true;
  }, [state?.generation]);

  const apply = useCallback(async (index: number, nextPrompt: string) => {
    setBusy('apply');
    try {
      const ok = await updateScenePrompt(index, nextPrompt);
      if (ok) toast.success('Prompt saved.');
    } finally {
      setBusy('idle');
    }
  }, [updateScenePrompt]);

  /** Full scene regen: image → video (DAG). */
  const regenerate = useCallback(async (index: number, nextPrompt: string) => {
    if (!user || !state?.generation || !state?.project) {
      toast.error('Not ready to regenerate yet.'); return;
    }
    setBusy('regen');
    try {
      const ok = await updateScenePrompt(index, nextPrompt);
      if (!ok) return;

      const { data: imgJob, error: imgErr } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'regenerate_image',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
          } as unknown as never,
          status: 'pending',
        })
        .select('id')
        .single();
      if (imgErr || !imgJob) throw new Error(imgErr?.message || 'Image regen queue failed');

      const { error: vidErr } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'cinematic_video',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
            regenerate: true,
          } as unknown as never,
          status: 'pending',
          depends_on: [imgJob.id] as unknown as never,
        });
      if (vidErr) throw new Error(vidErr.message);

      toast.success('Scene queued for regeneration.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Regenerate failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state, updateScenePrompt]);

  /** Image-only regen (no video re-render). Cheaper when the user
   *  wants a different frame but the motion is fine. */
  const regenerateImage = useCallback(async (index: number, modification?: string) => {
    if (!user || !state?.generation || !state?.project) return;
    setBusy('regen');
    try {
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'regenerate_image',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
            imageModification: modification,
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success(modification ? 'Image edit queued.' : 'Image queued for regeneration.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Image regen failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state]);

  /** Video-only regen (reuses existing scene image). */
  const regenerateVideo = useCallback(async (index: number) => {
    if (!user || !state?.generation || !state?.project) return;
    setBusy('regen');
    try {
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'cinematic_video',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
            regenerate: true,
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Video queued for regeneration.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Video regen failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state]);

  /** Write a new voiceover string to `scenes[index].voiceover` without
   *  rendering. Used by the Voice tab before firing audio regen. */
  const updateSceneVoiceover = useCallback(async (index: number, text: string) => {
    if (!state?.generation) return false;
    const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
    const patched = scenes.map((s, i) => (i === index ? { ...s, voiceover: text } : s));
    const { error } = await supabase
      .from('generations')
      .update({ scenes: patched as unknown as never })
      .eq('id', state.generation.id);
    if (error) { toast.error(`Couldn't save: ${error.message}`); return false; }
    return true;
  }, [state?.generation]);

  const regenerateAudio = useCallback(async (index: number, nextVoiceover?: string) => {
    if (!user || !state?.generation || !state?.project) return;
    setBusy('regen');
    try {
      if (typeof nextVoiceover === 'string') {
        const ok = await updateSceneVoiceover(index, nextVoiceover);
        if (!ok) return;
      }
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'regenerate_audio',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Voice queued for regeneration.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Voice regen failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state, updateSceneVoiceover]);

  /** Swap the project voice (and optionally regen every scene's audio
   *  with the new voice). When `regenAll` is true we also update the
   *  project's `voice_name` column so future scenes inherit it. */
  const updateProjectVoice = useCallback(async (voice: string, regenAll: boolean) => {
    if (!user || !state?.project || !state?.generation) return;
    setBusy('regen');
    try {
      const { error: projErr } = await supabase
        .from('projects')
        .update({ voice_name: voice })
        .eq('id', state.project.id);
      if (projErr) throw new Error(projErr.message);

      if (regenAll) {
        // Queue a regenerate_audio per scene. Worker processes them
        // in parallel so total time is ~2-5× a single scene, not N×.
        const inserts = state.scenes.map((_, i) => ({
          user_id: user.id,
          project_id: state.project!.id,
          task_type: 'regenerate_audio' as const,
          payload: {
            generationId: state.generation!.id,
            projectId: state.project!.id,
            sceneIndex: i,
          } as unknown as never,
          status: 'pending',
        }));
        const { error: jobErr } = await supabase
          .from('video_generation_jobs')
          .insert(inserts);
        if (jobErr) throw new Error(jobErr.message);
        toast.success(`Voice switched to ${voice}. Re-rendering all scenes…`);
      } else {
        toast.success(`Voice switched to ${voice}. New scenes will use it.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Voice switch failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state]);

  return {
    busy,
    apply,
    regenerate,
    regenerateImage,
    regenerateVideo,
    regenerateAudio,
    updateSceneMeta,
    updateSceneVoiceover,
    updateProjectVoice,
  };
}
