/**
 * Audio phase handler for the Node.js worker.
 * Mirrors handleAudioPhase() from supabase/functions/generate-video/index.ts.
 * No execution-time ceiling — runs until all scenes in the batch have audio.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateSceneAudio, type AudioConfig, type AudioScene } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

// ── Types ──────────────────────────────────────────────────────────

interface AudioPayload {
  generationId: string;
  projectId: string;
  audioStartIndex?: number;
  [key: string]: unknown;
}

interface AudioResult {
  success: boolean;
  audioGenerated: number;
  hasMore: boolean;
  nextStartIndex?: number;
  audioSeconds: number;
  progress: number;
  phaseTime: number;
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleAudioPhase(
  jobId: string,
  payload: AudioPayload,
  userId?: string,
): Promise<AudioResult> {
  const phaseStart = Date.now();
  const { generationId, projectId } = payload;
  const startIndex = typeof payload.audioStartIndex === "number" ? payload.audioStartIndex : 0;

  // Collect API keys from env
  const googleApiKeys = [
    process.env.GOOGLE_TTS_API_KEY_3,
    process.env.GOOGLE_TTS_API_KEY_2,
    process.env.GOOGLE_TTS_API_KEY,
  ].filter(Boolean) as string[];

  const config: AudioConfig = {
    projectId,
    googleApiKeys,
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
    lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
    fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
    replicateApiKey: process.env.REPLICATE_API_KEY || "",
  };

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "audio_phase_started",
    message: `Audio phase started at index ${startIndex}`,
  });

  // Fetch generation + project voice settings
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const voiceType = generation.projects?.voice_type || "standard";
  const voiceGender = generation.projects?.voice_name || "female"; // "male"|"female"

  // Custom voice: only assign if voice_type === "custom" AND voice_id exists
  if (voiceType === "custom" && generation.projects?.voice_id) {
    config.customVoiceId = generation.projects.voice_id;
  }
  config.voiceGender = voiceGender;

  // Language resolution: payload → project voice_inclination → scenes[0]._meta.language
  const resolvedLanguage =
    (payload as any).language ||
    generation.projects?.voice_inclination ||
    (Array.isArray(generation.scenes) && (generation.scenes as any[])[0]?._meta?.language) ||
    undefined;
  if (resolvedLanguage) {
    config.language = resolvedLanguage;
    console.log(`[Audio] Language resolved: ${resolvedLanguage}`);
  }

  // Haitian Creole detection from presenter_focus — matches edge function pattern
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const forceCreoleFromPresenter =
    pfLower.includes("haitian") ||
    pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") ||
    pfLower.includes("creole") ||
    isHaitianCreole(presenterFocus);
  if (forceCreoleFromPresenter) {
    config.forceHaitianCreole = true;
  }

  const scenes = (generation.scenes || []) as any[];

  // Track existing audio URLs
  const audioUrls: (string | null)[] = scenes.map((s: any) => s.audioUrl ?? null);
  let totalAudioSeconds = 0;
  let audioGenerated = 0;

  // Initialize per-scene progress tracking
  initSceneProgress(jobId, scenes.length, "audio_generation");
  // Mark scenes that already have audio as complete
  for (let i = 0; i < scenes.length; i++) {
    if (audioUrls[i]) {
      await updateSceneProgress(jobId, i, "complete", {
        message: `Scene ${i + 1} audio already generated`,
        flush: false,
      });
    }
  }
  await flushSceneProgress(jobId);

  // Process all scenes in batches of 3-5
  const BATCH_SIZE = 3;

  for (let batchStart = startIndex; batchStart < scenes.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, scenes.length);
    console.log(`[Audio] Processing scenes ${batchStart + 1}-${batchEnd} of ${scenes.length}`);

    const batchScenes: { scene: AudioScene; index: number }[] = [];
    for (let i = batchStart; i < batchEnd; i++) {
      if (audioUrls[i]) continue; // already done
      batchScenes.push({
        index: i,
        scene: { number: i + 1, voiceover: scenes[i].voiceover || "", duration: scenes[i].duration || 8 },
      });
    }

    if (batchScenes.length > 0) {
      // Mark scenes in this batch as generating
      for (const { index } of batchScenes) {
        await updateSceneProgress(jobId, index, "generating", {
          message: `Generating audio for scene ${index + 1}`,
          flush: false,
        });
      }
      await flushSceneProgress(jobId);

      const promises = batchScenes.map(({ scene, index }) =>
        generateSceneAudio(scene, config).then((result) => ({ result, index }))
      );

      const results = await Promise.all(promises);

      for (const { result, index } of results) {
        if (result.url) {
          audioUrls[index] = result.url;
          totalAudioSeconds += result.durationSeconds || 0;
          audioGenerated++;
          await updateSceneProgress(jobId, index, "complete", {
            message: `Scene ${index + 1} audio complete (${(result.durationSeconds || 0).toFixed(1)}s)`,
            flush: false,
          });
        } else {
          console.warn(`[Audio] Scene ${index + 1} failed: ${result.error}`);
          await updateSceneProgress(jobId, index, "failed", {
            message: `Scene ${index + 1} audio failed`,
            error: result.error,
            flush: false,
          });
        }
      }

      await flushSceneProgress(jobId);
    }

    // Update progress periodically
    const progress = Math.min(39, 10 + Math.floor((batchEnd / scenes.length) * 30));
    const updatedScenes = scenes.map((s: any, i: number) => ({
      ...s,
      audioUrl: audioUrls[i],
      _meta: { ...(s._meta || {}), statusMessage: `Audio ${i < batchEnd ? "complete" : "pending"}` },
    }));

    await supabase
      .from("generations")
      .update({ progress, scenes: updatedScenes })
      .eq("id", generationId);
  }

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "audio_phase_completed",
    message: `Audio phase done: ${audioGenerated} scenes`,
    details: { audioGenerated, audioSeconds: totalAudioSeconds },
  });

  clearSceneProgress(jobId);

  return {
    success: true,
    audioGenerated,
    hasMore: false,
    audioSeconds: totalAudioSeconds,
    progress: 40,
    phaseTime: Date.now() - phaseStart,
  };
}
