import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { EditorState } from '@/hooks/useEditorState';

/** Focused helper for per-scene edits + regen. Keeps all Supabase job
 *  inserts in one place so UI code stays clean. */
export function useSceneRegen(state: EditorState | null) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'idle' | 'apply' | 'regen'>('idle');

  /** Realtime can miss postgres_changes events in practice (timing,
   *  connection blips, filter mismatches). After kicking a regen job
   *  we also invalidate the editor state periodically for ~2 minutes
   *  so the new scene URLs show up even when realtime silently drops
   *  the update. */
  const scheduleRefresh = useCallback((projectId: string | undefined) => {
    if (!projectId) return;
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
    };
    // Fire now, then every 6 s for ~2 min. Clears itself.
    const intervals = [1500, 4000, 8000, 15000, 25000, 40000, 60000, 90000, 120000];
    intervals.forEach((ms) => setTimeout(invalidate, ms));
  }, [queryClient]);

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

  /** Full scene regen: save prompt + queue image regen. (Video is then
   *  a separate one-click via the Video button — less fragile than
   *  chaining depends_on in the job table.) Payload shape matches the
   *  legacy `useCinematicRegeneration` hook so the worker treats it
   *  identically. */
  const regenerate = useCallback(async (index: number, nextPrompt: string) => {
    if (!user || !state?.generation || !state?.project) {
      toast.error('Not ready to regenerate yet.'); return;
    }
    setBusy('regen');
    try {
      const ok = await updateScenePrompt(index, nextPrompt);
      if (!ok) return;

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
            imageIndex: 0,
            imageModification: '',
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Scene queued · re-render video next when the new frame is ready.');
      scheduleRefresh(state.project.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Regenerate failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state, updateScenePrompt]);

  /** Image-only regen (no video re-render). Payload shape matches the
   *  legacy useCinematicRegeneration contract exactly: imageIndex: 0
   *  plus imageModification (empty string = plain regen, non-empty =
   *  targeted edit via nanoBananaEdit). */
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
            imageIndex: 0,
            imageModification: modification ?? '',
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success(modification ? 'Image edit queued.' : 'Image queued for regeneration.');
      scheduleRefresh(state.project.id);
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
      scheduleRefresh(state.project.id);
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

  /** Walk scene[index] back one step via the worker's undo handler.
   *  Matches legacy useCinematicRegeneration.undoRegeneration. */
  const undoLastRegen = useCallback(async (index: number) => {
    if (!user || !state?.generation || !state?.project) return;
    setBusy('regen');
    try {
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'undo_regeneration',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Undo queued — restoring previous version.');
      scheduleRefresh(state.project.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Undo failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state, scheduleRefresh]);

  const regenerateAudio = useCallback(async (index: number, nextVoiceover?: string) => {
    if (!user || !state?.generation || !state?.project) return;
    setBusy('regen');
    try {
      // Always decide which narration text to send. Worker's
      // handleRegenerateAudio throws if `newVoiceover` is missing —
      // that's why previous calls looked like "nothing was sent".
      const scene = state.scenes[index];
      const voiceover = (typeof nextVoiceover === 'string' && nextVoiceover.trim().length > 0)
        ? nextVoiceover
        : (scene?.voiceover ?? '');
      if (!voiceover.trim()) {
        toast.error('This scene has no narration text to render.');
        return;
      }
      if (typeof nextVoiceover === 'string' && nextVoiceover.trim() !== (scene?.voiceover ?? '').trim()) {
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
            newVoiceover: voiceover,
            language: state.project.voice_inclination ?? 'en',
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Voice queued for regeneration.');
      scheduleRefresh(state.project.id);
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
        // Queue a regenerate_audio per scene. `newVoiceover` must be
        // the scene's CURRENT narration text — worker throws without
        // it. Scenes with empty voiceover are skipped (nothing to TTS).
        const inserts = state.scenes
          .map((s, i) => ({ scene: s, index: i }))
          .filter(({ scene }) => (scene.voiceover ?? '').trim().length > 0)
          .map(({ scene, index: i }) => ({
            user_id: user.id,
            project_id: state.project!.id,
            task_type: 'regenerate_audio' as const,
            payload: {
              generationId: state.generation!.id,
              projectId: state.project!.id,
              sceneIndex: i,
              newVoiceover: scene.voiceover ?? '',
              language: state.project!.voice_inclination ?? 'en',
            } as unknown as never,
            status: 'pending',
          }));
        if (inserts.length === 0) {
          toast.info('No scenes with narration to re-render.');
        } else {
          const { error: jobErr } = await supabase
            .from('video_generation_jobs')
            .insert(inserts);
          if (jobErr) throw new Error(jobErr.message);
          toast.success(`Voice switched to ${voice}. Re-rendering ${inserts.length} scenes…`);
          scheduleRefresh(state.project!.id);
        }
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

  /** Shallow-merge `patch` into `scenes[i]._meta` for EVERY scene in
   *  one write. Used by the Motion tab's "Apply to all scenes" button
   *  when the user wants the same camera motion / transition across
   *  the whole video. */
  const updateAllScenesMeta = useCallback(async (patch: Record<string, unknown>) => {
    if (!state?.generation) return false;
    const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
    const patched = scenes.map((s) => {
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

  /** Merge a patch into `projects.intake_settings`, with a fallback
   *  to `generations.scenes[0]._meta.intakeOverrides` when that column
   *  hasn't been migrated into the live DB yet. The fallback keeps
   *  captions + style persistent across reloads (export handler can
   *  read either location), so the user never sees the raw PGRST
   *  schema-cache error for a simple caption toggle. */
  const updateIntakeSettings = useCallback(async (patch: Record<string, unknown>) => {
    if (!state?.project) return false;
    const current = (state.project.intake_settings as Record<string, unknown> | null) ?? {};
    const next = { ...current, ...patch };
    try {
      const { error } = await supabase
        .from('projects')
        .update({ intake_settings: next as unknown as never })
        .eq('id', state.project.id);
      if (!error) return true;

      // Schema-cache miss = intake_settings column not in prod yet.
      // Fall back to writing into scenes[0]._meta.intakeOverrides on
      // the generation row, which is a jsonb column that definitely
      // exists. Completely silent fallback — the user just gets a
      // working toggle.
      const msg = error.message || '';
      const isSchemaMiss = msg.includes('intake_settings') && msg.toLowerCase().includes('schema cache');
      if (!isSchemaMiss) {
        toast.error(`Couldn't save: ${msg}`);
        return false;
      }

      if (!state.generation) return false;
      const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
      if (scenes.length === 0) return false;
      const scene0 = scenes[0];
      const meta0 = (scene0._meta as Record<string, unknown> | undefined) ?? {};
      const overrides = (meta0.intakeOverrides as Record<string, unknown> | undefined) ?? {};
      const mergedOverrides = { ...overrides, ...patch };
      const patchedScenes = scenes.map((s, i) =>
        i === 0
          ? { ...s, _meta: { ...meta0, intakeOverrides: mergedOverrides } }
          : s,
      );
      const { error: genErr } = await supabase
        .from('generations')
        .update({ scenes: patchedScenes as unknown as never })
        .eq('id', state.generation.id);
      if (genErr) {
        console.warn('[updateIntakeSettings] fallback failed:', genErr.message);
        return false;
      }
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't save: ${errMsg}`);
      return false;
    }
  }, [state?.project, state?.generation]);

  return {
    busy,
    apply,
    regenerate,
    regenerateImage,
    regenerateVideo,
    regenerateAudio,
    undoLastRegen,
    updateSceneMeta,
    updateAllScenesMeta,
    updateSceneVoiceover,
    updateProjectVoice,
    updateIntakeSettings,
  };
}
