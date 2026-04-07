/**
 * Qwen3 TTS via Replicate API.
 *
 * Used for cinematic projects only. Supports:
 *   - custom_voice mode with preset speakers
 *   - style_instruction for emotion/tone control per scene
 *   - Multi-language (English, French, Spanish, Chinese, Japanese, Korean, etc.)
 *
 * Haitian Creole is NOT supported by Qwen3 — falls back to existing Gemini TTS path.
 */

import { supabase } from "../lib/supabase.js";
import { writeApiLog } from "../lib/logger.js";

const REPLICATE_API_URL = "https://api.replicate.com/v1/models/qwen/qwen3-tts/predictions";

/** Map of display names → Qwen3 internal speaker names */
export const SPEAKER_MAP: Record<string, string> = {
  "Nova":    "Serena",
  "Atlas":   "Aiden",
  "Kai":     "Dylan",
  "Marcus":  "Eric",
  "Luna":    "Ono_anna",
  "Leo":     "Ryan",
  "Maya":    "Sohee",
  "Sage":    "Uncle_fu",
  "Aria":    "Vivian",
  "Adam":    "Aiden",   // Legacy English male → Qwen3
  "River":   "Serena",  // Legacy English female → Qwen3
};

/** Map our language codes to Qwen3 language names */
const LANGUAGE_MAP: Record<string, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  auto: "auto",
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function uploadAudio(
  bytes: Uint8Array, contentType: string, projectId: string, sceneNumber: number,
): Promise<string> {
  const ext = contentType.includes("wav") ? "wav" : "mp3";
  const filePath = `${projectId}/scene_${sceneNumber}_qwen3_${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("audio")
    .upload(filePath, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data: signedData, error: signError } = await supabase.storage
    .from("audio")
    .createSignedUrl(filePath, 604800);
  if (signError || !signedData?.signedUrl) throw new Error(`Signed URL failed: ${signError?.message}`);
  return signedData.signedUrl;
}

export interface Qwen3TTSOptions {
  text: string;
  sceneNumber: number;
  projectId: string;
  speaker?: string;        // Display name (e.g. "Nova") — mapped internally
  language?: string;       // Our language code (e.g. "en", "fr")
  styleInstruction?: string; // AI-generated tone/emotion instruction
}

/**
 * Generate audio using Qwen3 TTS via Replicate.
 */
export async function generateQwen3TTS(
  opts: Qwen3TTSOptions,
  replicateApiKey: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const { text, sceneNumber, projectId, speaker = "Nova", language = "en", styleInstruction } = opts;

  if (!text || text.trim().length < 2) {
    return { url: null, error: "No text" };
  }

  const startTime = Date.now();

  // Resolve speaker name
  const qwenSpeaker = SPEAKER_MAP[speaker] || "Serena";
  const qwenLanguage = LANGUAGE_MAP[language] || "auto";

  console.log(
    `[Qwen3TTS] Scene ${sceneNumber}: speaker=${qwenSpeaker} lang=${qwenLanguage}` +
    (styleInstruction ? ` style="${styleInstruction.substring(0, 60)}"` : "")
  );

  const input: Record<string, unknown> = {
    text,
    mode: "custom_voice",
    speaker: qwenSpeaker,
    language: qwenLanguage,
  };

  if (styleInstruction) {
    input.style_instruction = styleInstruction;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Create prediction
      const createRes = await fetch(REPLICATE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${replicateApiKey}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input }),
      });

      if (!createRes.ok) {
        const errBody = await createRes.text();
        console.warn(`[Qwen3TTS] Scene ${sceneNumber}: attempt ${attempt} create failed (${createRes.status}): ${errBody.substring(0, 200)}`);
        if ((createRes.status === 429 || createRes.status >= 500) && attempt < 3) {
          await sleep(3000 * attempt);
          continue;
        }
        return { url: null, error: `Qwen3 TTS ${createRes.status}: ${errBody.substring(0, 100)}` };
      }

      let pred = await createRes.json() as any;

      // Poll until complete (Prefer: wait should return completed, but fallback to polling)
      let pollCount = 0;
      while (pred.status !== "succeeded" && pred.status !== "failed" && pred.status !== "canceled") {
        if (pollCount++ > 60) {
          return { url: null, error: "Qwen3 TTS timed out after 60 polls" };
        }
        await sleep(2000);
        const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
          headers: { Authorization: `Bearer ${replicateApiKey}` },
        });
        pred = await pollRes.json();
      }

      if (pred.status === "failed") {
        const errMsg = pred.error || "Unknown error";
        console.warn(`[Qwen3TTS] Scene ${sceneNumber}: prediction failed: ${errMsg}`);
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        return { url: null, error: `Qwen3 TTS failed: ${errMsg}` };
      }

      // Get the output URL
      const outputUrl = typeof pred.output === "string"
        ? pred.output
        : pred.output?.url?.() || pred.output;

      if (!outputUrl || typeof outputUrl !== "string") {
        console.warn(`[Qwen3TTS] Scene ${sceneNumber}: no output URL in response`, JSON.stringify(pred.output).substring(0, 200));
        if (attempt < 3) { await sleep(2000); continue; }
        return { url: null, error: "Qwen3 TTS returned no audio URL" };
      }

      // Download the audio
      const audioRes = await fetch(outputUrl);
      if (!audioRes.ok) {
        return { url: null, error: `Failed to download Qwen3 audio: ${audioRes.status}` };
      }

      const bytes = new Uint8Array(await audioRes.arrayBuffer());
      if (bytes.length < 100) {
        return { url: null, error: "Qwen3 TTS returned empty audio" };
      }

      // Upload to Supabase storage
      const url = await uploadAudio(bytes, "audio/wav", projectId, sceneNumber);
      const durationSeconds = Math.max(1, bytes.length / (44100 * 2)); // rough estimate for 16-bit mono WAV

      console.log(`[Qwen3TTS] Scene ${sceneNumber}: success (${bytes.length} bytes, ~${durationSeconds.toFixed(1)}s)`);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "qwen3", model: "qwen3-tts", status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch(() => {});
      return { url, durationSeconds, provider: `Qwen3 TTS (${speaker})` };

    } catch (err) {
      console.warn(`[Qwen3TTS] Scene ${sceneNumber}: attempt ${attempt} error: ${(err as Error).message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  writeApiLog({ userId: undefined, generationId: undefined, provider: "qwen3", model: "qwen3-tts", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: "Qwen3 TTS failed after 3 attempts" }).catch(() => {});
  return { url: null, error: "Qwen3 TTS failed after 3 attempts" };
}
