/**
 * Audio phase handler for the Node.js worker.
 * Mirrors handleAudioPhase() from supabase/functions/generate-video/index.ts.
 * No execution-time ceiling — runs until all scenes in the batch have audio.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateSceneAudio, type AudioConfig, type AudioScene } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";

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
    .select("*, projects!inner(voice_type, voice_id, voice_name, presenter_focus)")
    .eq("id", generationId)
    .single();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const voiceType = generation.projects?.voice_type || "standard";
  const voiceGender = generation.projects?.voice_name || "female"; // "male"|"female"

  // Custom voice: only assign if voice_type === "custom" AND voice_id exists
  if (voiceType === "custom" && generation.projects?.voice_id) {
    config.customVoiceId = generation.projects.voice_id;
  }
  config.voiceGender = voiceGender;

  // Haitian Creole detection from presenter_focus field
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  if (presenterFocus && isHaitianCreole(presenterFocus)) {
    config.forceHaitianCreole = true;
  }

  const scenes = (generation.scenes || []) as any[];

  // Batch size: 1 for Haitian Creole (slow), 3 for others
  const currentScene = scenes[startIndex];
  const isHC = config.forceHaitianCreole || isHaitianCreole(currentScene?.voiceover || "");
  const BATCH_SIZE = isHC ? 1 : 3;

  const batchEnd = Math.min(startIndex + BATCH_SIZE, scenes.length);
  console.log(`[Audio] Processing scenes ${startIndex + 1}-${batchEnd} of ${scenes.length}`);

  // Track existing audio URLs (from previous chunks)
  const audioUrls: (string | null)[] = scenes.map((s: any) => s.audioUrl ?? null);
  let totalAudioSeconds = 0;
  let audioGenerated = 0;

  // Process batch (parallel for non-HC, sequential for HC)
  const batchScenes: { scene: AudioScene; index: number }[] = [];
  for (let i = startIndex; i < batchEnd; i++) {
    if (audioUrls[i]) continue; // already done
    batchScenes.push({
      index: i,
      scene: { number: i + 1, voiceover: scenes[i].voiceover || "", duration: scenes[i].duration || 8 },
    });
  }

  const processBatch = async () => {
    const promises = batchScenes.map(({ scene, index }) =>
      generateSceneAudio(scene, config).then((result) => ({ result, index }))
    );
    return Promise.all(promises);
  };

  const results = await processBatch();

  for (const { result, index } of results) {
    if (result.url) {
      audioUrls[index] = result.url;
      totalAudioSeconds += result.durationSeconds || 0;
      audioGenerated++;
    } else {
      console.warn(`[Audio] Scene ${index + 1} failed: ${result.error}`);
    }
  }

  // Write updated audio URLs back to DB
  const updatedScenes = scenes.map((s: any, i: number) => ({
    ...s,
    audioUrl: audioUrls[i],
    _meta: { ...(s._meta || {}), statusMessage: `Audio ${i < batchEnd ? "complete" : "pending"}` },
  }));

  const hasMore = batchEnd < scenes.length;
  const overallAudioSeconds = scenes.reduce((sum: number, s: any) => {
    if (!s.audioUrl) return sum;
    return sum + (s.duration || 8);
  }, totalAudioSeconds);

  const progress = Math.min(39, 10 + Math.floor((batchEnd / scenes.length) * 30));

  await supabase
    .from("generations")
    .update({ progress, scenes: updatedScenes })
    .eq("id", generationId);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "audio_chunk_completed",
    message: `Audio chunk done: ${audioGenerated} scenes, hasMore=${hasMore}`,
    details: { startIndex, batchEnd, audioGenerated, hasMore, audioSeconds: totalAudioSeconds },
  });

  return {
    success: true,
    audioGenerated,
    hasMore,
    nextStartIndex: hasMore ? batchEnd : undefined,
    audioSeconds: totalAudioSeconds,
    progress,
    phaseTime: Date.now() - phaseStart,
  };
}
