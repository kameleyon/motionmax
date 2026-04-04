/**
 * Hypereal Audio ASR — speech recognition with word-level timestamps.
 * Model: audio-asr (1 credit, $0.01/min)
 *
 * Used during export to get exact word timestamps for caption sync.
 */

const HYPEREAL_IMAGE_URL = "https://api.hypereal.cloud/v1/images/generate";

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
 * Transcribe audio and get word-level timestamps.
 * Returns null on failure (caller falls back to estimation).
 */
export async function transcribeAudio(
  audioUrl: string,
  apiKey: string,
  language = "en",
): Promise<ASRResult | null> {
  if (!apiKey || !audioUrl) return null;

  try {
    console.log(`[ASR] Transcribing: ${audioUrl.substring(0, 60)}... lang=${language}`);

    const res = await fetch("https://api.hypereal.cloud/v1/audio/transcribe", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "audio-asr",
        audio: audioUrl,
        language,
        ignore_timestamps: false, // CRITICAL: get word-level timestamps
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[ASR] Failed (${res.status}): ${err.substring(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;

    // Handle async job response
    if (data.jobId) {
      return pollASRJob(data.jobId, apiKey);
    }

    // Direct response
    return parseASRResponse(data);
  } catch (err) {
    console.warn(`[ASR] Error: ${(err as Error).message}`);
    return null;
  }
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
 */
export async function transcribeAllScenes(
  scenes: Array<{ audioUrl?: string; voiceover?: string }>,
  apiKey: string,
  language = "en",
): Promise<(ASRResult | null)[]> {
  if (!apiKey) return scenes.map(() => null);

  console.log(`[ASR] Transcribing ${scenes.length} scenes in parallel...`);
  const start = Date.now();

  const results = await Promise.all(
    scenes.map(scene =>
      scene.audioUrl ? transcribeAudio(scene.audioUrl, apiKey, language) : Promise.resolve(null)
    )
  );

  const success = results.filter(r => r !== null).length;
  console.log(`[ASR] Done: ${success}/${scenes.length} scenes transcribed (${((Date.now() - start) / 1000).toFixed(1)}s)`);

  return results;
}
