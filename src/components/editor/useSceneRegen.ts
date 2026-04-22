import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { EditorState } from '@/hooks/useEditorState';

/** Focused helper for Apply / Regenerate on a single scene.
 *
 *  Apply  — writes the new prompt text to scenes[index].visualPrompt
 *           without kicking a render. Cheap.
 *  Regenerate — calls Apply then enqueues two worker jobs:
 *           regenerate_image → cinematic_video (depends_on the image
 *           job). Worker already handles the DAG via depends_on. */
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

  const apply = useCallback(async (index: number, nextPrompt: string) => {
    setBusy('apply');
    try {
      const ok = await updateScenePrompt(index, nextPrompt);
      if (ok) toast.success('Prompt saved.');
    } finally {
      setBusy('idle');
    }
  }, [updateScenePrompt]);

  const regenerate = useCallback(async (index: number, nextPrompt: string) => {
    if (!user || !state?.generation || !state?.project) {
      toast.error('Not ready to regenerate yet.'); return;
    }
    setBusy('regen');
    try {
      const ok = await updateScenePrompt(index, nextPrompt);
      if (!ok) return;

      // Queue the two-step regen: new image → new video that depends on
      // the new image. Worker's depends_on logic runs video only after
      // image completes.
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

      toast.success('Scene queued for regeneration. Timeline will update when ready.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Regenerate failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state, updateScenePrompt]);

  const regenerateAudio = useCallback(async (index: number) => {
    if (!user || !state?.generation || !state?.project) {
      toast.error('Not ready to regenerate audio yet.'); return;
    }
    setBusy('regen');
    try {
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
  }, [user, state]);

  return { busy, apply, regenerate, regenerateAudio };
}
