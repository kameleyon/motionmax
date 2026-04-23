/**
 * Hypereal Lyria 3 Pro music generation.
 *
 * Hooks up to POST https://api.hypereal.cloud/v1/audio/generate with
 * model `lyria-3-pro` — Google Lyria 3 Pro for professional music.
 *
 * IMPORTANT: path is `/v1/audio/generate` NOT `/api/v1/audio/generate`.
 * The extra `/api` returns a misleading 404 ("Use hypereal.tech
 * instead") which is a catch-all for unknown paths; hypereal.tech is
 * deprecated. All working Hypereal services (images, videos, chat,
 * audio-asr) use the flat `/v1/...` shape — this matches them.
 *
 * Public surface:
 *   generateLyriaMusic({ prompt, durationSec, apiKey, genre, intensity })
 *     → returns a public URL to an mp3 track.
 *
 * The caller (handleFinalize / exportVideo) is responsible for mixing the
 * returned track under the narration audio; this service only produces
 * the track itself.
 */

const LYRIA_ENDPOINT = "https://api.hypereal.cloud/v1/audio/generate";

// Tiny scoped logger (the frontend has createScopedLogger, the worker
// uses console + writeSystemLog directly — keep it simple here).
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
  /** Track length in seconds. Lyria caps short clips ~30s and full at
   *  up to ~2 minutes — we clamp at 120. */
  durationSec: number;
  /** Hypereal API key. */
  apiKey: string;
  /** Optional genre descriptor from the intake form. */
  genre?: LyriaMusicGenre;
  /** 0–100 intensity from the intake slider. <35 → "Bed" (ambient/soft),
   *  35–64 → "Balanced", 65+ → "Driving". */
  intensity?: number;
}

/** Translate the intake form's music settings into a Lyria-friendly
 *  prompt. Keep this deterministic so two identical intake states always
 *  produce the same prompt (stable cost accounting / idempotency). */
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

/** Call Hypereal's audio-generate endpoint with lyria-3-pro. Returns a
 *  public URL pointing at the generated mp3. Throws on failure so the
 *  caller can either retry or skip music (finalize should SKIP rather
 *  than fail the whole generation — music is additive). */
export async function generateLyriaMusic(params: LyriaMusicParams): Promise<string> {
  const { apiKey } = params;
  if (!apiKey) throw new Error("HYPEREAL_API_KEY missing — cannot call Lyria");

  const durationSec = Math.max(10, Math.min(120, Math.round(params.durationSec)));
  const prompt = buildLyriaPrompt(params);

  log.info(`[Lyria] generating ${durationSec}s track, genre=${params.genre ?? "n/a"}, intensity=${params.intensity ?? "n/a"}`);

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

  const json = await response.json() as {
    success?: boolean;
    url?: string;
    audio_url?: string;
    data?: { url?: string; audio_url?: string };
    output?: { url?: string; audio_url?: string };
  };

  // Hypereal response shapes drift — accept a few known paths and pick
  // the first URL that's actually a string.
  const url =
    json.url ??
    json.audio_url ??
    json.data?.url ??
    json.data?.audio_url ??
    json.output?.url ??
    json.output?.audio_url;

  if (!url || typeof url !== "string") {
    throw new Error(`Lyria response missing audio URL: ${JSON.stringify(json).slice(0, 300)}`);
  }

  log.info(`[Lyria] track ready: ${url.slice(0, 80)}`);
  return url;
}

/** Readiness probe: true if the required env var is set. Call this in
 *  handlers so music generation degrades gracefully (log + skip) when
 *  the key isn't configured in the worker env. */
export function lyriaIsConfigured(): boolean {
  return !!(process.env.HYPEREAL_API_KEY || "").trim();
}
