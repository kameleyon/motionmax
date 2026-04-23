/**
 * Hypereal Lyria 3 Pro music generation.
 *
 * Endpoint: POST https://api.hypereal.cloud/v1/audio/generate
 * (Path is /v1/audio/generate — NOT /api/v1/audio/generate. The /api
 * prefix returns 404. Other working Hypereal services use /v1/...
 * flat: images/, videos/, chat, audio-asr.)
 *
 * Model: `lyria-3-pro` — Google Lyria 3 Pro for professional music.
 * Verified reachable via curl (returns 401 when unauthed, meaning
 * endpoint + model id are accepted).
 *
 * Previously tried direct-to-Google (generativelanguage.googleapis.com
 * with `lyria-3-pro-preview`) but that model on the Generative
 * Language API returns reference tokens ([[A0]]..[[A4]]) + metadata
 * instead of audio — it requires Vertex AI's :predict endpoint with
 * OAuth service-account auth. Hypereal is the pragmatic path: they
 * wrap the audio-gen flow and return a finished MP3 URL.
 */

const LYRIA_ENDPOINT = "https://api.hypereal.cloud/v1/audio/generate";

const log = {
  info: (...args: unknown[]) => console.log("[Lyria]", ...args),
  warn: (...args: unknown[]) => console.warn("[Lyria]", ...args),
};

export type LyriaMusicGenre =
  | "Cinematic" | "Electronic" | "Acoustic" | "Ambient"
  | "Hip-hop" | "Jazz" | "Orchestral";

export interface LyriaMusicParams {
  /** Free-form prompt describing the music. Enhanced with genre +
   *  intensity + duration hints before sending. */
  prompt: string;
  /** Track length in seconds. Clamped 10–120 (Lyria's practical range). */
  durationSec: number;
  /** Hypereal API key (HYPEREAL_API_KEY env var). */
  apiKey: string;
  genre?: LyriaMusicGenre;
  /** 0–100 intensity. <35 → bed, 35-64 → balanced, 65+ → driving. */
  intensity?: number;
  /** Optional — not used by Hypereal path; kept for API compat with
   *  earlier direct-to-Google attempt. */
  projectId?: string;
  label?: string;
}

function buildLyriaPrompt(p: LyriaMusicParams): string {
  const intensity = typeof p.intensity === "number" ? p.intensity : 55;
  const energy = intensity < 35 ? "bed / ambient / sub-voice"
               : intensity < 65 ? "balanced / mid-tempo"
               : "driving / energetic / high-energy";
  const genreLine = p.genre ? `Genre: ${p.genre}.` : "";
  const userLine = p.prompt?.trim() ? `Context: ${p.prompt.trim()}.` : "";
  return [
    genreLine,
    `Energy: ${energy}.`,
    userLine,
    "Instrumental only, no vocals. Loopable. Duck-ready so voiceover sits on top clearly.",
  ].filter(Boolean).join(" ");
}

function extractAudioUrl(json: unknown): string | null {
  const j = json as {
    success?: boolean;
    url?: string;
    audio_url?: string;
    data?: { url?: string; audio_url?: string };
    output?: { url?: string; audio_url?: string };
    result?: { url?: string; audio_url?: string };
  };
  return (
    j.url ??
    j.audio_url ??
    j.data?.url ??
    j.data?.audio_url ??
    j.output?.url ??
    j.output?.audio_url ??
    j.result?.url ??
    j.result?.audio_url ??
    null
  );
}

export async function generateLyriaMusic(params: LyriaMusicParams): Promise<string> {
  const { apiKey } = params;
  if (!apiKey) throw new Error("HYPEREAL_API_KEY missing — cannot call Lyria");

  const durationSec = Math.max(10, Math.min(120, Math.round(params.durationSec)));
  const prompt = buildLyriaPrompt(params);
  const label = params.label ?? "music";

  log.info(`generating ${durationSec}s ${label}, genre=${params.genre ?? "n/a"}, intensity=${params.intensity ?? "n/a"}`);

  const response = await fetch(LYRIA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "lyria-3-pro",
      input: {
        prompt,
        duration: durationSec,
        format: "mp3",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Lyria request failed ${response.status}: ${body.slice(0, 400)}`);
  }

  const json = await response.json();
  const url = extractAudioUrl(json);

  if (!url || typeof url !== "string") {
    throw new Error(`Lyria response missing audio URL: ${JSON.stringify(json).slice(0, 400)}`);
  }

  log.info(`✅ ${label} ready: ${url.slice(0, 80)}`);
  return url;
}

export function lyriaIsConfigured(): boolean {
  return !!(process.env.HYPEREAL_API_KEY || "").trim();
}
