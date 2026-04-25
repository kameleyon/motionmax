/**
 * Cinematic audio handler — Qwen3 TTS via Replicate.
 *
 * For cinematic projects, uses Qwen3 TTS with:
 *   - custom_voice mode (preset speakers)
 *   - style_instruction per scene (AI-determined tone/emotion)
 *   - Multi-language support
 *
 * Exception: Haitian Creole falls back to existing Gemini TTS path
 * since Qwen3 doesn't support Creole.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField, updateSceneFieldJson } from "../lib/sceneUpdate.js";
import { probeDuration } from "./export/ffmpegCmd.js";

/** Probe the MP3 duration of `audioUrl` via ffprobe and merge
 *  `audioDurationMs` into the scene's `_meta`. Best-effort — if the
 *  probe fails we fall back to silent word-count estimation and the
 *  Editor timeline uses that via estDurationMs instead. */
async function recordAudioDurationMs(
  generationId: string,
  sceneIndex: number,
  audioUrl: string,
): Promise<void> {
  try {
    const durationSec = await probeDuration(audioUrl);
    const ms = Math.max(500, Math.round(durationSec * 1000));
    // Read current _meta, merge audioDurationMs in, write back. Race is
    // negligible because per-scene jobs are serialised via depends_on.
    const { data: gen } = await supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle();
    const scenes = Array.isArray(gen?.scenes) ? (gen!.scenes as any[]) : [];
    const existingMeta = (scenes[sceneIndex]?._meta ?? {}) as Record<string, unknown>;
    await updateSceneFieldJson(generationId, sceneIndex, "_meta", {
      ...existingMeta,
      audioDurationMs: ms,
    });
    console.log(`[CinematicAudio] Scene ${sceneIndex}: audioDurationMs=${ms}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CinematicAudio] Scene ${sceneIndex}: duration probe skipped — ${msg}`);
  }
}
// Qwen3 TTS (Replicate) disabled — kept around in case we re-enable later.
// import { generateQwen3TTS } from "../services/qwen3TTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
import { generateGeminiFlashTTS } from "../services/geminiFlashTTS.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

interface CinematicAudioPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  language?: string;
}

/** Infer a style_instruction from the voiceover text for Qwen3 TTS. */
function inferStyleInstruction(voiceover: string): string {
  const lower = voiceover.toLowerCase();

  // Detect emotional cues from content
  if (lower.includes("shocking") || lower.includes("unbelievable") || lower.includes("mind-blowing"))
    return "Speak with dramatic shock and disbelief, building intensity";
  if (lower.includes("secret") || lower.includes("hidden") || lower.includes("nobody knew"))
    return "Speak in a hushed, conspiratorial tone that draws the listener in";
  if (lower.includes("war") || lower.includes("battle") || lower.includes("fought"))
    return "Speak with gravity and intensity, like a war documentary narrator";
  if (lower.includes("love") || lower.includes("heart") || lower.includes("beautiful"))
    return "Speak with warmth and tenderness, gentle but compelling";
  if (lower.includes("death") || lower.includes("died") || lower.includes("tragedy"))
    return "Speak with somber reverence, slow and respectful";
  if (lower.includes("victory") || lower.includes("won") || lower.includes("triumph"))
    return "Speak with rising excitement and celebration";
  if (lower.includes("danger") || lower.includes("escape") || lower.includes("run"))
    return "Speak with urgency and breathless tension";
  if (lower.includes("laugh") || lower.includes("funny") || lower.includes("joke"))
    return "Speak with playful amusement and a hint of laughter";
  if (lower.includes("question") || lower.includes("what if") || lower.includes("why"))
    return "Speak with curiosity and intrigue, inviting the listener to think";

  // Default: viral social media energy
  return "Speak Natural human pace matching the topic and emotion requires, conversational tone with natural pauses and human expression, match the energy of the topic, while remaining clear and very human";
}

export async function handleCinematicAudio(
  jobId: string,
  payload: CinematicAudioPayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_audio_started",
    message: `Cinematic audio started for scene ${sceneIndex}`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found`);

  const voiceover = scene.voiceover || "";

  // Language resolution
  const resolvedLanguage =
    payload.language ||
    generation.projects?.voice_inclination ||
    (Array.isArray(generation.scenes) && (generation.scenes as any[])[0]?._meta?.language) ||
    "en";

  // Haitian Creole detection — falls back to legacy router (Gemini TTS)
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const isHC = resolvedLanguage === "ht" ||
    pfLower.includes("haitian") || pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") || pfLower.includes("creole") ||
    isHaitianCreole(voiceover);

  // Initialize progress
  initSceneProgress(jobId, scenes.length, "cinematic_audio");
  await updateSceneProgress(jobId, sceneIndex, "generating", {
    message: `Generating cinematic audio for scene ${sceneIndex + 1}`,
  });

  let result: { url: string | null; durationSeconds?: number; provider?: string; error?: string };

  if (isHC) {
    // ── Haitian Creole: use legacy Gemini TTS path ──
    console.log(`[CinematicAudio] Scene ${sceneIndex}: Haitian Creole → legacy Gemini TTS`);
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
      voiceGender: generation.projects?.voice_name === "Pierre" ? "male"
        : generation.projects?.voice_name === "Marie" ? "female"
        : generation.projects?.voice_name || "female",
      forceHaitianCreole: true,
      language: "ht",
    };

    if (generation.projects?.voice_type === "custom" && generation.projects?.voice_id) {
      config.customVoiceId = generation.projects.voice_id;
      const { resolveCustomVoiceProvider } = await import("../services/customVoiceProvider.js");
      config.customVoiceProvider = await resolveCustomVoiceProvider(generation.projects.voice_id);
    }

    result = await generateSceneAudio(
      { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
      config,
    );
  } else {
    const voiceName = generation.projects?.voice_name || "Nova";

    // ── Cloned voice short-circuit ──────────────────────────────────
    // If the project has a custom voice (Fish or ElevenLabs clone),
    // route straight through the audio router — its CASE 0 branch
    // handles Fish s2-pro reference_id rendering. Without this guard
    // the rest of this function tries to match voice_name against the
    // built-in roster (Adam/River/Pierre/etc) and rejects custom names
    // like "DavidFrench" or "MyClonedVoice" with "voice not supported".
    if (generation.projects?.voice_type === "custom" && generation.projects?.voice_id) {
      const { resolveCustomVoiceProvider } = await import("../services/customVoiceProvider.js");
      const customVoiceProvider = await resolveCustomVoiceProvider(generation.projects.voice_id);
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
        customVoiceId: generation.projects.voice_id,
        customVoiceProvider,
        language: resolvedLanguage,
      };
      result = await generateSceneAudio(
        { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
        config,
      );
    } else

    // ── Gemini 3.1 Flash TTS (gm:*) — French / Spanish / Italian / German / Dutch ──
    // Google's multilingual voices. NO cross-provider fallback — if the
    // call fails, the scene fails. Style directives are inferred from the
    // voiceover text so the narration feels alive instead of flat.
    if (voiceName.startsWith("gm:")) {
      console.log(`[CinematicAudio] Scene ${sceneIndex}: ${voiceName} → Gemini 3.1 Flash TTS (lang=${resolvedLanguage})`);
      const googleApiKeys = [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[];

      const styleInstruction = inferStyleInstruction(voiceover);
      result = await generateGeminiFlashTTS({
        text: voiceover,
        sceneNumber: sceneIndex + 1,
        projectId,
        voiceName,
        language: resolvedLanguage,
        apiKeys: googleApiKeys,
        directives: {
          style: styleInstruction,
          pacing: "natural human conversational tone pace, varied — push forward in hook/action beats, soften into reflective moments",
          accent: undefined, // auto-inferred from narration language
        },
      });

      if (!result.url) {
        await updateSceneProgress(jobId, sceneIndex, "failed", {
          message: `Scene ${sceneIndex + 1} Gemini Flash TTS failed`,
          error: result.error,
        });
        clearSceneProgress(jobId);
        throw new Error(`Audio generation failed: ${result.error}`);
      }

      await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);

      const wordCount = (scene.voiceover || "").trim().split(/\s+/).length;
      const estimatedDuration = Math.max(3, Math.ceil(wordCount / 2.5));
      await updateSceneField(generationId, sceneIndex, "duration", String(estimatedDuration));
      // Best-effort: ffprobe the TTS mp3 and record the true duration
      // so the Editor timeline can size scene clips to the narration.
      await recordAudioDurationMs(generationId, sceneIndex, result.url);

      await updateSceneProgress(jobId, sceneIndex, "complete", {
        message: `Scene ${sceneIndex + 1} cinematic audio complete (${result.provider})`,
      });
      clearSceneProgress(jobId);

      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_info",
        eventType: "cinematic_audio_completed",
        message: `Cinematic audio completed for scene ${sceneIndex} (${result.provider})`,
      });
      return { success: true, status: "complete", sceneIndex, audioUrl: result.url };
    }

    // ── Smallest.ai (ADDITIVE) — English + Spanish voice variety ──
    // Speaker IDs prefixed with `sm:` route to the new Smallest provider.
    // Note: `sm2:*` (Lightning v2) voices were removed because quality was
    // poor — Google's Gemini Flash voices (gm:*) replaced them. Any legacy
    // saved project referencing a `sm2:*` voice still matches here and will
    // fail cleanly through generateSmallestTTS with a clear error.
    if (voiceName.startsWith("sm:") || voiceName.startsWith("sm2:")) {
      console.log(`[CinematicAudio] Scene ${sceneIndex}: ${voiceName} → Smallest TTS (lang=${resolvedLanguage})`);
      result = await generateSmallestTTS({
        text: voiceover,
        sceneNumber: sceneIndex + 1,
        projectId,
        voiceId: voiceName,
        language: resolvedLanguage,
      });

      if (!result.url) {
        await updateSceneProgress(jobId, sceneIndex, "failed", {
          message: `Scene ${sceneIndex + 1} Smallest audio generation failed`,
          error: result.error,
        });
        clearSceneProgress(jobId);
        throw new Error(`Audio generation failed: ${result.error}`);
      }

      await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);

      const wordCount = (scene.voiceover || "").trim().split(/\s+/).length;
      const estimatedDuration = Math.max(3, Math.ceil(wordCount / 2.5));
      await updateSceneField(generationId, sceneIndex, "duration", String(estimatedDuration));
      // Best-effort: ffprobe the TTS mp3 and record the true duration
      // so the Editor timeline can size scene clips to the narration.
      await recordAudioDurationMs(generationId, sceneIndex, result.url);

      await updateSceneProgress(jobId, sceneIndex, "complete", {
        message: `Scene ${sceneIndex + 1} cinematic audio complete (${result.provider})`,
      });
      clearSceneProgress(jobId);

      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_info",
        eventType: "cinematic_audio_completed",
        message: `Cinematic audio completed for scene ${sceneIndex} (${result.provider})`,
      });
      return { success: true, status: "complete", sceneIndex, audioUrl: result.url };
    }

    // ── Fish Audio / LemonFox speakers → legacy audio router ──
    // These map specific speaker names to the standard TTS providers
    // Legacy speakers route to their original TTS providers (Fish Audio / LemonFox)
    const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
      "Jacques":  { gender: "male",   language: "fr" },
      "Camille":  { gender: "female", language: "fr" },
      "Carlos":   { gender: "male",   language: "es" },
      "Isabella": { gender: "female", language: "es" },
      "Adam":     { gender: "male",   language: "en" },
      "River":    { gender: "female", language: "en" },
    };

    const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];

    if (legacyMapping) {
      // Route to Fish Audio / LemonFox via standard audio router
      console.log(`[CinematicAudio] Scene ${sceneIndex}: ${voiceName} → legacy router (${legacyMapping.language}/${legacyMapping.gender})`);

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
        voiceGender: legacyMapping.gender,
        language: legacyMapping.language,
      };

      result = await generateSceneAudio(
        { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
        config,
      );
    } else {
      // Speaker is not Haitian Creole, not `sm:`/`sm2:`/`gm:`, and not in
      // LEGACY_SPEAKER_MAP. Two cases:
      //   1. Orphan Qwen3 name (Nova, Atlas, Kai, Luna, Maya, Aria, Marcus,
      //      Leo, Sage) saved on legacy projects OR defaulted by older UI
      //      builds. User never truly "picked" these — they were just the
      //      default. Silently remap to the nearest legacy equivalent
      //      instead of failing the whole generation.
      //   2. Unknown garbage → still fail.
      const QWEN3_LEGACY_NAMES: Record<string, { name: string; gender: string; language: string }> = {
        "Nova":   { name: "River", gender: "female", language: "en" },
        "Aria":   { name: "River", gender: "female", language: "en" },
        "Luna":   { name: "River", gender: "female", language: "en" },
        "Maya":   { name: "River", gender: "female", language: "en" },
        "Atlas":  { name: "Adam",  gender: "male",   language: "en" },
        "Kai":    { name: "Adam",  gender: "male",   language: "en" },
        "Marcus": { name: "Adam",  gender: "male",   language: "en" },
        "Leo":    { name: "Adam",  gender: "male",   language: "en" },
        "Sage":   { name: "Adam",  gender: "male",   language: "en" },
      };
      const remap = QWEN3_LEGACY_NAMES[voiceName];
      if (remap) {
        console.log(`[CinematicAudio] Scene ${sceneIndex}: legacy speaker "${voiceName}" → remap to "${remap.name}" (${remap.language}/${remap.gender})`);
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
          voiceGender: remap.gender,
          language: remap.language,
        };

        result = await generateSceneAudio(
          { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
          config,
        );
      } else {
        const errMsg =
          `Voice "${voiceName}" is no longer supported. ` +
          `Please reselect a voice (Adam, River, Carlos, Isabella, Jacques, Camille, ` +
          `Pierre, Marie, or any Smallest/Gemini voice) on this project and regenerate.`;
        console.warn(`[CinematicAudio] Scene ${sceneIndex}: ${errMsg}`);
        await updateSceneProgress(jobId, sceneIndex, "failed", {
          message: `Scene ${sceneIndex + 1} audio generation failed`,
          error: errMsg,
        });
        clearSceneProgress(jobId);
        throw new Error(`Audio generation failed: ${errMsg}`);
      }
    }
  }

  if (!result.url) {
    await updateSceneProgress(jobId, sceneIndex, "failed", {
      message: `Scene ${sceneIndex + 1} audio generation failed`,
      error: result.error,
    });
    clearSceneProgress(jobId);
    throw new Error(`Audio generation failed: ${result.error}`);
  }

  await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);

  // Update duration with estimate based on word count (~2.5 words/sec)
  // This replaces the hardcoded "15" or "10" from the script with a realistic value.
  // The export step will probe the actual file for exact duration.
  const wordCount = (scene.voiceover || "").trim().split(/\s+/).length;
  const estimatedDuration = Math.max(3, Math.ceil(wordCount / 2.5));
  await updateSceneField(generationId, sceneIndex, "duration", String(estimatedDuration));
  // Editor timeline uses the exact probed duration to size clips.
  await recordAudioDurationMs(generationId, sceneIndex, result.url);

  await updateSceneProgress(jobId, sceneIndex, "complete", {
    message: `Scene ${sceneIndex + 1} cinematic audio complete (${result.provider})`,
  });
  clearSceneProgress(jobId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_audio_completed",
    message: `Cinematic audio completed for scene ${sceneIndex} (${result.provider})`,
  });

  return { success: true, status: "complete", sceneIndex, audioUrl: result.url };
}
