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
import { audit, auditError } from "../lib/audit.js";
import { updateSceneField, updateSceneFieldJson } from "../lib/sceneUpdate.js";
import { retryDbRead } from "../lib/retryClassifier.js";
import { generateGeminiFlashTTS, generateGeminiFlashTTSChunked } from "../services/geminiFlashTTS.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import { probeDuration, runFfmpeg, detectSilences, type SilenceInterval } from "./export/ffmpegCmd.js";

interface MasterAudioPayload {
  generationId: string;
  projectId: string;
  language?: string;
}

/** Legacy-speaker → audio router config (Fish / LemonFox paths). */
const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
  "Jacques":  { gender: "male",   language: "fr" },
  "Camille":  { gender: "female", language: "fr" },
  "Eddy":     { gender: "male",   language: "fr" },
  "Mario":    { gender: "male",   language: "fr" },
  "Misko":    { gender: "male",   language: "fr" },
  "Robert":   { gender: "male",   language: "fr" },
  "Miriam":   { gender: "female", language: "fr" },
  "Ludovic":  { gender: "male",   language: "fr" },
  "Richard":  { gender: "male",   language: "fr" },
  "William":  { gender: "male",   language: "fr" },
  "Claudel":  { gender: "male",   language: "fr" },
  "Roselie":  { gender: "female", language: "en" },
  "Emily":    { gender: "female", language: "en" },
  "Melanie":  { gender: "female", language: "en" },
  "Tatiana":  { gender: "female", language: "en" },
  "Micha":    { gender: "female", language: "en" },
  "Carlos":   { gender: "male",   language: "es" },
  "Isabella": { gender: "female", language: "es" },
  "Adam":     { gender: "male",   language: "en" },
  "River":    { gender: "female", language: "en" },
  // Named built-in Fish s2-pro voices — router picks them up via
  // AudioConfig.speakerName (see NAMED_FISH_VOICES in audioRouter.ts).
  "Zuri":     { gender: "female", language: "en" },
  "Morpheus": { gender: "male",   language: "en" },
  "Jacynthe": { gender: "female", language: "en" },
  "Phoebe":   { gender: "female", language: "en" },
};

interface SceneSlice {
  startMs: number;
  sliceMs: number;
  words: number;
}

/**
 * Compute per-scene audio slices from the master track.
 *
 * Each scene's slice determines (a) the per-scene audioUrl used by the
 * editor + captions and (b) the per-scene clip DURATION used to size
 * visuals during export. Getting these durations right is what keeps
 * the video frame in sync with the narration.
 *
 * Two-stage approach:
 *   1. Word-count proportion gives an initial ESTIMATE of where each
 *      scene's narration ends in the master.
 *   2. Each internal boundary is then snapped to the nearest detected
 *      SILENCE (natural pause) within ±SNAP_WINDOW_MS. This means slices
 *      land in pauses rather than mid-word, and per-scene durations
 *      track the real narration pace instead of a uniform words-per-
 *      second guess.
 *
 * The LAST boundary is always pinned to the true master duration so the
 * final scene covers all remaining audio — this eliminates the
 * "last frame freezes while the narrator keeps talking" tail that the
 * old word-count-only slicing produced (its rounded slices summed
 * short of the master length).
 *
 * Pass `silences = []` to get the pure word-count behavior (still with
 * the last boundary pinned) — used as the graceful fallback when
 * silence detection is unavailable.
 */
function buildSceneSlices(
  scenes: Array<{ voiceover?: unknown }>,
  durationMs: number,
  silences: SilenceInterval[],
): SceneSlice[] {
  const n = scenes.length;
  const wordsPerScene = scenes.map((s) =>
    typeof s.voiceover === "string"
      ? s.voiceover.trim().split(/\s+/).filter(Boolean).length
      : 0,
  );
  const totalWords = wordsPerScene.reduce((a, b) => a + b, 0) || 1;

  if (n <= 1) {
    return [{ startMs: 0, sliceMs: Math.max(500, Math.round(durationMs)), words: wordsPerScene[0] ?? 0 }];
  }

  // Stage 1 — estimated cumulative END (ms) of each scene by word share.
  const estBoundary: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += (wordsPerScene[i] / totalWords) * durationMs;
    estBoundary.push(acc);
  }

  // Silence midpoints (ms) are the candidate cut points.
  const cutPoints = silences
    .map((s) => ((s.start + s.end) / 2) * 1000)
    .filter((ms) => ms > 0 && ms < durationMs)
    .sort((a, b) => a - b);

  const SNAP_WINDOW_MS = 2000; // snap a boundary to a pause within ±2s
  const MIN_SLICE_MS = 300;    // keep every slice non-trivial + monotonic

  // Stage 2 — snap each INTERNAL boundary (0..n-2) to nearest pause,
  // keeping boundaries strictly increasing. Last boundary = master end.
  const boundary: number[] = new Array(n);
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    const target = estBoundary[i];
    let best = target;
    let bestDist = SNAP_WINDOW_MS + 1;
    for (const cp of cutPoints) {
      if (cp <= prev + MIN_SLICE_MS) continue;       // would make scene i too short
      if (cp >= durationMs - MIN_SLICE_MS) break;    // leave room for last scene
      const d = Math.abs(cp - target);
      if (d < bestDist) { bestDist = d; best = cp; }
    }
    const snapped = bestDist <= SNAP_WINDOW_MS ? best : target;
    boundary[i] = Math.max(prev + MIN_SLICE_MS, Math.min(snapped, durationMs - MIN_SLICE_MS));
    prev = boundary[i];
  }
  boundary[n - 1] = durationMs; // last scene → all remaining audio

  // Boundaries → slices.
  const slices: SceneSlice[] = [];
  let startMs = 0;
  for (let i = 0; i < n; i++) {
    const endMs = boundary[i];
    slices.push({
      startMs: Math.round(startMs),
      sliceMs: Math.max(500, Math.round(endMs - startMs)),
      words: wordsPerScene[i],
    });
    startMs = endMs;
  }
  return slices;
}

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
  return "Speak Natural human pace matching the topic and emotion requires, conversational tone with natural pauses and human expression, match the energy of the topic, while remaining clear and very human";
}

export async function handleMasterAudio(
  jobId: string,
  payload: MasterAudioPayload,
  userId?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; masterAudioUrl: string; masterAudioDurationMs: number; provider: string }> {
  const { generationId, projectId } = payload;

  try {
    return await _runMasterAudio(jobId, payload, userId, signal);
  } catch (err) {
    await auditError("voice.tts_failed", err, {
      jobId, projectId, userId, generationId,
      details: { phase: "master_audio" },
    });
    throw err;
  }
}

async function _runMasterAudio(
  jobId: string,
  payload: MasterAudioPayload,
  userId?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; masterAudioUrl: string; masterAudioDurationMs: number; provider: string }> {
  const { generationId, projectId } = payload;

  // Server-side dedup: refuse to run if an OLDER pending/processing
  // master_audio job for this same project is still in flight. The
  // client also guards against this but races + multi-tab clicks +
  // rage-clicks can sneak duplicates through; this is the belt to
  // their suspenders. Without it, two concurrent master_audio jobs
  // burn the Gemini Tier-1 TPM and one of them 429s.
  const { data: olderJobs } = await supabase
    .from("video_generation_jobs")
    .select("id, created_at, status")
    .eq("project_id", projectId)
    .eq("task_type", "master_audio")
    .in("status", ["pending", "processing"])
    .neq("id", jobId)
    .order("created_at", { ascending: true });

  const hasOlderInFlight = (olderJobs ?? []).some(
    (j: { created_at: string; id: string }) =>
      new Date(j.created_at).getTime() < Date.now() - 1000, // older by more than 1s
  );

  if (hasOlderInFlight) {
    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_info",
      eventType: "master_audio_skipped_duplicate",
      message: `Master audio skipped — an older job is still in flight for this project`,
    });
    // Throwing puts this job into 'failed' state via the worker's
    // outer catch, which is the right outcome — the older job will
    // produce the audio; this one would have duplicated work.
    throw new Error("Duplicate master_audio job — an older one is already in flight for this project");
  }

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "master_audio_started",
    message: `Master audio started (1 continuous TTS for all scenes)`,
  });

  await audit("voice.tts_started", {
    jobId, projectId, userId, generationId,
    message: `Master audio started (1 continuous TTS)`,
    details: { phase: "master_audio" },
  });

  // Narrow SELECT — only the columns this handler reads. Multi-MB
  // scenes jsonb on heavy projects + concurrent atomic scene writes
  // were statement-timing out under prod load (2026-05-17). The cast
  // unwraps Supabase's array-vs-singleton TS inference quirk.
  type ProjectMeta = {
    voice_type?: string | null;
    voice_id?: string | null;
    voice_name?: string | null;
    presenter_focus?: string | null;
    voice_inclination?: string | null;
  };
  type GenerationRow = { scenes: unknown; projects: ProjectMeta | null };

  const { data: rawGeneration, error: genError } = await retryDbRead(() =>
    supabase
      .from("generations")
      .select("scenes, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
      .eq("id", generationId)
      .maybeSingle()
  );

  if (genError) {
    throw new Error(`Generation fetch failed (${generationId}): ${genError.message}`);
  }
  if (!rawGeneration) {
    throw new Error(`Generation not found: ${generationId}`);
  }
  const generation = rawGeneration as unknown as GenerationRow;

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
  // The text-based isHaitianCreole() detector misclassifies French
  // (and to a lesser extent Spanish/Italian) as Haitian Creole because
  // its indicator list contains words common to multiple Romance
  // languages — "ou", "sa", "pa", "se", "te", "si", "tout", "men", "lè"
  // all appear in French texts and trip the 3-match threshold. When the
  // user has explicitly set a non-Haitian language (voice_inclination =
  // "fr" / "en" / etc.) we trust that signal over the heuristic.
  // Verified 2026-05-09: a French Pelé-history project with
  // voice_name="gm:Gacrux" was being routed to the Haitian-Creole
  // branch, which forces voiceGender="female" and lands every
  // generation on Aoede regardless of the chosen voice.
  const explicitNonHaitianLanguage =
    typeof resolvedLanguage === "string" &&
    resolvedLanguage.length > 0 &&
    resolvedLanguage !== "ht" &&
    resolvedLanguage !== "auto";
  const isHC = resolvedLanguage === "ht" ||
    pfLower.includes("haitian") || pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") || pfLower.includes("creole") ||
    (!explicitNonHaitianLanguage && isHaitianCreole(masterText));

  let result: { url: string | null; durationSeconds?: number; provider?: string; error?: string } =
    { url: null };

  // ── Route to the right TTS provider by voice prefix ──

  // Cloned-voice short-circuit: project's voice_type === "custom" with
  // a voice_id means the user picked their own clone in intake. Skip
  // the prefix-based routing entirely and go through the audio router
  // so Fish s2-pro (or legacy ElevenLabs) handles the whole take.
  const customVoiceFromProject =
    generation.projects?.voice_type === "custom" && generation.projects?.voice_id
      ? generation.projects.voice_id as string
      : null;

  if (customVoiceFromProject) {
    const { resolveCustomVoiceProvider } = await import("../services/customVoiceProvider.js");
    const provider = await resolveCustomVoiceProvider(customVoiceFromProject);
    const config: AudioConfig = {
      projectId,
      googleApiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
      fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
      replicateApiKey: process.env.REPLICATE_API_KEY || "",
      customVoiceId: customVoiceFromProject,
      customVoiceProvider: provider,
      language: resolvedLanguage,
      userId: userId ?? null,
      generationId,
    };
    result = await generateSceneAudio(
      { number: 1, voiceover: masterText, duration: Math.ceil(masterText.split(/\s+/).length / 2.5) },
      config,
    );
  } else if (voiceName.startsWith("gm:")) {
    // Gemini Flash — the most common path for doc2video + cinematic.
    // MUST come before the HC branch: Gemini Flash 2.5 speaks Haitian
    // Creole natively, so when the user picks a gm:* voice for an HC
    // project we honor that choice instead of collapsing every voice
    // onto the legacy Pierre/Marie → Aoede/Enceladus pair.
    const googleApiKeys = [
      process.env.GOOGLE_TTS_API_KEY_3,
      process.env.GOOGLE_TTS_API_KEY_2,
      process.env.GOOGLE_TTS_API_KEY,
    ].filter(Boolean) as string[];
    // Chunked TTS: Gemini's 32k token context window can't fit a
    // multi-minute master in a single request. We split at sentence
    // boundaries (~120s per chunk), call in parallel with concurrency
    // cap 3 to stay under Tier 1 TPM, then concat the raw PCM bytes
    // (cheap byte-append since every chunk is 24kHz/mono/16-bit) into
    // one master WAV. Per-chunk failures retry independently.
    result = await generateGeminiFlashTTSChunked({
      masterText,
      sceneNumber: 0, // 0 = master, not a scene
      projectId,
      voiceName,
      language: resolvedLanguage,
      apiKeys: googleApiKeys,
      directives: {
        style: inferStyleInstruction(masterText),
        pacing: "natural human conversational tone pace, normal like a documentary, clear, articulate, measured pace throughout, no variation, no whisper, no fast pace, no screaming, no overly dramatic, no bold etonation, no overly emotional tone.",
      },
      userId: userId ?? null,
      generationId,
      signal,
    });
  } else if (voiceName.startsWith("sm:") || voiceName.startsWith("sm2:")) {
    result = await generateSmallestTTS({
      text: masterText,
      sceneNumber: 0,
      projectId,
      voiceId: voiceName,
      language: resolvedLanguage,
      userId: userId ?? null,
      generationId,
    });
  } else if (isHC) {
    // Legacy Haitian Creole fallback for Pierre / Marie speaker names
    // saved on older projects. New HC projects pick a gm:* voice (see
    // getDefaultSpeaker("ht") = "gm:Sulafat") and take the Gemini Flash
    // chunked path above instead.
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
      userId: userId ?? null,
      generationId,
    };
    result = await generateSceneAudio(
      { number: 1, voiceover: masterText, duration: Math.ceil(masterText.split(/\s+/).length / 2.5) },
      config,
    );
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
      speakerName: voiceName,
      language: legacyMapping?.language || resolvedLanguage,
      userId: userId ?? null,
      generationId,
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

  // Per-scene slices size both the editor's per-scene audio and the
  // per-scene visual clip in the export. Start with the word-count
  // estimate (last boundary pinned to the true master end); this is
  // refined to silence-aligned boundaries below once the master mp3 is
  // on disk. Declared `let` so the silence-aligned pass can replace it.
  let sceneSlices: SceneSlice[] = buildSceneSlices(scenes, durationMs, []);

  // Slice the master audio into per-scene segments via ffmpeg + upload
  // each so the existing scene encoder (which uses scene.audioUrl to
  // size per-scene clips) works unchanged. Trim-only, no re-encode —
  // very fast. Failures fall back to pointing every scene at the
  // master URL, which produces 1 long clip during export (degraded
  // but not broken).
  const sceneAudioUrls: (string | null)[] = new Array(scenes.length).fill(null);
  // Probed actual durations of each slice file (set by ffprobe after
  // ffmpeg writes the slice). Word-proportional sliceMs is only a
  // PLAN — the actual mp3 duration after a seek+trim drifts by tens
  // of ms each scene, and that drift accumulates across the timeline,
  // pulling captions out of sync. We probe each slice and overwrite
  // scene.duration with the real value below.
  const sceneActualMs: number[] = new Array(scenes.length).fill(0);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `master-slice-${generationId.slice(0, 8)}-`));
  try {
    const masterLocal = path.join(tempDir, "master.mp3");
    const resp = await fetch(result.url);
    if (!resp.ok) throw new Error(`Master audio download failed: ${resp.status}`);
    fs.writeFileSync(masterLocal, Buffer.from(await resp.arrayBuffer()));

    // Refine the word-count slices to silence-aligned boundaries so
    // slices land in natural pauses (no mid-word cuts) and per-scene
    // durations match the real narration pace (no visual drift / tail
    // freeze). Non-fatal: on failure we keep the word-count slices.
    try {
      const silences = await detectSilences(masterLocal);
      sceneSlices = buildSceneSlices(scenes, durationMs, silences);
      const snapped = sceneSlices.length;
      console.log(
        `[MasterAudio] Silence-aligned slicing: ${silences.length} pause(s) detected; ` +
        `${snapped} scene boundaries over ${(durationMs / 1000).toFixed(1)}s master`,
      );
    } catch (err) {
      console.warn(
        `[MasterAudio] Silence detection failed — using word-count slices: ${(err as Error).message}`,
      );
    }

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
        // Probe the real duration so captions/clip-length use the
        // actual sliced audio rather than the planned sliceMs.
        try {
          const actualSec = await probeDuration(slicePath);
          sceneActualMs[i] = Math.max(500, Math.round(actualSec * 1000));
        } catch {
          sceneActualMs[i] = sliceMs;
        }
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
    // Use the probed actual slice duration when available; fall back
    // to sliceMs only if probing failed or the slice never wrote.
    const effectiveMs = sceneActualMs[i] || sliceMs;
    try {
      await updateSceneField(generationId, i, "audioUrl", finalAudioUrl);
      await updateSceneField(generationId, i, "duration", String(Math.max(1, Math.round(effectiveMs / 1000))));
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

  await audit("voice.tts_completed", {
    jobId, projectId, userId, generationId,
    message: `Master audio complete (${result.provider ?? "unknown"}, ${(durationMs / 1000).toFixed(1)}s)`,
    details: { phase: "master_audio", provider: result.provider ?? "unknown", durationMs, sceneCount: scenes.length },
  });

  console.log(`[MasterAudio] ✅ ${(durationMs / 1000).toFixed(1)}s via ${result.provider}, sliced across ${scenes.length} scenes`);

  return {
    success: true,
    masterAudioUrl: result.url,
    masterAudioDurationMs: durationMs,
    provider: result.provider ?? "unknown",
  };
}
