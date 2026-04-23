/**
 * Master audio handler — ONE continuous TTS call per generation for
 * doc2video + cinematic, replacing N per-scene `cinematic_audio` jobs.
 *
 * Why: per-scene audio generation burned Gemini quota and broke
 * narrative continuity (each scene was recorded cold). Now:
 *   1. Concatenate all scene voiceovers into one script
 *   2. Call Gemini Flash TTS ONCE (falls back to audio router on failure)
 *   3. ffprobe the result for true duration
 *   4. Write to generations.master_audio_url + master_audio_duration_ms
 *   5. Back-fill every scene's audioUrl with the master URL so existing
 *      editor + export code paths keep working without major changes
 *
 * Smartflow still uses per-scene `cinematic_audio` (it's always been
 * 1-scene anyway, so the two paths produce identical output there).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField, updateSceneFieldJson } from "../lib/sceneUpdate.js";
import { generateGeminiFlashTTS } from "../services/geminiFlashTTS.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import { probeDuration, runFfmpeg } from "./export/ffmpegCmd.js";

interface MasterAudioPayload {
  generationId: string;
  projectId: string;
  language?: string;
}

/** Legacy-speaker → audio router config (Fish / LemonFox paths). */
const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
  "Jacques":  { gender: "male",   language: "fr" },
  "Camille":  { gender: "female", language: "fr" },
  "Carlos":   { gender: "male",   language: "es" },
  "Isabella": { gender: "female", language: "es" },
  "Adam":     { gender: "male",   language: "en" },
  "River":    { gender: "female", language: "en" },
};

function inferStyleInstruction(voiceover: string): string {
  const lower = voiceover.toLowerCase();
  if (lower.includes("shocking") || lower.includes("unbelievable"))
    return "Speak with dramatic shock and disbelief, building intensity";
  if (lower.includes("secret") || lower.includes("hidden"))
    return "Speak in a hushed, conspiratorial tone that draws the listener in";
  if (lower.includes("war") || lower.includes("battle"))
    return "Speak with gravity and intensity, like a war documentary narrator";
  if (lower.includes("love") || lower.includes("heart"))
    return "Speak with warmth and tenderness, gentle but compelling";
  if (lower.includes("death") || lower.includes("tragedy"))
    return "Speak with somber reverence, slow and respectful";
  if (lower.includes("victory") || lower.includes("triumph"))
    return "Speak with rising excitement and celebration";
  return "Speak fast-paced with raw social media energy, punchy rapid-fire delivery, dramatic pauses for emphasis, hype moments that hit like a plot twist, enthusiast, energetic and mysterious, witty and fun, showing all kind of emotion matching the context";
}

export async function handleMasterAudio(
  jobId: string,
  payload: MasterAudioPayload,
  userId?: string
): Promise<{ success: boolean; masterAudioUrl: string; masterAudioDurationMs: number; provider: string }> {
  const { generationId, projectId } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "master_audio_started",
    message: `Master audio started (1 continuous TTS for all scenes)`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const scenes = (generation.scenes as any[]) || [];
  if (scenes.length === 0) throw new Error(`No scenes to concatenate for master audio`);

  // Concatenate all scene voiceovers into one continuous script. The
  // LLM prompt (buildDoc2Video / buildCinematic) already instructs it
  // to write flowing narration across scenes — so joining produces a
  // cohesive track rather than disjoint fragments.
  const masterText = scenes
    .map((s: any) => typeof s.voiceover === "string" ? s.voiceover.trim() : "")
    .filter(Boolean)
    .join(" ");

  if (!masterText) throw new Error(`All scene voiceovers are empty`);

  // Language + voice resolution — identical logic to cinematic_audio.
  const resolvedLanguage =
    payload.language ||
    generation.projects?.voice_inclination ||
    scenes[0]?._meta?.language ||
    "en";

  const voiceName = generation.projects?.voice_name || "Nova";
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const isHC = resolvedLanguage === "ht" ||
    pfLower.includes("haitian") || pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") || pfLower.includes("creole") ||
    isHaitianCreole(masterText);

  let result: { url: string | null; durationSeconds?: number; provider?: string; error?: string } =
    { url: null };

  // ── Route to the right TTS provider by voice prefix ──
  if (isHC) {
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
      voiceGender: voiceName === "Pierre" ? "male" : "female",
      forceHaitianCreole: true,
      language: "ht",
    };
    result = await generateSceneAudio(
      { number: 1, voiceover: masterText, duration: Math.ceil(masterText.split(/\s+/).length / 2.5) },
      config,
    );
  } else if (voiceName.startsWith("gm:")) {
    // Gemini Flash — the most common path for doc2video + cinematic
    const googleApiKeys = [
      process.env.GOOGLE_TTS_API_KEY_3,
      process.env.GOOGLE_TTS_API_KEY_2,
      process.env.GOOGLE_TTS_API_KEY,
    ].filter(Boolean) as string[];
    result = await generateGeminiFlashTTS({
      text: masterText,
      sceneNumber: 0, // 0 = master, not a scene
      projectId,
      voiceName,
      language: resolvedLanguage,
      apiKeys: googleApiKeys,
      directives: {
        style: inferStyleInstruction(masterText),
        pacing: "energetic, varied — push forward in hook/action beats, soften into reflective moments",
      },
    });
  } else if (voiceName.startsWith("sm:") || voiceName.startsWith("sm2:")) {
    result = await generateSmallestTTS({
      text: masterText,
      sceneNumber: 0,
      projectId,
      voiceId: voiceName,
      language: resolvedLanguage,
    });
  } else {
    // Legacy named speakers (Adam, River, Jacques, Camille, Carlos, Isabella)
    // go through the standard audio router.
    const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];
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
      voiceGender: legacyMapping?.gender || "female",
      language: legacyMapping?.language || resolvedLanguage,
    };
    result = await generateSceneAudio(
      { number: 1, voiceover: masterText, duration: Math.ceil(masterText.split(/\s+/).length / 2.5) },
      config,
    );
  }

  if (!result.url) {
    throw new Error(`Master audio generation failed: ${result.error ?? "unknown error"}`);
  }

  // Probe true duration — we need this to stretch visuals to fit.
  let durationMs = Math.round((result.durationSeconds ?? 0) * 1000);
  if (!durationMs) {
    try {
      const sec = await probeDuration(result.url);
      durationMs = Math.max(1000, Math.round(sec * 1000));
    } catch (err) {
      console.warn(`[MasterAudio] ffprobe failed, falling back to word-count estimate: ${(err as Error).message}`);
      durationMs = Math.ceil(masterText.split(/\s+/).length / 2.5) * 1000;
    }
  }

  // Compute each scene's slice based on its voiceover word count
  // proportional to total words. This is what determines how long
  // each scene's visual will be in the final export.
  const totalWords = masterText.split(/\s+/).length || 1;
  const sceneSlices: Array<{ startMs: number; sliceMs: number; words: number }> = [];
  let cursorMs = 0;
  for (const s of scenes) {
    const words = typeof s.voiceover === "string"
      ? s.voiceover.trim().split(/\s+/).filter(Boolean).length
      : 0;
    const sliceMs = Math.max(500, Math.round((words / totalWords) * durationMs));
    sceneSlices.push({ startMs: cursorMs, sliceMs, words });
    cursorMs += sliceMs;
  }

  // Slice the master audio into per-scene segments via ffmpeg + upload
  // each so the existing scene encoder (which uses scene.audioUrl to
  // size per-scene clips) works unchanged. Trim-only, no re-encode —
  // very fast. Failures fall back to pointing every scene at the
  // master URL, which produces 1 long clip during export (degraded
  // but not broken).
  const sceneAudioUrls: (string | null)[] = new Array(scenes.length).fill(null);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `master-slice-${generationId.slice(0, 8)}-`));
  try {
    const masterLocal = path.join(tempDir, "master.mp3");
    const resp = await fetch(result.url);
    if (!resp.ok) throw new Error(`Master audio download failed: ${resp.status}`);
    fs.writeFileSync(masterLocal, Buffer.from(await resp.arrayBuffer()));

    for (let i = 0; i < scenes.length; i++) {
      const { startMs, sliceMs } = sceneSlices[i];
      const slicePath = path.join(tempDir, `scene-${i}.mp3`);
      try {
        await runFfmpeg([
          "-ss", (startMs / 1000).toFixed(3),
          "-t", (sliceMs / 1000).toFixed(3),
          "-i", masterLocal,
          "-c:a", "libmp3lame",
          "-b:a", "128k",
          slicePath,
        ]);
        const sliceBuf = fs.readFileSync(slicePath);
        // Bucket name is `audio` in prod (not `scene-audio`) — matches
        // what geminiFlashTTS uploads to. The wrong name caused every
        // slice to fail and every scene fell back to the full master
        // URL, which made the scene encoder try to render each scene
        // at 158s instead of its proper slice length.
        const fileName = `${projectId}/master-slice-${i}-${Date.now()}.mp3`;
        const { error: uploadErr } = await supabase.storage
          .from("audio")
          .upload(fileName, sliceBuf, { contentType: "audio/mpeg", upsert: true });
        if (uploadErr) {
          console.warn(`[MasterAudio] Scene ${i} slice upload failed: ${uploadErr.message}`);
          sceneAudioUrls[i] = result.url;
        } else {
          const { data } = supabase.storage.from("audio").getPublicUrl(fileName);
          sceneAudioUrls[i] = data.publicUrl;
        }
      } catch (err) {
        console.warn(`[MasterAudio] Scene ${i} slice failed: ${(err as Error).message}`);
        sceneAudioUrls[i] = result.url; // fallback to master URL
      }
    }
  } catch (err) {
    console.warn(`[MasterAudio] Master download failed, using master URL for all scenes: ${(err as Error).message}`);
    for (let i = 0; i < scenes.length; i++) sceneAudioUrls[i] = result.url;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Persist the master-level fields (these are new columns, no race
  // with per-scene jobs touching `scenes`).
  await supabase
    .from("generations")
    .update({
      master_audio_url: result.url,
      master_audio_duration_ms: durationMs,
    })
    .eq("id", generationId);

  // Per-scene updates use ATOMIC jsonb_set RPCs instead of overwriting
  // the whole `scenes` array. Critical: during the 145+ seconds of TTS
  // generation, cinematic_image jobs have been writing scene.imageUrl
  // in parallel via the same atomic RPC. If we did a full-array
  // overwrite here with the `scenes` we read 145s ago, we'd blow away
  // every image written during that window. This loop touches only the
  // fields master_audio owns (audioUrl, duration, slice metadata in
  // _meta) and leaves imageUrl / videoUrl / other fields untouched.
  for (let i = 0; i < scenes.length; i++) {
    const { startMs, sliceMs } = sceneSlices[i];
    const finalAudioUrl = sceneAudioUrls[i] ?? result.url;
    try {
      await updateSceneField(generationId, i, "audioUrl", finalAudioUrl);
      await updateSceneField(generationId, i, "duration", String(Math.max(1, Math.round(sliceMs / 1000))));
      // Read current _meta to preserve keys set by other handlers
      // (characterBible, language, sceneIndex, etc.), then merge our
      // slice fields. Still uses atomic RPC so no read-modify-write
      // race at the field level.
      const { data: currentGen } = await supabase
        .from("generations")
        .select("scenes")
        .eq("id", generationId)
        .maybeSingle();
      const currentScenes = Array.isArray(currentGen?.scenes)
        ? (currentGen!.scenes as any[])
        : [];
      const existingMeta = (currentScenes[i]?._meta ?? {}) as Record<string, unknown>;
      await updateSceneFieldJson(generationId, i, "_meta", {
        ...existingMeta,
        audioDurationMs: sliceMs,
        masterAudioSliceStartMs: startMs,
        masterAudioSliceEndMs: startMs + sliceMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[MasterAudio] Scene ${i} field update failed (non-fatal): ${msg}`);
    }
  }

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "master_audio_completed",
    message: `Master audio complete: ${result.provider ?? "unknown"}, ${(durationMs / 1000).toFixed(1)}s, ${scenes.length} scene slices`,
  });

  console.log(`[MasterAudio] ✅ ${(durationMs / 1000).toFixed(1)}s via ${result.provider}, sliced across ${scenes.length} scenes`);

  return {
    success: true,
    masterAudioUrl: result.url,
    masterAudioDurationMs: durationMs,
    provider: result.provider ?? "unknown",
  };
}
