/**
 * Hypereal Audio ASR — speech recognition with word-level timestamps.
 * Model: audio-asr (1 credit, $0.01/min)
 *
 * Used during export to get exact word timestamps for caption sync.
 *
 * API docs: https://hypereal.cloud
 *   POST /api/v1/audio/generate
 *   Body: { "audio": "<url>", "language": "en", "ignore_timestamps": false }
 *   NO "model" field — the endpoint routes based on the presence of "audio" vs "input".
 */

import { writeApiLog } from "../lib/logger.js";

// /api/v1/ returns 404; /v1/ is the working base (matches image/video services)
const HYPEREAL_ASR_URL = "https://api.hypereal.cloud/v1/audio/generate";

interface ASRWord {
  word: string;
  start: number;  // seconds
  end: number;    // seconds
}

interface ASRResult {
  text: string;
  words: ASRWord[];
  language?: string;
}

/**
 * Ensure audio URL is publicly accessible.
 * Supabase private bucket URLs need to be converted to signed URLs.
 */
async function ensureAccessibleUrl(
  audioUrl: string,
  signUrl?: (bucket: string, path: string) => Promise<string | null>,
): Promise<string> {
  if (!signUrl) return audioUrl;

  const match = audioUrl.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!match) return audioUrl;

  const [, bucket, filePath] = match;
  const signedUrl = await signUrl(bucket, filePath);
  return signedUrl || audioUrl;
}

/**
 * Transcribe audio and get word-level timestamps.
 * Returns null on failure (caller falls back to estimation).
 */
export async function transcribeAudio(
  audioUrl: string,
  apiKey: string,
  language = "en",
  signUrl?: (bucket: string, path: string) => Promise<string | null>,
): Promise<ASRResult | null> {
  if (!apiKey || !audioUrl) return null;

  const startTime = Date.now();
  try {
    // Download the audio file ourselves and send as base64 data URI.
    // Hypereal's async jobs can't reliably fetch from private Supabase buckets,
    // so we download first and send the data inline.
    const accessibleUrl = await ensureAccessibleUrl(audioUrl, signUrl);
    console.log(`[ASR] Downloading audio: ${accessibleUrl.substring(0, 80)}...`);

    const audioRes = await fetch(accessibleUrl);
    if (!audioRes.ok) {
      console.warn(`[ASR] Failed to download audio (${audioRes.status})`);
      return null;
    }

    const buffer = await audioRes.arrayBuffer();
    if (buffer.byteLength === 0) {
      console.warn("[ASR] Downloaded audio is empty");
      return null;
    }

    // Convert to base64 data URI
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const ext = audioUrl.includes(".wav") ? "wav" : "mpeg";
    const dataUri = `data:audio/${ext};base64,${btoa(binary)}`;
    console.log(`[ASR] Sending ${(buffer.byteLength / 1024).toFixed(0)}KB as base64 data URI`);

    const payload = {
      model: "audio-asr",
      input: {
        audio: dataUri,
        language,
        ignore_timestamps: false,
      },
    };

    const res = await fetch(HYPEREAL_ASR_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const result = await handleASRResponse(res, apiKey);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "audio-asr", status: result ? "success" : "error", totalDurationMs: Date.now() - startTime, cost: 0, error: result ? undefined : "ASR returned no usable result" }).catch(() => {});
      return result;
    }

    const errText = await res.text();
    console.warn(`[ASR] Failed (${res.status}): ${errText.substring(0, 300)}`);
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "audio-asr", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: `ASR failed ${res.status}` }).catch(() => {});
    return null;
  } catch (err) {
    console.warn(`[ASR] Error: ${(err as Error).message}`);
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "audio-asr", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: (err as Error).message }).catch(() => {});
    return null;
  }
}

/** Parse a successful ASR response (handles both sync and async job patterns) */
async function handleASRResponse(res: Response, apiKey: string): Promise<ASRResult | null> {
  const data = await res.json() as any;

  // Hypereal returns results inline when status is "completed" — no polling needed
  if (data.status === "completed" || data.status === "succeeded") {
    return parseASRResponse(data);
  }

  // Only poll if status is pending/processing (no inline results)
  if (data.jobId && data.status !== "completed" && data.status !== "succeeded") {
    return pollASRJob(data.jobId, apiKey);
  }

  // Fallback: try parsing whatever came back
  return parseASRResponse(data.output || data.result || data);
}

function parseASRResponse(data: any): ASRResult | null {
  const text = data.text || data.transcript || data.result?.text || "";
  let words: ASRWord[] = [];

  const segments = data.segments || data.words || data.result?.segments || data.result?.words || [];
  if (Array.isArray(segments) && segments.length > 0) {
    for (const seg of segments) {
      if (seg.words && Array.isArray(seg.words)) {
        for (const w of seg.words) {
          words.push({
            word: w.word || w.text || "",
            start: w.start ?? w.startTime ?? 0,
            end: w.end ?? w.endTime ?? 0,
          });
        }
      } else if (seg.word || seg.text) {
        words.push({
          word: seg.word || seg.text || "",
          start: seg.start ?? seg.startTime ?? 0,
          end: seg.end ?? seg.endTime ?? 0,
        });
      }
    }
  }

  if (words.length === 0 && text) {
    console.warn("[ASR] Got text but no word timestamps — falling back to estimation");
    return null;
  }

  words = words.filter(w => w.word.trim().length > 0);
  console.log(`[ASR] Transcribed: ${words.length} words, ${text.substring(0, 60)}...`);
  return { text, words, language: data.language };
}

async function pollASRJob(jobId: string, apiKey: string): Promise<ASRResult | null> {
  const maxAttempts = 15;
  const pollMs = 2000;

  console.log(`[ASR] Polling job ${jobId}...`);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollMs));

    try {
      // Try multiple poll URL patterns
      const pollUrls = [
        `https://api.hypereal.cloud/v1/jobs/${jobId}`,
        `https://api.hypereal.cloud/v1/jobs/${jobId}?model=audio-asr&type=audio`,
      ];

      let data: any = null;
      for (const url of pollUrls) {
        const res = await fetch(url, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (res.ok) {
          data = await res.json();
          break;
        }

        // Log first poll failure for debugging
        if (i === 0) {
          const errText = await res.text();
          console.log(`[ASR] Poll ${url.substring(40)} → ${res.status}: ${errText.substring(0, 100)}`);
        }
      }

      if (!data) continue;

      if (data.status === "succeeded" || data.status === "completed") {
        console.log(`[ASR] Job ${jobId} completed on attempt ${i + 1}`);
        return parseASRResponse(data.output || data.result || data);
      }
      if (data.status === "failed" || data.status === "error") {
        // Log full response to diagnose Hypereal's internal failure
        console.warn(`[ASR] Job ${jobId} failed. Full response: ${JSON.stringify(data).substring(0, 500)}`);
        return null;
      }
      // Still processing — continue polling
    } catch (err) {
      if (i === 0) console.warn(`[ASR] Poll error: ${(err as Error).message}`);
      continue;
    }
  }

  console.warn(`[ASR] Job ${jobId} timed out after ${maxAttempts} attempts`);
  return null;
}

/**
 * Transcribe scenes in batches to avoid rate limiting.
 * Hypereal allows ~3 concurrent requests before throttling.
 */
const ASR_BATCH_SIZE = 3;
const ASR_BATCH_DELAY_MS = 500;

export async function transcribeAllScenes(
  scenes: Array<{ audioUrl?: string; voiceover?: string }>,
  apiKey: string,
  language = "en",
  signUrl?: (bucket: string, path: string) => Promise<string | null>,
): Promise<(ASRResult | null)[]> {
  if (!apiKey) return scenes.map(() => null);

  console.log(`[ASR] Transcribing ${scenes.length} scenes in batches of ${ASR_BATCH_SIZE}...`);
  const start = Date.now();
  const results: (ASRResult | null)[] = new Array(scenes.length).fill(null);

  for (let i = 0; i < scenes.length; i += ASR_BATCH_SIZE) {
    const batch = scenes.slice(i, i + ASR_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(scene =>
        scene.audioUrl ? transcribeAudio(scene.audioUrl, apiKey, language, signUrl) : Promise.resolve(null)
      )
    );

    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }

    // Delay between batches to avoid rate limiting
    if (i + ASR_BATCH_SIZE < scenes.length) {
      await new Promise(r => setTimeout(r, ASR_BATCH_DELAY_MS));
    }
  }

  const success = results.filter(r => r !== null).length;
  console.log(`[ASR] Done: ${success}/${scenes.length} scenes transcribed (${((Date.now() - start) / 1000).toFixed(1)}s)`);

  return results;
}
