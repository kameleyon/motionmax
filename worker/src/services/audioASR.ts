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

// Docs curl shows /api/v1/, other working services use /v1/ — try /api/v1/ first
const HYPEREAL_ASR_URL = "https://api.hypereal.cloud/api/v1/audio/generate";
const HYPEREAL_ASR_URL_ALT = "https://api.hypereal.cloud/v1/audio/generate";

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

  try {
    const accessibleUrl = await ensureAccessibleUrl(audioUrl, signUrl);
    console.log(`[ASR] Transcribing: ${accessibleUrl.substring(0, 80)}... lang=${language}`);

    // Docs say: { model: "audio-asr", audio: "<url>", language, ignore_timestamps }
    const payload = {
      model: "audio-asr",
      audio: accessibleUrl,
      language,
      ignore_timestamps: false,
    };

    // Try primary URL (/api/v1/ per curl docs)
    let res = await fetch(HYPEREAL_ASR_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // If 404, try alternate URL
    if (res.status === 404) {
      console.log("[ASR] /api/v1/ returned 404, trying /v1/...");
      res = await fetch(HYPEREAL_ASR_URL_ALT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    }

    if (res.ok) return handleASRResponse(res, apiKey);

    const errText = await res.text();
    console.warn(`[ASR] Failed (${res.status}): ${errText.substring(0, 300)}`);
    return null;
  } catch (err) {
    console.warn(`[ASR] Error: ${(err as Error).message}`);
    return null;
  }
}

/** Parse a successful ASR response (handles both sync and async job patterns) */
async function handleASRResponse(res: Response, apiKey: string): Promise<ASRResult | null> {
  const data = await res.json() as any;
  if (data.jobId) return pollASRJob(data.jobId, apiKey);
  return parseASRResponse(data);
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
  const maxAttempts = 20;
  const pollMs = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollMs));

    try {
      const res = await fetch(`https://api.hypereal.cloud/v1/jobs/${jobId}?model=audio-asr&type=audio`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
      });

      if (!res.ok) continue;
      const data = await res.json() as any;

      if (data.status === "succeeded" || data.status === "completed") {
        return parseASRResponse(data);
      }
      if (data.status === "failed" || data.status === "error") {
        console.warn(`[ASR] Job failed: ${data.error || "unknown"}`);
        return null;
      }
    } catch {
      continue;
    }
  }

  console.warn("[ASR] Timed out waiting for transcription");
  return null;
}

/**
 * Transcribe all scenes' audio in parallel.
 * Returns an array matching the scenes array — null entries fall back to estimation.
 */
export async function transcribeAllScenes(
  scenes: Array<{ audioUrl?: string; voiceover?: string }>,
  apiKey: string,
  language = "en",
  signUrl?: (bucket: string, path: string) => Promise<string | null>,
): Promise<(ASRResult | null)[]> {
  if (!apiKey) return scenes.map(() => null);

  console.log(`[ASR] Transcribing ${scenes.length} scenes in parallel...`);
  const start = Date.now();

  const results = await Promise.all(
    scenes.map(scene =>
      scene.audioUrl ? transcribeAudio(scene.audioUrl, apiKey, language, signUrl) : Promise.resolve(null)
    )
  );

  const success = results.filter(r => r !== null).length;
  console.log(`[ASR] Done: ${success}/${scenes.length} scenes transcribed (${((Date.now() - start) / 1000).toFixed(1)}s)`);

  return results;
}
