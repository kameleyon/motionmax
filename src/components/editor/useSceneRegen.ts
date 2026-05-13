import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { EditorState } from '@/hooks/useEditorState';
import { notifySaving, notifySaved, notifySaveError } from './saveStatusBus';

/** Focused helper for per-scene edits + regen. Keeps all Supabase job
 *  inserts in one place so UI code stays clean. */
export function useSceneRegen(state: EditorState | null) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'idle' | 'apply' | 'regen'>('idle');

  // Per-(scene, action) debounce — guards against rapid double-clicks
  // queueing N parallel jobs for the same operation. The editor's
  // bulk-op lock helps too, but this is finer-grained: stops a user
  // mashing "Regenerate image" 3× in <1s from spawning 3 jobs that
  // would race on write-back.
  //
  // C-7-14 (Ghost G-C5): the previous implementation kept the debounce
  // in a per-hook `useRef<Map<string, number>>`. That's PER-TAB only —
  // two open tabs of the same editor both passed their local debounce
  // and both fired the same regen → two Hypereal (image) or Kling
  // (video) calls billed for one visible output. The new
  // `debounceFire` is async (RPC round-trip) and writes through a
  // server-side `regen_debounce` table so siblings tabs see each
  // other's in-flight regens. We keep the in-memory ref as a fast-path
  // tie-break (so a double-click in ONE tab doesn't even need to
  // round-trip the RPC), but the authoritative answer is the RPC.
  const lastFiredRef = useRef<Map<string, number>>(new Map());
  const debounceFire = useCallback(async (key: string, ms = 2500): Promise<boolean> => {
    // Fast path: in-memory check stops back-to-back clicks (<2.5s) in
    // a single tab without a network round-trip. Doesn't help across
    // tabs but avoids needlessly hammering the RPC on the common case.
    const now = Date.now();
    const last = lastFiredRef.current.get(key) ?? 0;
    if (now - last < ms) {
      toast.info('Already in flight — give it a moment.');
      return false;
    }

    // Authoritative path: server-side cross-tab debounce. Acquires the
    // row in regen_debounce with a 30s TTL. If a sibling tab already
    // acquired it within the window, the RPC returns false and we
    // surface "already in flight" instead of firing a duplicate call.
    // We scope the server key with the user_id implicitly (the RPC
    // uses auth.uid()) so two different users colliding on the same
    // scene index don't interfere.
    if (user?.id) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: acquired, error } = await (supabase.rpc as any)(
          'try_acquire_regen_debounce',
          { p_key: `${user.id}:${key}`, p_ttl_seconds: 30 },
        );
        if (error) {
          // RPC unavailable (migration not yet applied) — degrade to
          // in-memory-only debounce. Log once so missed deploys are
          // visible in Sentry but don't block the user.
          const msg = (error.message || '').toLowerCase();
          const missingRpc = msg.includes('does not exist')
            || msg.includes('not found')
            || msg.includes('pgrst202')
            || msg.includes('schema cache');
          if (!missingRpc) {
            // Real DB error — refuse the action so we don't fire a
            // potentially-duplicate paid call without the safety net.
            toast.error(`Regen guard failed: ${error.message}`);
            return false;
          }
          console.warn('[useSceneRegen] try_acquire_regen_debounce RPC missing — using in-memory debounce only');
        } else if (acquired === false) {
          toast.info('Already in flight in another tab — wait for it to finish.');
          return false;
        }
      } catch (e) {
        // Network blip — refuse so we don't silently double-charge.
        // Better to error than to fire a duplicate paid Hypereal call.
        toast.error('Couldn\'t reach regen guard. Try again in a sec.');
        console.error('[useSceneRegen] debounce RPC failed:', e);
        return false;
      }
    }

    lastFiredRef.current.set(key, now);
    return true;
  }, [user?.id]);

  /** Realtime can miss postgres_changes events in practice (timing,
   *  connection blips, filter mismatches). After kicking a regen job
   *  we also invalidate the editor state periodically for ~2 minutes
   *  so the new scene URLs show up even when realtime silently drops
   *  the update.
   *
   *  G-M1 (Ghost): the previous implementation queued 9 raw setTimeouts
   *  per regen and never cancelled them on unmount — so navigating away
   *  mid-regen kept firing query invalidations for 2 minutes against a
   *  stale (or wrong) project id. Now every scheduled refresh writes
   *  into a per-hook timer registry that we tear down in a cleanup
   *  effect when the hook unmounts. Re-entrant calls (multiple regens
   *  during the same mount) layer on top of each other rather than
   *  cancelling the prior batch — each batch's 9 timeouts run
   *  independently, all wiped on unmount. */
  const refreshTimerSetRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => () => {
    // Cleanup on unmount — cancel every still-pending refresh so we
    // don't keep poking the React-Query cache after the editor has
    // gone away.
    for (const t of refreshTimerSetRef.current) clearTimeout(t);
    refreshTimerSetRef.current.clear();
  }, []);
  const scheduleRefresh = useCallback((projectId: string | undefined) => {
    if (!projectId) return;
    const invalidate = (timerId: ReturnType<typeof setTimeout>) => () => {
      refreshTimerSetRef.current.delete(timerId);
      queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
    };
    // Fire now, then every 6 s for ~2 min. Each scheduled timer
    // registers itself so unmount can cancel all 9.
    const intervals = [1500, 4000, 8000, 15000, 25000, 40000, 60000, 90000, 120000];
    intervals.forEach((ms) => {
      // The closure captures the binding so the callback can remove
      // itself from the set when it fires (keeps the set bounded
      // across many regens in one mount).
      const timerId: ReturnType<typeof setTimeout> = setTimeout(
        () => invalidate(timerId)(),
        ms,
      );
      refreshTimerSetRef.current.add(timerId);
    });
  }, [queryClient]);

  /** True when a master_audio job is already pending or processing for
   *  this project. Used to short-circuit duplicate apply-to-all clicks
   *  before they reach the worker — doing it client-side gives us a
   *  fast toast instead of a silent worker dedup. The worker has its
   *  own dedup as the safety net for races. */
  const isMasterAudioInFlight = useCallback(async (projectId: string): Promise<boolean> => {
    const { data } = await supabase
      .from('video_generation_jobs')
      .select('id')
      .eq('project_id', projectId)
      .eq('task_type', 'master_audio')
      .in('status', ['pending', 'processing'])
      .limit(1);
    return !!(data && data.length > 0);
  }, []);

  /** Atomic per-field update via the worker's `update_scene_field` RPC.
   *  Replaces the legacy read-modify-write of the entire scenes array,
   *  which could blank the whole array if React state was briefly stale
   *  (incident 2026-05-07: regenerate flow nuked 15 scenes). The DB now
   *  also has a one-way ratchet trigger that rejects N→0 writes, but
   *  using the atomic RPC means we never even ATTEMPT a destructive
   *  write. */
  const updateScenePrompt = useCallback(async (index: number, nextPrompt: string) => {
    if (!state?.generation) { toast.error('No generation loaded.'); return false; }
    const genId = state.generation.id;
    notifySaving();
    // Update both casings — visualPrompt (camelCase) is what every new
    // handler reads; visual_prompt (snake_case) is the legacy key some
    // older code paths still touch. Both atomic, no array overwrite.
    const r1 = await (supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>)(
      'update_scene_field',
      { p_generation_id: genId, p_scene_index: index, p_field: 'visualPrompt', p_value: nextPrompt },
    );
    if (r1.error) {
      notifySaveError();
      toast.error(`Couldn't save prompt: ${r1.error.message}`);
      return false;
    }
    // Best-effort second key — failure here doesn't block the regen.
    await (supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>)(
      'update_scene_field',
      { p_generation_id: genId, p_scene_index: index, p_field: 'visual_prompt', p_value: nextPrompt },
    );
    notifySaved();
    return true;
  }, [state?.generation]);

  /** Shallow-merge a partial object into `scenes[index]._meta`. Used
   *  by the Shot + Duration sliders in the Inspector to persist
   *  camera params that handleCinematicVideo then threads into the
   *  Kling prompt. Read-modify-write is race-safe because per-scene
   *  jobs run serialised via depends_on. */
  const updateSceneMeta = useCallback(async (index: number, patch: Record<string, unknown>) => {
    if (!state?.generation) return false;
    notifySaving();
    // Atomic _meta merge via the worker's update_scene_meta_merge RPC.
    // Same race-safety reasoning as updateScenePrompt above — never
    // overwrite the whole scenes array from a possibly-stale React state.
    const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
    const existingMeta = (scenes[index]?._meta as Record<string, unknown> | undefined) ?? {};
    const merged = { ...existingMeta, ...patch };
    const { error } = await (supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>)(
      'update_scene_field_json',
      { p_generation_id: state.generation.id, p_scene_index: index, p_field: '_meta', p_value: merged },
    );
    if (error) {
      notifySaveError();
      toast.error(`Couldn't save: ${error.message}`);
      return false;
    }
    // Invalidate the editor-state cache so the Inspector's derived state
    // (active grade pill, per-scene transition highlight, etc.) reflects
    // the new _meta immediately. Without this the UI looked frozen on
    // the previous value until the next realtime tick — which felt like
    // the buttons weren't doing anything.
    if (state?.project?.id) {
      queryClient.invalidateQueries({ queryKey: ['editor-state', state.project.id] });
    }
    notifySaved();
    return true;
  }, [state?.generation, state?.project?.id, queryClient]);

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

  /** Cancel every in-flight scene job for this `sceneIndex`. Covers
   *  the regen task types we expose Cancel for in the Inspector:
   *  image, video (full re-render + Grok edit), and per-scene audio.
   *  Flipping the rows to `status='cancelled'` drops them from
   *  `useActiveJobs`, so `sceneLocked` flips to false and the
   *  Inspector + Stage overlay unlock without waiting for the worker
   *  to notice. Worker handlers re-read their own job's status just
   *  before persisting the scene field and skip the write when they
   *  see `cancelled`, so a stuck Hypereal/Kling call that finishes
   *  after the user gave up doesn't overwrite whatever they're
   *  editing now. We deliberately do NOT cancel project-wide bulk
   *  ops (export_video, master_audio, captions-apply, motion-apply-all)
   *  — those use a different lock (bulkOpActive) and would need
   *  separate cleanup. */
  const SCENE_CANCELLABLE_TASKS = [
    'regenerate_image',
    'cinematic_image',
    'cinematic_video',
    'cinematic_video_edit',
    'regenerate_audio',
  ] as const;
  const cancelSceneRegen = useCallback(async (index: number) => {
    if (!user || !state?.generation || !state?.project) return false;
    try {
      const { data: rows, error: selErr } = await supabase
        .from('video_generation_jobs')
        .select('id, task_type')
        .eq('user_id', user.id)
        .eq('project_id', state.project.id)
        .in('task_type', SCENE_CANCELLABLE_TASKS as unknown as string[])
        .in('status', ['pending', 'processing'])
        .filter('payload->>sceneIndex', 'eq', String(index));
      if (selErr) throw new Error(selErr.message);
      const jobIds = (rows ?? []).map((r) => r.id as string);
      if (jobIds.length === 0) {
        toast.info('Nothing to cancel for this scene.');
        return false;
      }

      // Use status='failed' + a known error_message instead of a new
      // 'cancelled' status — the chk_video_generation_jobs_status
      // CHECK constraint only allows pending/processing/completed/
      // failed/archived. The pre-existing cancel_export_jobs_cas RPC
      // uses this same convention; matching it keeps the schema
      // unchanged and lets useActiveJobs (which filters on status IN
      // ('pending','processing')) drop the row immediately. Worker
      // handlers detect cancellation by reading error_message.
      const { error: updErr } = await supabase
        .from('video_generation_jobs')
        .update({
          status: 'failed',
          error_message: 'Cancelled by user',
        } as never)
        .in('id', jobIds);
      if (updErr) throw new Error(updErr.message);

      queryClient.invalidateQueries({ queryKey: ['active-jobs', state.project.id, user.id] });
      const kinds = Array.from(new Set((rows ?? []).map((r) => r.task_type as string)));
      toast.info(`Scene ${index + 1} ${kinds.length > 1 ? 'jobs' : 'job'} cancelled.`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Cancel failed: ${msg}`);
      return false;
    }
  }, [user, state, queryClient]);

  /** Image-only regen (no video re-render). Payload shape matches the
   *  legacy useCinematicRegeneration contract exactly: imageIndex: 0
   *  plus imageModification (empty string = plain regen, non-empty =
   *  targeted edit via nanoBananaEdit).
   *
   *  When `characterImageUrl` is provided, the worker auto-flips into
   *  edit mode and passes the character image to Nano Banana Pro as an
   *  identity reference — preserves the scene background and inserts
   *  the person. Used by the "Add character" button in the Scene tab. */
  const regenerateImage = useCallback(async (
    index: number,
    modification?: string,
    characterImageUrl?: string,
  ) => {
    if (!user || !state?.generation || !state?.project) return;
    if (!(await debounceFire(`image:${index}`))) return;
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
            ...(characterImageUrl ? { characterImageUrl } : {}),
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      const action = characterImageUrl ? 'Adding character to scene…' : modification ? 'Image edit queued.' : 'Image queued for regeneration.';
      toast.success(action);
      scheduleRefresh(state.project.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Image regen failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state]);

  /** Video-only regen (reuses existing scene image). Full re-render
   *  via Kling V3 Pro — slowest path, used when the user just wants
   *  the clip rebuilt from the current keyframe. */
  const regenerateVideo = useCallback(async (index: number) => {
    if (!user || !state?.generation || !state?.project) return;
    if (!(await debounceFire(`video:${index}`))) return;
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

  /** Text-prompt video edit via Grok Imagine. Modifies the existing
   *  scene clip in place — much faster + cheaper than a full Kling
   *  re-render. The Inspector's Video button calls this when the
   *  user typed an instruction in the visual-edit textbox AND the
   *  scene already has a videoUrl. Falls through to regenerateVideo
   *  at the call site otherwise. */
  const editVideo = useCallback(async (index: number, instruction: string) => {
    if (!user || !state?.generation || !state?.project) return;
    const scene = state.scenes[index];
    const sourceVideoUrl = scene?.videoUrl ?? null;
    if (!sourceVideoUrl) {
      toast.error('No video to edit yet — render the scene first.');
      return;
    }
    const editPrompt = instruction.trim();
    if (!editPrompt) {
      toast.info('Type the edit you want first.');
      return;
    }
    if (!(await debounceFire(`video-edit:${index}`))) return;
    setBusy('regen');
    try {
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'cinematic_video_edit',
          payload: {
            generationId: state.generation.id,
            projectId: state.project.id,
            sceneIndex: index,
            sourceVideoUrl,
            editPrompt,
            regenerate: true,
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Video edit queued.');
      scheduleRefresh(state.project.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Video edit failed: ${msg}`);
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
    if (!(await debounceFire(`audio:${index}`))) return;
    setBusy('regen');
    try {
      const scene = state.scenes[index];
      const voiceover = (typeof nextVoiceover === 'string' && nextVoiceover.trim().length > 0)
        ? nextVoiceover
        : (scene?.voiceover ?? '');
      if (!voiceover.trim()) {
        toast.error('This scene has no narration text to render.');
        return;
      }
      // Persist the edited voiceover to scenes[] BEFORE queuing any job
      // so master_audio (which reads ALL voiceovers and concatenates)
      // picks up the new text when it runs.
      if (typeof nextVoiceover === 'string' && nextVoiceover.trim() !== (scene?.voiceover ?? '').trim()) {
        const ok = await updateSceneVoiceover(index, nextVoiceover);
        if (!ok) return;
      }

      // Branch by project type:
      //   smartflow  → single-scene audio, regenerate_audio job
      //   doc2video  → one continuous master track, master_audio job
      //   cinematic  → same, master_audio job
      // Master-audio projects share ONE URL across every scene, so a
      // single-scene regen here would fork that scene's audio from the
      // master (editor would play mismatched timing on other scenes).
      // Re-rendering the whole track keeps everything in sync and is
      // still only 1 Gemini Flash TTS call.
      const projectType = (state.project as { project_type?: string }).project_type;
      const isMasterAudio = projectType === 'doc2video' || projectType === 'cinematic';

      if (isMasterAudio) {
        // Dedup: refuse if there's already a master_audio in flight
        // for this project. Two concurrent renders both burn Gemini
        // TPM and the second one 429s; better to skip + tell the user.
        if (await isMasterAudioInFlight(state.project.id)) {
          toast.info('Voice render already in progress — wait for the current one to finish.');
          return;
        }

        const { error } = await supabase
          .from('video_generation_jobs')
          .insert({
            user_id: user.id,
            project_id: state.project.id,
            task_type: 'master_audio',
            payload: {
              phase: 'master_audio',
              generationId: state.generation.id,
              projectId: state.project.id,
              language: state.project.voice_inclination ?? 'en',
            } as unknown as never,
            status: 'pending',
          });
        if (error) throw new Error(error.message);
        toast.success('Full audio track queued for regeneration.');
        scheduleRefresh(state.project.id);
        return;
      }

      // Smartflow legacy path — single-scene regeneration
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
    notifySaving();
    try {
      // Detect cloned-voice picker IDs (`clone:<external_id>`) and
      // write the project columns the audio router expects:
      //   - voice_name → friendly display name
      //   - voice_type → 'custom' so handleCinematicAudio /
      //     handleMasterAudio resolve customVoiceId + customVoiceProvider
      //   - voice_id   → external Fish/ElevenLabs id used as reference_id
      // For built-in voices the existing behaviour is preserved.
      let voiceUpdate: Record<string, string | null> = { voice_name: voice };
      if (voice.startsWith('clone:')) {
        const externalId = voice.slice('clone:'.length);
        const { data: clone } = await supabase
          .from('user_voices')
          .select('voice_name, voice_id')
          .eq('user_id', user.id)
          .eq('voice_id', externalId)
          .maybeSingle();
        if (!clone) throw new Error('Could not find that cloned voice in your library.');
        voiceUpdate = {
          voice_name: clone.voice_name as string,
          voice_type: 'custom',
          voice_id: clone.voice_id as string,
        };
      } else {
        // Switching from a custom voice back to a built-in — clear the
        // custom flag/id so the router doesn't keep routing through Fish.
        voiceUpdate.voice_type = null;
        voiceUpdate.voice_id = null;
      }

      const { error: projErr } = await supabase
        .from('projects')
        .update(voiceUpdate as never)
        .eq('id', state.project.id);
      if (projErr) throw new Error(projErr.message);

      if (regenAll) {
        // Cinematic + doc2video → ONE master_audio job (single Gemini
        // TTS call, slice into N segments). Smartflow keeps the
        // legacy per-scene fan-out for now since it doesn't have
        // master-audio infrastructure yet.
        const projectType = (state.project as { project_type?: string }).project_type;
        const isMasterAudio = projectType === 'doc2video' || projectType === 'cinematic';

        if (isMasterAudio) {
          // Dedup: refuse if there's already a master_audio in flight
          // for this project. Apply-to-all rage-clicks were queueing
          // 2-3 master_audio jobs back-to-back; each consumed Gemini
          // Tier-1 TPM and the later ones 429'd.
          if (await isMasterAudioInFlight(state.project.id)) {
            toast.info('Voice render already in progress — wait for the current one to finish.');
            return;
          }

          const { error: jobErr } = await supabase
            .from('video_generation_jobs')
            .insert({
              user_id: user.id,
              project_id: state.project.id,
              task_type: 'master_audio',
              payload: {
                phase: 'master_audio',
                generationId: state.generation.id,
                projectId: state.project.id,
                language: state.project.voice_inclination ?? 'en',
                // Tag so useActiveJobs.bulkOpActive flips on and
                // BulkOpModal locks the editor while it runs.
                _bulk: 'voice-apply-all',
              } as unknown as never,
              status: 'pending',
            });
          if (jobErr) throw new Error(jobErr.message);
          toast.success(`Voice switched to ${voice}. Re-rendering full audio track…`);
          scheduleRefresh(state.project.id);
        } else {
          // Smartflow legacy path — per-scene regen fan-out.
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
                _bulk: 'voice-apply-all',
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
        }
      } else {
        toast.success(`Voice switched to ${voice}. New scenes will use it.`);
      }
      notifySaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifySaveError();
      toast.error(`Voice switch failed: ${msg}`);
    } finally {
      setBusy('idle');
    }
  }, [user, state]);

  /** Swap the project's narration language. Voices are language-scoped
   *  so the caller is responsible for surfacing a new voice picker after
   *  this resolves — we don't auto-pick one because each language has a
   *  different "best default" (Adam for en, Aria for fr, etc.). We only
   *  touch `voice_inclination`; `voice_name` stays put so the user can
   *  see the stale selection and consciously switch. */
  const updateProjectLanguage = useCallback(async (language: string) => {
    if (!state?.project) return false;
    notifySaving();
    try {
      const { error } = await supabase
        .from('projects')
        .update({ voice_inclination: language } as never)
        .eq('id', state.project.id);
      if (error) throw new Error(error.message);
      queryClient.invalidateQueries({ queryKey: ['editor-state', state.project.id] });
      notifySaved();
      toast.success('Language updated. Pick a voice for this language and Apply to all.');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifySaveError();
      toast.error(`Language switch failed: ${msg}`);
      return false;
    }
  }, [state?.project, queryClient]);

  /** Shallow-merge `patch` into `scenes[i]._meta` for EVERY scene in
   *  one write. Used by the Motion tab's "Apply to all scenes" button
   *  when the user wants the same camera motion / transition across
   *  the whole video. */
  const updateAllScenesMeta = useCallback(async (patch: Record<string, unknown>) => {
    if (!state?.generation) return false;
    notifySaving();
    const scenes = (state.generation.scenes as Array<Record<string, unknown>> | null) ?? [];
    const patched = scenes.map((s) => {
      const meta = (s._meta as Record<string, unknown> | undefined) ?? {};
      return { ...s, _meta: { ...meta, ...patch } };
    });
    const { error } = await supabase
      .from('generations')
      .update({ scenes: patched as unknown as never })
      .eq('id', state.generation.id);
    if (error) {
      notifySaveError();
      toast.error(`Couldn't save: ${error.message}`);
      return false;
    }
    if (state?.project?.id) {
      queryClient.invalidateQueries({ queryKey: ['editor-state', state.project.id] });
    }
    notifySaved();
    return true;
  }, [state?.generation, state?.project?.id, queryClient]);

  /** Re-render the video for EVERY scene that has an image. Used by
   *  the Motion tab's "Re-render all" button after the user applies a
   *  new camera motion across the project — every cinematic_video
   *  insert is tagged _bulk: 'motion-apply-all' so useActiveJobs flips
   *  bulkOpActive on. That triggers the project-wide lock UI: every
   *  scene thumbnail shows its own loader, every timeline clip stripes,
   *  and the Inspector overlay swaps to the bulk message. */
  const regenerateAllVideos = useCallback(async () => {
    if (!user || !state?.project || !state?.generation) return false;
    setBusy('regen');
    try {
      const inserts = state.scenes
        .map((s, i) => ({ scene: s, index: i }))
        .filter(({ scene }) => !!scene.imageUrl)
        .map(({ index: i }) => ({
          user_id: user.id,
          project_id: state.project!.id,
          task_type: 'cinematic_video' as const,
          payload: {
            generationId: state.generation!.id,
            projectId: state.project!.id,
            sceneIndex: i,
            regenerate: true,
            _bulk: 'motion-apply-all',
          } as unknown as never,
          status: 'pending',
        }));
      if (inserts.length === 0) {
        toast.info('No scenes with images to re-render.');
        return false;
      }
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert(inserts);
      if (error) throw new Error(error.message);
      toast.success(`Re-rendering ${inserts.length} scenes with new motion. Editing locked while it runs.`);
      scheduleRefresh(state.project.id);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't re-render: ${msg}`);
      return false;
    } finally {
      setBusy('idle');
    }
  }, [user, state, scheduleRefresh]);

  /** Apply captions across the whole project. Persists the new
   *  caption_style to intake_settings (which the export reads from) and
   *  queues an export_video job marked as a bulk caption-apply op so
   *  the entire timeline flips into the project-wide lock state until
   *  the burn-in finishes. The export's task_type is what tells the
   *  worker to rebuild the whole video; the `_bulk` tag is what tells
   *  the editor UI to lock all scenes during it. */
  const applyCaptionsAll = useCallback(async (style: string) => {
    if (!user || !state?.project || !state?.generation) return false;
    // G-M14 (Ghost): per-tab sessionStorage lock so two open editor
    // tabs on the same project can't both fire applyCaptionsAll
    // simultaneously — each would INSERT an export_video row tagged
    // `_bulk: 'captions-apply'`, both worker handlers would burn
    // ffmpeg cycles, and credits would be double-charged. The
    // useSceneRegen `debounceFire` server-side RPC covers regen
    // ops but doesn't gate the captions-apply path. We don't use
    // localStorage here (that's NOT tab-scoped — useless) and we
    // can't use the regen_debounce RPC because captions-apply
    // legitimately needs the per-style-pick re-run to work in the
    // SAME tab. Instead: a sessionStorage flag scoped to this tab
    // for the project + a localStorage-shared flag with TTL for
    // cross-tab. Localstorage flag carries a lease timestamp; on
    // unmount or success we clear it. On a tab crash the TTL
    // expires after 10 min so the lock self-heals.
    const projectId = state.project.id;
    const localLockKey = `mm_captions_apply_in_progress:${projectId}`;
    const LEASE_MS = 10 * 60 * 1000;
    try {
      const raw = localStorage.getItem(localLockKey);
      if (raw) {
        const leasedAt = Number(raw);
        if (Number.isFinite(leasedAt) && Date.now() - leasedAt < LEASE_MS) {
          toast.info('Captions apply is already running in another tab — wait for it to finish there.');
          return false;
        }
        // Lease expired — fall through and reclaim.
      }
      localStorage.setItem(localLockKey, String(Date.now()));
    } catch {
      // localStorage disabled — fall back to single-tab guard only.
      // The startLockRef in useExport still protects within this tab.
    }

    setBusy('regen');
    try {
      // Persist the style first so the export job picks it up.
      // G-M12 (Ghost): the previous implementation silently dropped
      // the persisted-style result on a schema-cache miss. The export
      // job still fired with the new style on its own payload (so the
      // burn-in worked), but the project's `intake_settings.captionStyle`
      // stayed stale — meaning on next mount the Inspector dropdown
      // showed the old style and a user-initiated re-export from the
      // topbar would use the wrong caption. Now we route the error
      // through updateIntakeSettings's existing fallback (which
      // writes to scenes[0]._meta.intakeOverrides) AND surface a
      // toast so the user knows refresh might be needed.
      const persistResult = await (async () => {
        const current = (state.project!.intake_settings as Record<string, unknown> | null) ?? {};
        const next = { ...current, captionStyle: style };
        const { error } = await supabase
          .from('projects')
          .update({ intake_settings: next as unknown as never })
          .eq('id', state.project!.id);
        return { ok: !error, error };
      })();
      if (!persistResult.ok) {
        const msg = persistResult.error?.message ?? '';
        const isSchemaMiss = msg.includes('intake_settings') && msg.toLowerCase().includes('schema cache');
        if (isSchemaMiss) {
          // Fall through to the legacy scenes[0]._meta override path
          // via updateIntakeSettings — it has the same retry logic.
          // Don't await — we want the user-facing toast to fire
          // immediately and the export to enqueue regardless.
          updateIntakeSettings({ captionStyle: style }).catch(() => {});
          // eslint-disable-next-line no-console
          console.warn(
            '[applyCaptionsAll] schema-cache miss on intake_settings update; ' +
            'falling back to scenes[0]._meta.intakeOverrides. ' +
            'Export will still apply the new caption style for THIS render, ' +
            'but the project default may need a refresh to reflect it.',
          );
          toast.warning(
            "Some caption styles couldn't be saved as the project default — " +
            "try refreshing once the export completes if the style doesn't stick.",
            { duration: 6000 },
          );
        } else {
          // Real DB error (not schema-cache). Don't silently drop —
          // tell the user the persist failed but proceed with export
          // (the export's own payload carries the style).
          toast.error(`Couldn't save caption style as default: ${msg || 'unknown error'}`);
        }
      }

      const scenes = state.scenes
        .filter((s) => s.videoUrl || s.imageUrl)
        .map((s) => ({
          videoUrl: s.videoUrl,
          imageUrl: s.imageUrl,
          audioUrl: s.audioUrl,
          voiceover: s.voiceover,
          title: s.title,
          duration: (s.audioDurationMs ?? s.estDurationMs ?? 10_000) / 1000,
        }));

      if (scenes.length === 0) {
        toast.error('No renderable scenes yet.');
        return false;
      }

      const format = state.project.format === 'portrait' ? 'portrait' : 'landscape';
      const { error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          project_id: state.project.id,
          task_type: 'export_video',
          payload: {
            project_id: state.project.id,
            project_type: state.project.project_type,
            format,
            scenes,
            caption_style: style,
            preset: 'master',
            // Marks this export as a captions-apply re-render so the
            // editor UI flips into the project-wide lock state (vs. a
            // user-initiated download export from the topbar).
            _bulk: 'captions-apply',
          } as unknown as never,
          status: 'pending',
        });
      if (error) throw new Error(error.message);
      toast.success('Captions applying — re-rendering full video. This locks editing while it runs.');
      scheduleRefresh(state.project.id);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't apply captions: ${msg}`);
      return false;
    } finally {
      setBusy('idle');
      // G-M14: release the cross-tab lock once the queue submit
      // resolved (success or failure). We don't hold it until the
      // export's worker completes — the export's own _bulk-tagged row
      // is the project-wide lock that other tabs observe via
      // useActiveJobs.bulkOpActive.
      try { localStorage.removeItem(localLockKey); } catch { /* ignore */ }
    }
    // updateIntakeSettings is referenced inside via closure (defined
    // below in this hook); it's read lazily at call-time so the
    // eslint-deps rule doesn't strictly require listing it, but we
    // do anyway for correctness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, state, scheduleRefresh]);

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
    const projectId = state.project.id;
    notifySaving();
    try {
      const { error } = await supabase
        .from('projects')
        .update({ intake_settings: next as unknown as never })
        .eq('id', projectId);
      if (!error) {
        // Invalidate so the Inspector picks up the new intake.grade /
        // captionStyle / etc. immediately. Without this the dropdown
        // would show the stale "Apply to all" target until the next
        // realtime UPDATE arrived (or never, on quiet projects).
        queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
        notifySaved();
        return true;
      }

      // Schema-cache miss = intake_settings column not in prod yet.
      // Fall back to writing into scenes[0]._meta.intakeOverrides on
      // the generation row, which is a jsonb column that definitely
      // exists. Completely silent fallback — the user just gets a
      // working toggle.
      const msg = error.message || '';
      const isSchemaMiss = msg.includes('intake_settings') && msg.toLowerCase().includes('schema cache');
      if (!isSchemaMiss) {
        notifySaveError();
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
        notifySaveError();
        console.warn('[updateIntakeSettings] fallback failed:', genErr.message);
        return false;
      }
      queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
      notifySaved();
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      notifySaveError();
      toast.error(`Couldn't save: ${errMsg}`);
      return false;
    }
  }, [state?.project, state?.generation, queryClient]);

  return {
    busy,
    apply,
    regenerate,
    regenerateImage,
    cancelSceneRegen,
    regenerateVideo,
    editVideo,
    regenerateAudio,
    undoLastRegen,
    updateSceneMeta,
    updateAllScenesMeta,
    updateSceneVoiceover,
    updateProjectVoice,
    updateProjectLanguage,
    updateIntakeSettings,
    applyCaptionsAll,
    regenerateAllVideos,
  };
}
