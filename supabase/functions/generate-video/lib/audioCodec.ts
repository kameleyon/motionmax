/**
 * Audio codec + text utilities used by the TTS providers.
 *
 * This module bundles the chunk-and-stitch pipeline that bypasses
 * Chatterbox's ~30s per-call limit, plus the language detector and
 * voiceover sanitisers shared by every TTS path (Gemini, Fish, Lemonfox,
 * Replicate, ElevenLabs, OpenRouter).
 *
 * Public surface:
 *   - pcmToWav(pcm, sampleRate?, numChannels?, bitsPerSample?) — wraps raw
 *     PCM in a RIFF/WAV header. Handles 32-bit IEEE float automatically.
 *   - splitTextIntoChunks(text, maxChars?) — sentence-aware chunker for TTS.
 *   - extractPcmFromWav(wavBytes) — strips header, returns PCM + format meta.
 *   - stitchWavBuffers(buffers) — concatenates compatible WAVs end-to-end.
 *   - callReplicateTTSChunk(text, replicateApiKey, chunkIndex, voiceGender?)
 *     — single-shot Replicate Chatterbox call returning raw audio bytes.
 *     Used by the parallel chunked path.
 *   - sanitizeVoiceover(input) — strips stage directions, markdown, and
 *     bracketed content (except whitelisted paralinguistic tags).
 *   - sanitizeForGeminiTTS(text) — extra-aggressive sanitiser for Gemini's
 *     stricter content filters.
 *   - isHaitianCreole(text) — heuristic language detector for HC routing.
 *
 * Module constants:
 *   ALLOWED_PARALINGUISTIC_TAGS — bracketed tags TTS engines treat as
 *     expression hints (e.g. [chuckle], [sigh]). Survives sanitisation.
 *
 * `sleep` is defined locally so the module has no cross-file dependencies.
 *
 * Extracted 2026-05-10 per audit C-4-2 (Arch C-A3). Zero behavior change.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ============= PCM TO WAV CONVERSION =============
export function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number = 24000,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): Uint8Array {
  // 32-bit audio from Replicate is IEEE float (format 3), not integer PCM (format 1)
  const audioFormat = bitsPerSample === 32 ? 3 : 1;

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, totalSize - 8, true); // File size - 8
  view.setUint8(8, 0x57); // W
  view.setUint8(9, 0x41); // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E

  // fmt subchunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6d); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // (space)
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, audioFormat, true); // AudioFormat (1 = PCM integer, 3 = IEEE float)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataSize, true);

  // Copy PCM data
  const wavArray = new Uint8Array(buffer);
  wavArray.set(pcmData, headerSize);

  return wavArray;
}

// ============= CHUNK & STITCH ENGINE (Bypass ~30s TTS limit) =============

// Split text into safe chunks at sentence boundaries (~400 chars each)
export function splitTextIntoChunks(text: string, maxChars: number = 400): string[] {
  // Split by sentence terminators
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    // If adding this sentence would exceed max, save current and start new
    if ((currentChunk + " " + trimmedSentence).trim().length > maxChars && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmedSentence;
    } else {
      currentChunk = (currentChunk + " " + trimmedSentence).trim();
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // If no chunks, return original text as single chunk
  return chunks.length > 0 ? chunks : [text.trim()];
}

// Extract raw PCM data from a WAV file (strip header)
export function extractPcmFromWav(wavBytes: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
} {
  // CRITICAL: Create a fresh ArrayBuffer copy to avoid byteOffset issues
  const freshBuffer = new Uint8Array(wavBytes).buffer;
  const view = new DataView(freshBuffer);

  // Read header info (standard WAV has 44-byte header)
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  console.log(`[WAV-Parse] Header: ${sampleRate}Hz, ${numChannels}ch, ${bitsPerSample}bit`);

  // Find 'data' chunk - standard position is at offset 36
  // But some WAVs have extra chunks, so we search for it
  let dataOffset = 36;
  let dataSize = 0;

  // Search for 'data' chunk ID (0x64617461)
  for (let offset = 12; offset < Math.min(wavBytes.length - 8, 200); offset++) {
    if (
      wavBytes[offset] === 0x64 &&
      wavBytes[offset + 1] === 0x61 &&
      wavBytes[offset + 2] === 0x74 &&
      wavBytes[offset + 3] === 0x61
    ) {
      dataOffset = offset + 8; // Skip 'data' + size (4 + 4 bytes)
      dataSize = view.getUint32(offset + 4, true);
      console.log(`[WAV-Parse] Found data chunk at offset ${offset}, size ${dataSize}`);
      break;
    }
  }

  // If no 'data' chunk found, assume standard 44-byte header
  if (dataSize === 0) {
    dataOffset = 44;
    dataSize = wavBytes.length - 44;
    console.log(`[WAV-Parse] Using default 44-byte header, data size ${dataSize}`);
  }

  const pcm = wavBytes.slice(dataOffset, dataOffset + dataSize);
  return { pcm, sampleRate, numChannels, bitsPerSample };
}

// Merge multiple WAV buffers into one seamless audio file
export function stitchWavBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0);
  if (buffers.length === 1) return buffers[0];

  console.log(`[WAV-Stitch] Stitching ${buffers.length} audio buffers...`);

  // Extract params and PCM from all buffers
  const parsedBuffers = buffers.map((b, idx) => {
    const parsed = extractPcmFromWav(b);
    console.log(`[WAV-Stitch] Buffer ${idx + 1}: ${parsed.pcm.length} bytes, ${parsed.sampleRate}Hz`);
    return parsed;
  });

  // Use first buffer's params as reference
  const { sampleRate, numChannels, bitsPerSample } = parsedBuffers[0];

  // Validate all buffers have matching params
  for (let i = 1; i < parsedBuffers.length; i++) {
    const p = parsedBuffers[i];
    if (p.sampleRate !== sampleRate || p.numChannels !== numChannels || p.bitsPerSample !== bitsPerSample) {
      console.warn(
        `[WAV-Stitch] Buffer ${i + 1} mismatch: ${p.sampleRate}Hz vs ${sampleRate}Hz - may cause audio artifacts`,
      );
    }
  }

  // Extract PCM parts
  const pcmParts = parsedBuffers.map((p) => p.pcm);

  // Calculate total PCM length
  const totalLength = pcmParts.reduce((acc, part) => acc + part.length, 0);
  const mergedPcm = new Uint8Array(totalLength);
  console.log(`[WAV-Stitch] Total PCM size: ${totalLength} bytes`);

  // Concatenate all PCM data
  let offset = 0;
  for (const part of pcmParts) {
    mergedPcm.set(part, offset);
    offset += part.length;
  }

  // Build final WAV with merged PCM
  const finalWav = pcmToWav(mergedPcm, sampleRate, numChannels, bitsPerSample);
  console.log(`[WAV-Stitch] Final WAV: ${finalWav.length} bytes at ${sampleRate}Hz`);
  return finalWav;
}

// Call Replicate Chatterbox TTS for a single chunk
export async function callReplicateTTSChunk(
  text: string,
  replicateApiKey: string,
  chunkIndex: number,
  voiceGender: string = "female", // "male" or "female"
): Promise<Uint8Array> {
  console.log(`[TTS-Chunk] Chunk ${chunkIndex + 1}: ${text.substring(0, 60)}... (${text.length} chars)`);

  // Map gender to Replicate voice names: male = Ethan, female = Marisol
  const voiceName = voiceGender === "male" ? "Ethan" : "Marisol";
  console.log(`[TTS-Chunk] Using voice: ${voiceName} (gender: ${voiceGender})`);

  const createResponse = await fetch("https://api.replicate.com/v1/models/resemble-ai/chatterbox-turbo/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${replicateApiKey}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: {
        text: text,
        voice: voiceName,
        temperature: 0.9,
        top_p: 1,
        top_k: 1800,
        repetition_penalty: 2,
      },
    }),
  });

  if (!createResponse.ok) {
    const errText = await createResponse.text();
    throw new Error(`Replicate TTS chunk ${chunkIndex + 1} failed: ${createResponse.status} - ${errText}`);
  }

  let prediction = await createResponse.json();

  // Poll if not completed
  while (prediction.status !== "succeeded" && prediction.status !== "failed") {
    await sleep(1000);
    const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${replicateApiKey}` },
    });
    prediction = await pollResponse.json();
  }

  if (prediction.status === "failed") {
    throw new Error(`TTS chunk ${chunkIndex + 1} prediction failed: ${prediction.error || "Unknown error"}`);
  }

  const outputUrl = prediction.output;
  if (!outputUrl) throw new Error(`No output URL from TTS chunk ${chunkIndex + 1}`);

  // Download audio
  const audioResponse = await fetch(outputUrl);
  if (!audioResponse.ok) throw new Error(`Failed to download audio for chunk ${chunkIndex + 1}`);

  return new Uint8Array(await audioResponse.arrayBuffer());
}

// Paralinguistic tags to preserve for natural TTS expression
export const ALLOWED_PARALINGUISTIC_TAGS = [
  "clear throat",
  "sigh",
  "sush",
  "cough",
  "groan",
  "sniff",
  "gasp",
  "chuckle",
  "laugh",
];

export function sanitizeVoiceover(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^\s*(?:hook|scene\s*\d+|narrator|body|solution|conflict|choice|formula)\s*[:\-–—]\s*/i, "")
        .replace(/^\s*\[[^\]]+\]\s*/g, ""),
    );
  let out = lines.join(" ");

  // Remove bracketed content EXCEPT allowed paralinguistic tags
  out = out.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = content.toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) {
      return match; // Keep the tag
    }
    return " "; // Remove other bracketed content
  });

  out = out.replace(/[*_~`]+/g, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

// Extra sanitization for Gemini TTS to avoid content filtering
export function sanitizeForGeminiTTS(text: string): string {
  let sanitized = sanitizeVoiceover(text);

  // Temporarily replace paralinguistic tags with placeholders
  const tagPlaceholders: string[] = [];
  sanitized = sanitized.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = content.toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) {
      tagPlaceholders.push(match);
      return `__PTAG${tagPlaceholders.length - 1}__`;
    }
    return " ";
  });

  // Remove any remaining special characters that might trigger filters
  sanitized = sanitized.replace(/[^\w\sÀ-ɏḀ-ỿ.,!?;:'-]/g, " ");

  // Restore paralinguistic tags
  tagPlaceholders.forEach((tag, i) => {
    sanitized = sanitized.replace(`__PTAG${i}__`, tag);
  });

  // Collapse multiple spaces
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  // Ensure it ends with proper punctuation for natural speech
  if (sanitized && !/[.!?]$/.test(sanitized)) {
    sanitized += ".";
  }

  return sanitized;
}

// ============= LANGUAGE DETECTION =============
export function isHaitianCreole(text: string): boolean {
  const lowerText = text.toLowerCase();

  // Common Haitian Creole words and patterns
  const creoleIndicators = [
    // Common words
    "mwen",
    "ou",
    "li",
    "nou",
    "yo",
    "sa",
    "ki",
    "nan",
    "pou",
    "ak",
    "pa",
    "se",
    "te",
    "ap",
    "gen",
    "fè",
    "di",
    "ale",
    "vin",
    "bay",
    "konnen",
    "wè",
    "pran",
    "mete",
    "vle",
    "kapab",
    "dwe",
    "bezwen",
    "tankou",
    "paske",
    "men",
    "lè",
    "si",
    "kote",
    "kouman",
    "poukisa",
    "anpil",
    "tout",
    "chak",
    "yon",
    "de",
    "twa",
    "kat",
    "senk",
    // Haitian specific
    "ayiti",
    "kreyòl",
    "kreyol",
    "bondye",
    "mèsi",
    "bonjou",
    "bonswa",
    "kijan",
    "eske",
    "kounye",
    "toujou",
    "jamè",
    "anvan",
    "apre",
    // Verb markers
    "t ap",
    "te",
    "pral",
    "ta",
  ];

  let matchCount = 0;
  for (const indicator of creoleIndicators) {
    const regex = new RegExp(`\\b${indicator}\\b`, "gi");
    if (regex.test(lowerText)) matchCount++;
  }

  // If 3+ Creole indicators found, likely Haitian Creole
  return matchCount >= 3;
}
