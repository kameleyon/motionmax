/**
 * Hypereal Audio ASR — speech recognition with word-level timestamps.
 * Model: audio-asr (1 credit, $0.01/min)
 *
 * Used during export to get exact word timestamps for caption sync.
 */

const HYPEREAL_AUDIO_URL = "https://api.hypereal.cloud/v1/audio/generate";

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

  // Extract bucket and path from Supabase storage URL
  // Format: https://xxx.supabase.co/storage/v1/object/public/audio/project-id/file.mp3
  // Or:     https://xxx.supabase.co/storage/v1/object/sign/audio/project-id/file.mp3?token=...
  const match = audioUrl.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?|$)/);
  if (!match) return audioUrl; // Not a Supabase storage URL

  const [, bucket, filePath] = match;
  const signedUrl = await signUrl(bucket, filePath);
  return signedUrl || audioUrl;
}

/**
 * Download audio file bytes from a URL.
 * Returns the ArrayBuffer and inferred MIME type, or null on failure.
 */
async function downloadAudioFile(
  audioUrl: string,
  signUrl?: (bucket: string, path: string) => Promise<string | null>,
): Promise<{ buffer: ArrayBuffer; mimeType: string; filename: string } | null> {
  const accessibleUrl = await ensureAccessibleUrl(audioUrl, signUrl);

  const res = await fetch(accessibleUrl);
  if (!res.ok) {
    console.warn(`[ASR] Failed to download audio (${res.status}): ${accessibleUrl.substring(0, 80)}`);
    return null;
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) {
    console.warn("[ASR] Downloaded audio file is empty");
    return null;
  }

  // Infer MIME type from URL extension or Content-Type header
  const contentType = res.headers.get("content-type") || "";
  let mimeType = contentType.split(";")[0].trim();
  let ext = "mp3";

  if (audioUrl.includes(".wav")) { mimeType = mimeType || "audio/wav"; ext = "wav"; }
  else if (audioUrl.includes(".ogg")) { mimeType = mimeType || "audio/ogg"; ext = "ogg"; }
  else if (audioUrl.includes(".webm")) { mimeType = mimeType || "audio/webm"; ext = "webm"; }
  else { mimeType = mimeType || "audio/mpeg"; ext = "mp3"; }

  return { buffer, mimeType, filename: `audio.${ext}` };
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Transcribe audio and get word-level timestamps.
 * Hypereal audio-asr expects: { audio: URL, language, ignore_timestamps }
 * No "model" field — the endpoint handles routing.
 *
 * Strategy:
 *   1. JSON body with fresh signed URL (Hypereal downloads the audio)
 *   2. If Hypereal can't reach the URL, download + send base64 data URI
 * Returns null on failure (caller falls back to word-per-second estimation).
 */
export async function transcribeAudio(
  audioUrl: string,
  apiKey: string,
  language = "en",
  signUrl?: (bucket: string, path: string) => Promise<string | null>,
): Promise<ASRResult | null> {
  if (!apiKey || !audioUrl) return null;

  try {
    // Get a fresh signed URL so Hypereal can download it
    const accessibleUrl = await ensureAccessibleUrl(audioUrl, signUrl);
    console.log(`[ASR] Transcribing: ${accessibleUrl.substring(0, 80)}... lang=${language}`);

    // ── Strategy 1: Send audio URL (per Hypereal docs) ──
    let res = await fetch(HYPEREAL_AUDIO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: accessibleUrl,
        language,
        ignore_timestamps: false,
      }),
    });

    if (res.ok) return handleASRResponse(res, apiKey);

    const errText1 = await res.text();
    console.log(`[ASR] URL strategy failed (${res.status}): ${errText1.substring(0, 150)}`);

    // ── Strategy 2: Download audio, send as base64 data URI ──
    const audioFile = await downloadAudioFile(audioUrl, signUrl);
    if (!audioFile) return null;

    const base64 = arrayBufferToBase64(audioFile.buffer);
    const dataUri = `data:${audioFile.mimeType};base64,${base64}`;
    console.log(`[ASR] Downloaded ${(audioFile.buffer.byteLength / 1024).toFixed(1)}KB, sending as base64 data URI`);

    res = await fetch(HYPEREAL_AUDIO_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: dataUri,
        language,
        ignore_timestamps: false,
      }),
    });

    if (res.ok) return handleASRResponse(res, apiKey);

    const errText2 = await res.text();
    console.warn(`[ASR] Both strategies failed. Last (${res.status}): ${errText2.substring(0, 200)}`);
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
  // Extract words with timestamps from response
  // Hypereal ASR may return different formats — handle common ones
  const text = data.text || data.transcript || data.result?.text || "";
  let words: ASRWord[] = [];

  // Try segments/words array
  const segments = data.segments || data.words || data.result?.segments || data.result?.words || [];
  if (Array.isArray(segments) && segments.length > 0) {
    // Check if segments contain word-level data
    for (const seg of segments) {
      if (seg.words && Array.isArray(seg.words)) {
        // Segment with nested words
        for (const w of seg.words) {
          words.push({
            word: w.word || w.text || "",
            start: w.start ?? w.startTime ?? 0,
            end: w.end ?? w.endTime ?? 0,
          });
        }
      } else if (seg.word || seg.text) {
        // Direct word entries
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

  // Clean up words
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
 *
 * @param signUrl Optional function to generate signed URLs for private storage buckets
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
