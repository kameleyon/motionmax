/**
 * Lyria 3 Pro (Preview) music generation — DIRECT Google Generative
 * Language API call, bypassing Hypereal.
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/lyria-3-pro-preview:generateContent?key={GOOGLE_TTS_API_KEY_2}
 *
 * Why direct-to-Google instead of Hypereal:
 *   Hypereal's `/api/v1/audio/generate` returns 404 for Lyria IDs.
 *   Their `/v1/audio/generate` accepts `lyria-3-pro` but we hit other
 *   issues there. Google's API is the upstream source of truth and we
 *   already use GOOGLE_TTS_API_KEY_{1,2,3} for Gemini Flash TTS — this
 *   reuses the same key rotation (defaults to KEY_2 per user request).
 *
 * Response shape expected: Gemini-style — `candidates[0].content.parts[0].inlineData.data`
 * containing base64 audio. If Google ships Lyria with a different
 * response shape we log the raw body on failure so we can adapt.
 *
 * Public surface:
 *   generateLyriaMusic({ prompt, durationSec, apiKey, genre, intensity })
 *     → returns a public URL to an uploaded mp3 track.
 */

import { supabase } from "../lib/supabase.js";

const LYRIA_MODEL = "lyria-3-pro-preview";
const LYRIA_ENDPOINT = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${LYRIA_MODEL}:generateContent?key=${apiKey}`;

const log = {
  info: (...args: unknown[]) => console.log("[Lyria]", ...args),
  warn: (...args: unknown[]) => console.warn("[Lyria]", ...args),
};

export type LyriaMusicGenre =
  | "Cinematic" | "Electronic" | "Acoustic" | "Ambient"
  | "Hip-hop" | "Jazz" | "Orchestral";

export interface LyriaMusicParams {
  /** Free-form prompt describing the music. We enhance this with
   *  genre + intensity hints before sending. */
  prompt: string;
  /** Track length in seconds (informational only — Lyria picks its own
   *  length based on the prompt). Clamped 10–120. */
  durationSec: number;
  /** Ignored — we use GOOGLE_TTS_API_KEY_2 from env directly. Kept for
   *  backward compatibility with callers still passing the Hypereal key. */
  apiKey?: string;
  genre?: LyriaMusicGenre;
  /** 0–100 intensity. <35 → bed, 35-64 → balanced, 65+ → driving. */
  intensity?: number;
}

function buildLyriaPrompt(p: LyriaMusicParams): string {
  const intensity = typeof p.intensity === "number" ? p.intensity : 55;
  const energy = intensity < 35 ? "bed / ambient / sub-voice"
               : intensity < 65 ? "balanced / mid-tempo"
               : "driving / energetic / high-energy";
  const genreLine = p.genre ? `Genre: ${p.genre}.` : "";
  const userLine = p.prompt?.trim() ? `Context: ${p.prompt.trim()}.` : "";
  const durationLine = `Approximate length: ${Math.max(10, Math.min(120, Math.round(p.durationSec)))} seconds.`;
  return [
    genreLine,
    `Energy: ${energy}.`,
    userLine,
    durationLine,
    "Instrumental only, no vocals. Loopable. Duck-ready so voiceover sits on top clearly.",
  ].filter(Boolean).join(" ");
}

/** Base64 PCM → Buffer. */
function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

/** Upload a generated audio buffer to the `audio` bucket and return
 *  the public URL. */
async function uploadAudio(buf: Buffer, projectId: string | undefined, label: string): Promise<string> {
  const folder = projectId ?? "shared";
  const fileName = `${folder}/lyria-${label}-${Date.now()}.mp3`;
  const { error: uploadErr } = await supabase.storage
    .from("audio")
    .upload(fileName, buf, { contentType: "audio/mpeg", upsert: true });
  if (uploadErr) throw new Error(`Lyria upload failed: ${uploadErr.message}`);
  const { data } = supabase.storage.from("audio").getPublicUrl(fileName);
  return data.publicUrl;
}

/** Returns the API keys in priority order: KEY_2 first (user asked
 *  for the "B" key), then KEY_3, then KEY_1 as fallbacks. */
function resolveGoogleKeys(): string[] {
  return [
    process.env.GOOGLE_TTS_API_KEY_2,
    process.env.GOOGLE_TTS_API_KEY_3,
    process.env.GOOGLE_TTS_API_KEY,
  ].filter((k): k is string => typeof k === "string" && k.length > 0);
}

export async function generateLyriaMusic(
  params: LyriaMusicParams & { projectId?: string; label?: string },
): Promise<string> {
  const apiKeys = resolveGoogleKeys();
  if (apiKeys.length === 0) {
    throw new Error("No GOOGLE_TTS_API_KEY_{1,2,3} configured — cannot call Lyria");
  }

  const prompt = buildLyriaPrompt(params);
  const label = (params as { label?: string }).label ?? "music";
  const projectId = (params as { projectId?: string }).projectId;

  log.info(`generating ${Math.round(params.durationSec)}s ${label}, genre=${params.genre ?? "n/a"}, intensity=${params.intensity ?? "n/a"}`);

  // Gemini-style request body (Lyria is in the same model family).
  // Audio modality tells the model to return inlineData audio.
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
    },
  };

  const MAX_ATTEMPTS = 3;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const apiKey = apiKeys[(attempt - 1) % apiKeys.length];
    try {
      const res = await fetch(LYRIA_ENDPOINT(apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastError = `Lyria ${res.status}: ${errText.slice(0, 400)}`;
        log.warn(`attempt ${attempt}/${MAX_ATTEMPTS} ${lastError}`);
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          // Non-retriable (bad key / malformed payload). Bail.
          throw new Error(lastError);
        }
        // 429 / 5xx → retry with next key
        if (attempt < MAX_ATTEMPTS) {
          const backoff = 2000 * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new Error(lastError);
      }

      const data = await res.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
          finishReason?: string;
        }>;
      };

      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "OTHER") {
        throw new Error(`Lyria blocked by finishReason=${candidate.finishReason}`);
      }

      const inlineData = candidate?.content?.parts?.[0]?.inlineData;
      const b64 = inlineData?.data;
      const mimeType = inlineData?.mimeType ?? "audio/mpeg";

      if (!b64 || typeof b64 !== "string") {
        lastError = `Lyria response missing audio data: ${JSON.stringify(data).slice(0, 400)}`;
        log.warn(`attempt ${attempt}/${MAX_ATTEMPTS} ${lastError}`);
        if (attempt < MAX_ATTEMPTS) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
        throw new Error(lastError);
      }

      const audioBuf = base64ToBuffer(b64);
      if (audioBuf.length < 2000) {
        throw new Error(`Lyria returned too-short audio (${audioBuf.length} bytes)`);
      }

      const publicUrl = await uploadAudio(audioBuf, projectId, label);
      log.info(`✅ ${label} ready (${audioBuf.length} bytes, mime=${mimeType}) → ${publicUrl.slice(0, 80)}`);
      return publicUrl;
    } catch (err) {
      lastError = (err as Error).message;
      log.warn(`attempt ${attempt}/${MAX_ATTEMPTS} threw: ${lastError}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  throw new Error(lastError || `Lyria failed after ${MAX_ATTEMPTS} attempts`);
}

/** Readiness probe — true if any GOOGLE_TTS_API_KEY_{1,2,3} is set. */
export function lyriaIsConfigured(): boolean {
  return resolveGoogleKeys().length > 0;
}
