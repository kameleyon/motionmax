/**
 * Universal Audio Engine — Single source of truth for all TTS logic.
 *
 * Used by both generate-video (Explainer/SmartFlow/Storytelling) and
 * generate-cinematic (Cinematic) edge functions.
 *
 * Routing:
 *   1. Haitian Creole + Custom Voice → Gemini TTS → ElevenLabs STS
 *   2. Custom Voice (non-HC) → ElevenLabs TTS directly
 *   3. Haitian Creole (standard) → Gemini TTS (3-key rotation) → ElevenLabs STS (WyscUDDs9ZWbMjTYd7By / XZUXLIpE3dqJ9aCZUj2R)
 *   4. Default → Lemonfox TTS (adam/river) → Chatterbox fallback → Gemini fallback
 *
 * Key rotation: accepts array of Google API keys (reverse order: KEY_3, KEY_2, KEY_1).
 * Batching: processes max BATCH_SIZE=3 scenes at once with 500ms inter-batch delay.
 */

import { decode as base64Decode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
// ============= TYPES =============

export interface AudioScene {
  number: number;
  voiceover: string;
  duration: number;
}

/** How the caller wants audio stored & returned */
export interface StorageStrategy {
  bucket: string;            // "audio" or "audio-files"
  pathPrefix: string;        // e.g. "userId/projectId" or ""
  useSignedUrls: boolean;    // true = signed 7-day URLs, false = public URLs
  filePrefix?: string;       // e.g. "cinematic-audio" (defaults to "scene")
}

export interface AudioResult {
  url: string | null;
  error?: string;
  durationSeconds?: number;
  provider?: string;
}

export interface AudioEngineConfig {
  replicateApiKey: string;
  googleApiKeys: string[];         // reverse order: [KEY_3, KEY_2, KEY_1]
  elevenLabsApiKey?: string;
  lemonfoxApiKey?: string;         // Lemonfox TTS API key
  supabase: any;
  storage: StorageStrategy;
  voiceGender?: string;            // "male" | "female"
  customVoiceId?: string;
  forceHaitianCreole?: boolean;
  isRegeneration?: boolean;
}

// ============= CONSTANTS =============

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const KEY_ROTATION_ROUNDS = 5;
const CHATTERBOX_TURBO_URL = "https://api.replicate.com/v1/models/resemble-ai/chatterbox-turbo/predictions";
const MAX_TTS_RETRIES = 4;

const GEMINI_TTS_MODELS = [
  { name: "gemini-2.5-pro-preview-tts", label: "2.5 Pro Preview TTS" },
  { name: "gemini-2.5-flash-preview-tts", label: "2.5 Flash Preview TTS" },
];

const ALLOWED_PARALINGUISTIC_TAGS = [
  "clear throat", "sigh", "sush", "cough", "groan", "sniff", "gasp", "chuckle", "laugh",
];

// ============= TEXT SANITIZATION =============

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

  out = out.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = content.toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) return match;
    return " ";
  });

  out = out.replace(/[*_~`]+/g, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

export function sanitizeForGeminiTTS(text: string): string {
  let sanitized = sanitizeVoiceover(text);

  // Preserve allowed paralinguistic tags
  const tagPlaceholders: string[] = [];
  sanitized = sanitized.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = content.toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) {
      tagPlaceholders.push(match);
      return `__PTAG${tagPlaceholders.length - 1}__`;
    }
    return " ";
  });

  // Remove special characters that trigger content filters
  sanitized = sanitized.replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF.,!?;:'-]/g, " ");

  // Restore tags
  tagPlaceholders.forEach((tag, i) => {
    sanitized = sanitized.replace(`__PTAG${i}__`, tag);
  });

  sanitized = sanitized.replace(/\s+/g, " ").trim();

  if (sanitized && !/[.!?]$/.test(sanitized)) {
    sanitized += ".";
  }

  return sanitized;
}

// ============= LANGUAGE DETECTION =============

export function isHaitianCreole(text: string): boolean {
  const lowerText = text.toLowerCase();
  const creoleIndicators = [
    "mwen", "ou", "li", "nou", "yo", "sa", "ki", "nan", "pou", "ak",
    "pa", "se", "te", "ap", "gen", "fè", "di", "ale", "vin", "bay",
    "konnen", "wè", "pran", "mete", "vle", "kapab", "dwe", "bezwen",
    "tankou", "paske", "men", "lè", "si", "kote", "kouman", "poukisa",
    "anpil", "tout", "chak", "yon", "de", "twa", "kat", "senk",
    "ayiti", "kreyòl", "kreyol", "bondye", "mèsi", "bonjou", "bonswa",
    "kijan", "eske", "kounye", "toujou", "jamè", "anvan", "apre",
    "t ap", "pral", "ta",
  ];

  let matchCount = 0;
  for (const indicator of creoleIndicators) {
    const regex = new RegExp(`\\b${indicator}\\b`, "gi");
    if (regex.test(lowerText)) matchCount++;
  }
  return matchCount >= 3;
}

// ============= PCM / WAV UTILITIES =============

export function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number = 24000,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): Uint8Array {
  const audioFormat = bitsPerSample === 32 ? 3 : 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  view.setUint32(4, totalSize - 8, true);
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);

  // fmt subchunk
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);

  const result = new Uint8Array(buffer);
  result.set(pcmData, headerSize);
  return result;
}

function extractPcmFromWav(wavBytes: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
} {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);

  // Find "fmt " chunk
  let fmtOffset = -1;
  for (let i = 12; i < wavBytes.length - 8; i++) {
    if (wavBytes[i] === 0x66 && wavBytes[i+1] === 0x6d && wavBytes[i+2] === 0x74 && wavBytes[i+3] === 0x20) {
      fmtOffset = i;
      break;
    }
  }
  if (fmtOffset === -1) throw new Error("No fmt chunk found in WAV");

  const numChannels = view.getUint16(fmtOffset + 10, true);
  const sampleRate = view.getUint32(fmtOffset + 12, true);
  const bitsPerSample = view.getUint16(fmtOffset + 22, true);

  // Find "data" chunk
  let dataOffset = -1;
  let dataSize = 0;
  for (let i = fmtOffset + 8; i < wavBytes.length - 8; i++) {
    if (wavBytes[i] === 0x64 && wavBytes[i+1] === 0x61 && wavBytes[i+2] === 0x74 && wavBytes[i+3] === 0x61) {
      dataOffset = i + 8;
      dataSize = view.getUint32(i + 4, true);
      break;
    }
  }
  if (dataOffset === -1) throw new Error("No data chunk found in WAV");

  const pcm = wavBytes.slice(dataOffset, dataOffset + dataSize);
  return { pcm, sampleRate, numChannels, bitsPerSample };
}

function stitchWavBuffers(buffers: Uint8Array[]): Uint8Array {
  if (buffers.length === 0) return new Uint8Array(0);
  if (buffers.length === 1) return buffers[0];

  // Extract PCM from all buffers
  const parsed = buffers.map((b) => extractPcmFromWav(b));
  const { sampleRate, numChannels, bitsPerSample } = parsed[0];

  // Concatenate all PCM data
  const totalPcmLength = parsed.reduce((acc, p) => acc + p.pcm.length, 0);
  const mergedPcm = new Uint8Array(totalPcmLength);
  let offset = 0;
  for (const p of parsed) {
    mergedPcm.set(p.pcm, offset);
    offset += p.pcm.length;
  }

  return pcmToWav(mergedPcm, sampleRate, numChannels, bitsPerSample);
}

function splitTextIntoChunks(text: string, maxChars: number = 400): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if ((currentChunk + " " + trimmed).trim().length > maxChars && currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk = (currentChunk + " " + trimmed).trim();
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks.length > 0 ? chunks : [text.trim()];
}

// ============= STORAGE HELPERS =============

async function uploadAndGetUrl(
  supabase: any,
  audioBytes: Uint8Array,
  contentType: string,
  storage: StorageStrategy,
  sceneNumber: number,
  suffix?: string,
): Promise<string> {
  const ext = contentType.includes("mpeg") ? "mp3" : "wav";
  const timestamp = Date.now();
  const prefix = storage.filePrefix || "scene";

  let filePath: string;
  if (storage.pathPrefix) {
    filePath = suffix
      ? `${storage.pathPrefix}/scene-${sceneNumber}-${suffix}-${timestamp}.${ext}`
      : `${storage.pathPrefix}/scene-${sceneNumber}.${ext}`;
  } else {
    filePath = `${prefix}-${timestamp}-${sceneNumber}.${ext}`;
  }

  const { error: uploadError } = await supabase.storage
    .from(storage.bucket)
    .upload(filePath, audioBytes, { contentType, upsert: true });

  if (uploadError) {
    // Try creating bucket if it doesn't exist (cinematic uses public bucket)
    if (!storage.useSignedUrls) {
      try {
        await supabase.storage.createBucket(storage.bucket, { public: true });
        await supabase.storage.from(storage.bucket).upload(filePath, audioBytes, { contentType, upsert: true });
      } catch {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }
    } else {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }
  }

  if (storage.useSignedUrls) {
    const { data: signedData, error: signError } = await supabase.storage
      .from(storage.bucket)
      .createSignedUrl(filePath, 604800); // 7 days
    if (signError || !signedData?.signedUrl) {
      throw new Error(`Failed to create signed URL: ${signError?.message || "Unknown error"}`);
    }
    return signedData.signedUrl;
  } else {
    const { data: urlData } = supabase.storage.from(storage.bucket).getPublicUrl(filePath);
    return urlData.publicUrl;
  }
}

// ============= GEMINI TTS (Haitian Creole) =============

async function generateGeminiTTSWithModel(
  text: string,
  sceneNumber: number,
  googleApiKey: string,
  supabase: any,
  storage: StorageStrategy,
  modelName: string,
  modelLabel: string,
  retryAttempt: number = 0,
): Promise<AudioResult> {
  let voiceoverText = sanitizeForGeminiTTS(text);
  if (!voiceoverText || voiceoverText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  // Remove promotional content that triggers filters
  const promotionalPatterns = [
    /\b(swiv|follow|like|subscribe|kòmante|comment|pataje|share|abòneman)\b[^.]*\./gi,
    /\b(swiv kont|follow the|like and|share this)\b[^.]*$/gi,
    /\.\s*(swiv|like|pataje|share|follow)[^.]*$/gi,
  ];
  for (const pattern of promotionalPatterns) {
    voiceoverText = voiceoverText.replace(pattern, ".");
  }
  voiceoverText = voiceoverText.replace(/\.+/g, ".").replace(/\s+/g, " ").trim();

  // Text variations on retry to bypass content filtering
  if (retryAttempt > 0) {
    voiceoverText = voiceoverText.replace(/[Ss]wiv[^.]*\./g, "").trim();
    const variations = [
      voiceoverText,
      "Please narrate the following: " + voiceoverText,
      "Read this story aloud: " + voiceoverText,
      voiceoverText + " End of narration.",
      "Educational content: " + voiceoverText,
      "Documentary narration: " + voiceoverText,
      "Story segment: " + voiceoverText,
      voiceoverText.replace(/\./g, ";").replace(/;([^;]*)$/, ".$1"),
      voiceoverText.split(".").slice(0, -1).join(".") + ".",
      "In this segment: " + voiceoverText,
    ];
    voiceoverText = variations[retryAttempt % variations.length];
    console.log(`[TTS-Gemini] Scene ${sceneNumber} retry ${retryAttempt} variation: ${voiceoverText.substring(0, 80)}...`);
  }

  try {
    console.log(`[TTS-Gemini] Scene ${sceneNumber}: Using ${modelLabel} (attempt ${retryAttempt + 1})`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${googleApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `[Speak with natural enthusiasm, warmth and energy like sharing exciting news with a friend] ${voiceoverText}`,
            }],
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Enceladus" },
              },
            },
          },
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TTS-Gemini] ${modelLabel} API error: ${response.status} - ${errText}`);
      if (response.status === 429) {
        throw Object.assign(new Error(`Gemini TTS quota exhausted (${modelLabel})`), { quotaExhausted: true });
      }
      return { url: null, error: `${modelLabel} failed: ${response.status}` };
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    if (candidate?.finishReason === "OTHER") {
      console.warn(`[TTS-Gemini] ${modelLabel} content filter triggered`);
      return { url: null, error: `${modelLabel} content filter` };
    }

    if (!candidate?.content?.parts?.[0]?.inlineData?.data) {
      return { url: null, error: `No audio data in ${modelLabel} response` };
    }

    const inlineData = candidate.content.parts[0].inlineData;
    let pcmBytes = base64Decode(inlineData.data);

    // Trim trailing silence
    const SILENCE_THRESHOLD = 300;
    let trimEnd = pcmBytes.length;
    for (let i = pcmBytes.length - 2; i >= 0; i -= 2) {
      const sample = Math.abs(((pcmBytes[i] | (pcmBytes[i + 1] << 8)) << 16) >> 16);
      if (sample > SILENCE_THRESHOLD) {
        trimEnd = Math.min(pcmBytes.length, i + 14400);
        break;
      }
    }
    if (trimEnd < pcmBytes.length) {
      pcmBytes = pcmBytes.slice(0, trimEnd);
    }

    const wavBytes = pcmToWav(pcmBytes, 24000, 1, 16);
    const durationSeconds = Math.max(1, pcmBytes.length / (24000 * 2));

    const url = await uploadAndGetUrl(supabase, wavBytes, "audio/wav", storage, sceneNumber);

    console.log(`[TTS-Gemini] Scene ${sceneNumber} SUCCESS with ${modelLabel}`);
    return { url, durationSeconds, provider: `Gemini ${modelLabel}` };
  } catch (err: any) {
    if (err?.quotaExhausted) throw err;
    const errorMsg = err instanceof Error ? err.message : "Unknown Gemini TTS error";
    console.error(`[TTS-Gemini] Scene ${sceneNumber} ${modelLabel} error:`, errorMsg);
    return { url: null, error: errorMsg };
  }
}

/** Try all Gemini models for a single key+round */
async function tryGeminiModels(
  text: string,
  sceneNumber: number,
  googleApiKey: string,
  supabase: any,
  storage: StorageStrategy,
  round: number,
): Promise<AudioResult | null> {
  for (const model of GEMINI_TTS_MODELS) {
    try {
      const result = await generateGeminiTTSWithModel(
        text, sceneNumber, googleApiKey, supabase, storage,
        model.name, model.label, round,
      );
      if (result.url) return result;
    } catch (err: any) {
      if (err?.quotaExhausted) {
        console.warn(`[TTS] Scene ${sceneNumber}: ${model.label} quota exhausted — cycling to next key`);
        return null; // signal caller to try next key
      }
      throw err;
    }
  }
  return null; // all models failed for this key, but not quota — try next key
}

/** Full Gemini TTS with 3-key rotation across multiple rounds */
async function generateGeminiTTSWithKeyRotation(
  text: string,
  sceneNumber: number,
  googleApiKeys: string[],
  supabase: any,
  storage: StorageStrategy,
): Promise<AudioResult> {
  for (let round = 0; round < KEY_ROTATION_ROUNDS; round++) {
    if (round > 0) {
      const roundDelay = 3000 * round;
      console.log(`[TTS] Scene ${sceneNumber}: Round ${round + 1}/${KEY_ROTATION_ROUNDS} (waiting ${roundDelay}ms)`);
      await sleep(roundDelay);
    }

    for (let keyIdx = 0; keyIdx < googleApiKeys.length; keyIdx++) {
      console.log(`[TTS] Scene ${sceneNumber}: Round ${round + 1}/${KEY_ROTATION_ROUNDS}, Key ${keyIdx + 1}/${googleApiKeys.length}`);
      const result = await tryGeminiModels(
        text, sceneNumber, googleApiKeys[keyIdx], supabase, storage, round,
      );
      if (result?.url) {
        console.log(`✅ Scene ${sceneNumber} SUCCEEDED with Gemini TTS key ${keyIdx + 1} on round ${round + 1}`);
        return result;
      }
    }
  }

  console.error(`[TTS] Scene ${sceneNumber}: All ${googleApiKeys.length} Gemini keys exhausted after ${KEY_ROTATION_ROUNDS} rounds`);
  throw new Error("Audio generation failed — all TTS API keys exhausted. Please try again later.");
}

// ============= ELEVENLABS TTS (Custom/Cloned Voices) =============

async function generateElevenLabsTTS(
  text: string,
  sceneNumber: number,
  voiceId: string,
  elevenLabsApiKey: string,
  supabase: any,
  storage: StorageStrategy,
): Promise<AudioResult> {
  const sanitizedText = sanitizeVoiceover(text);
  if (!sanitizedText || sanitizedText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  try {
    console.log(`[TTS-ElevenLabs] Scene ${sceneNumber}: Using voice ${voiceId}`);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: sanitizedText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.3,
            similarity_boost: 0.75,
            style: 0.65,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TTS-ElevenLabs] API error: ${response.status} - ${errText}`);
      return { url: null, error: `ElevenLabs failed: ${response.status}` };
    }

    const audioBytes = new Uint8Array(await response.arrayBuffer());
    const durationSeconds = Math.max(1, audioBytes.length / 16000); // MP3 at 128kbps

    const url = await uploadAndGetUrl(supabase, audioBytes, "audio/mpeg", storage, sceneNumber);

    console.log(`[TTS-ElevenLabs] Scene ${sceneNumber} SUCCESS`);
    return { url, durationSeconds, provider: "ElevenLabs TTS" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown ElevenLabs error";
    console.error(`[TTS-ElevenLabs] Scene ${sceneNumber} error:`, errorMsg);
    return { url: null, error: errorMsg };
  }
}

// ============= ELEVENLABS SPEECH-TO-SPEECH =============

async function transformWithElevenLabsSTS(
  sourceAudioUrl: string,
  targetVoiceId: string,
  sceneNumber: number,
  elevenLabsApiKey: string,
  supabase: any,
  storage: StorageStrategy,
): Promise<AudioResult> {
  try {
    console.log(`[STS-ElevenLabs] Scene ${sceneNumber}: Downloading source for voice transformation...`);

    const sourceResponse = await fetch(sourceAudioUrl);
    if (!sourceResponse.ok) {
      throw new Error(`Failed to download source audio: ${sourceResponse.status}`);
    }
    const sourceAudioBytes = new Uint8Array(await sourceResponse.arrayBuffer());

    // Build multipart form data
    const boundary = `----ElevenLabsSTS${Date.now()}`;
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    parts.push(encoder.encode(`--${boundary}\r\n`));
    parts.push(encoder.encode(`Content-Disposition: form-data; name="audio"; filename="source.wav"\r\n`));
    parts.push(encoder.encode(`Content-Type: audio/wav\r\n\r\n`));
    parts.push(sourceAudioBytes);
    parts.push(encoder.encode(`\r\n--${boundary}\r\n`));
    parts.push(encoder.encode(`Content-Disposition: form-data; name="model_id"\r\n\r\n`));
    parts.push(encoder.encode(`eleven_multilingual_sts_v2\r\n`));
    parts.push(encoder.encode(`--${boundary}\r\n`));
    parts.push(encoder.encode(`Content-Disposition: form-data; name="voice_settings"\r\n\r\n`));
    parts.push(encoder.encode(`{"stability": 0.3, "similarity_boost": 0.75, "style": 0.65, "use_speaker_boost": true}\r\n`));
    parts.push(encoder.encode(`--${boundary}--\r\n`));

    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) { body.set(part, offset); offset += part.length; }

    console.log(`[STS-ElevenLabs] Scene ${sceneNumber}: Calling STS API with voice ${targetVoiceId}`);

    const stsResponse = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${targetVoiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsApiKey,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body,
      },
    );

    if (!stsResponse.ok) {
      const errText = await stsResponse.text();
      console.error(`[STS-ElevenLabs] API error: ${stsResponse.status} - ${errText}`);
      return { url: null, error: `ElevenLabs STS failed: ${stsResponse.status}` };
    }

    const audioBytes = new Uint8Array(await stsResponse.arrayBuffer());
    const durationSeconds = Math.max(1, audioBytes.length / 16000);

    const url = await uploadAndGetUrl(supabase, audioBytes, "audio/mpeg", storage, sceneNumber, "sts");

    console.log(`[STS-ElevenLabs] Scene ${sceneNumber} ✅ Voice transformation SUCCESS`);
    return { url, durationSeconds, provider: "ElevenLabs STS (Voice Cloned)" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown ElevenLabs STS error";
    console.error(`[STS-ElevenLabs] Scene ${sceneNumber} error:`, errorMsg);
    return { url: null, error: errorMsg };
  }
}

// ============= LEMONFOX TTS =============

const LEMONFOX_TTS_URL = "https://api.lemonfox.ai/v1/audio/speech";
const LEMONFOX_MAX_RETRIES = 3;

async function generateLemonfoxTTS(
  scene: AudioScene,
  sceneNumber: number,
  lemonfoxApiKey: string,
  supabase: any,
  storage: StorageStrategy,
  voiceGender: string,
): Promise<AudioResult> {
  const voiceoverText = sanitizeVoiceover(scene.voiceover);
  if (!voiceoverText || voiceoverText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  // adam for male, river for female
  const voice = voiceGender === "male" ? "adam" : "river";

  for (let attempt = 1; attempt <= LEMONFOX_MAX_RETRIES; attempt++) {
    try {
      console.log(`[TTS-Lemonfox] Scene ${sceneNumber}: Using voice "${voice}" (attempt ${attempt}/${LEMONFOX_MAX_RETRIES})`);

      const response = await fetch(LEMONFOX_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lemonfoxApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: voiceoverText,
          voice,
          response_format: "mp3",
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.error(`[TTS-Lemonfox] API error: ${response.status} - ${errText}`);

        if ((response.status === 429 || response.status >= 500) && attempt < LEMONFOX_MAX_RETRIES) {
          const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          console.warn(`[TTS-Lemonfox] Scene ${sceneNumber}: ${response.status}, retry in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }

        return { url: null, error: `Lemonfox TTS failed: ${response.status}` };
      }

      const audioBytes = new Uint8Array(await response.arrayBuffer());
      if (audioBytes.length < 100) {
        console.error(`[TTS-Lemonfox] Scene ${sceneNumber}: Suspiciously small audio (${audioBytes.length} bytes)`);
        return { url: null, error: "Lemonfox returned empty audio" };
      }

      // Estimate duration from MP3 file size (128kbps = 16000 bytes/sec)
      const durationSeconds = Math.max(1, audioBytes.length / 16000);

      const url = await uploadAndGetUrl(supabase, audioBytes, "audio/mpeg", storage, sceneNumber);

      console.log(`[TTS-Lemonfox] Scene ${sceneNumber} ✅ SUCCESS (${durationSeconds.toFixed(1)}s, voice: ${voice})`);
      return { url, durationSeconds, provider: `Lemonfox TTS (${voice})` };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown Lemonfox error";
      console.error(`[TTS-Lemonfox] Scene ${sceneNumber} attempt ${attempt} error:`, errorMsg);
      if (attempt < LEMONFOX_MAX_RETRIES) {
        await sleep(2000 * Math.pow(2, attempt - 1));
      }
    }
  }

  return { url: null, error: `Lemonfox TTS failed after ${LEMONFOX_MAX_RETRIES} attempts` };
}

// ============= REPLICATE CHATTERBOX (Chunk & Stitch) =============

async function callChatterboxChunk(
  text: string,
  replicateApiKey: string,
  chunkIndex: number,
  voiceGender: string,
): Promise<Uint8Array> {
  const voiceName = voiceGender === "male" ? "Ethan" : "Marisol";

  const createResponse = await fetch(CHATTERBOX_TURBO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${replicateApiKey}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({
      input: {
        text,
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
    throw new Error(`Chatterbox chunk ${chunkIndex + 1} failed: ${createResponse.status} - ${errText}`);
  }

  let prediction = await createResponse.json();

  while (prediction.status !== "succeeded" && prediction.status !== "failed") {
    await sleep(1000);
    const pollResponse = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${replicateApiKey}` },
    });
    prediction = await pollResponse.json();
  }

  if (prediction.status === "failed") {
    throw new Error(`Chatterbox chunk ${chunkIndex + 1} failed: ${prediction.error || "Unknown"}`);
  }

  const outputUrl = prediction.output;
  if (!outputUrl) throw new Error(`No output from Chatterbox chunk ${chunkIndex + 1}`);

  const audioResponse = await fetch(outputUrl);
  if (!audioResponse.ok) throw new Error(`Failed to download audio chunk ${chunkIndex + 1}`);

  return new Uint8Array(await audioResponse.arrayBuffer());
}

async function generateChatterboxChunked(
  scene: AudioScene,
  sceneNumber: number,
  replicateApiKey: string,
  supabase: any,
  storage: StorageStrategy,
  voiceGender: string,
): Promise<AudioResult> {
  const voiceoverText = sanitizeVoiceover(scene.voiceover);
  if (!voiceoverText || voiceoverText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  const TTS_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= TTS_ATTEMPTS; attempt++) {
    try {
      const chunks = splitTextIntoChunks(voiceoverText, 400);
      console.log(`[TTS-Chatterbox] Scene ${sceneNumber}: ${chunks.length} chunks (attempt ${attempt})`);

      let finalWavBytes: Uint8Array;

      if (chunks.length === 1) {
        finalWavBytes = await callChatterboxChunk(chunks[0], replicateApiKey, 0, voiceGender);
      } else {
        // Generate chunks in parallel
        const chunkPromises = chunks.map((chunk, idx) =>
          callChatterboxChunk(chunk, replicateApiKey, idx, voiceGender),
        );
        const audioBuffers = await Promise.all(chunkPromises);
        finalWavBytes = stitchWavBuffers(audioBuffers);
      }

      const parsed = extractPcmFromWav(finalWavBytes);
      const bytesPerSecond = parsed.sampleRate * parsed.numChannels * (parsed.bitsPerSample / 8);
      const durationSeconds = Math.max(1, parsed.pcm.length / bytesPerSecond);

      const url = await uploadAndGetUrl(supabase, finalWavBytes, "audio/wav", storage, sceneNumber);

      console.log(`[TTS-Chatterbox] Scene ${sceneNumber} ✅ SUCCESS (${durationSeconds.toFixed(1)}s)`);
      return { url, durationSeconds, provider: "Replicate Chatterbox" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown Chatterbox error";
      console.error(`[TTS-Chatterbox] Scene ${sceneNumber} attempt ${attempt} error:`, errorMsg);
      if (attempt < TTS_ATTEMPTS) await sleep(2000 * Math.pow(2, attempt - 1));
    }
  }

  return { url: null, error: `Chatterbox failed after ${TTS_ATTEMPTS} attempts` };
}

// ============= MAIN ENTRY POINT =============

/**
 * Generate audio for a single scene. Routes to the correct TTS provider
 * based on language, voice type, and available API keys.
 */
export async function generateSceneAudio(
  scene: AudioScene,
  config: AudioEngineConfig,
): Promise<AudioResult> {
  const voiceoverText = sanitizeVoiceover(scene.voiceover);
  if (!voiceoverText || voiceoverText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  const {
    replicateApiKey,
    googleApiKeys,
    elevenLabsApiKey,
    lemonfoxApiKey,
    supabase,
    storage,
    voiceGender = "female",
    customVoiceId,
    forceHaitianCreole = false,
  } = config;

  const isHC = forceHaitianCreole || isHaitianCreole(voiceoverText);

  if (forceHaitianCreole && !isHaitianCreole(voiceoverText)) {
    console.log(`[TTS] Scene ${scene.number}: Forcing Haitian Creole from presenter_focus`);
  }

  // ========== CASE 1: Haitian Creole + Cloned Voice ==========
  // Gemini TTS → ElevenLabs Speech-to-Speech
  if (isHC && customVoiceId && elevenLabsApiKey && googleApiKeys.length > 0) {
    console.log(`[TTS] Scene ${scene.number}: HC + Custom Voice workflow (${googleApiKeys.length} keys)`);

    const geminiResult = await generateGeminiTTSWithKeyRotation(
      voiceoverText, scene.number, googleApiKeys, supabase, storage,
    );

    if (!geminiResult.url) {
      return geminiResult;
    }

    // Transform with ElevenLabs STS
    console.log(`[TTS] Scene ${scene.number}: Transforming with ElevenLabs STS`);
    const stsResult = await transformWithElevenLabsSTS(
      geminiResult.url, customVoiceId, scene.number, elevenLabsApiKey, supabase, storage,
    );

    if (stsResult.url) {
      console.log(`✅ Scene ${scene.number} SUCCEEDED: Gemini TTS → ElevenLabs STS`);
      return stsResult;
    }
    return stsResult;
  }

  // ========== CASE 2: Custom Voice (non-HC) ==========
  if (customVoiceId && elevenLabsApiKey && !isHC) {
    console.log(`[TTS] Scene ${scene.number}: Custom voice via ElevenLabs TTS`);
    const result = await generateElevenLabsTTS(
      voiceoverText, scene.number, customVoiceId, elevenLabsApiKey, supabase, storage,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number} SUCCEEDED: ElevenLabs TTS`);
      return result;
    }
    return result;
  }

  // ========== CASE 3: Haitian Creole (Standard Voice) ==========
  // Gemini TTS (3-key rotation, 5 rounds) → ElevenLabs STS (voice-over)
  // Male: WyscUDDs9ZWbMjTYd7By | Female: XZUXLIpE3dqJ9aCZUj2R
  if (isHC && googleApiKeys.length > 0 && elevenLabsApiKey) {
    const stsVoiceId = voiceGender === "male" ? "WyscUDDs9ZWbMjTYd7By" : "XZUXLIpE3dqJ9aCZUj2R";
    console.log(`[TTS] Scene ${scene.number}: HC standard voice → Gemini TTS → ElevenLabs STS (${voiceGender}, voice ${stsVoiceId})`);

    const geminiResult = await generateGeminiTTSWithKeyRotation(
      voiceoverText, scene.number, googleApiKeys, supabase, storage,
    );
    if (!geminiResult.url) {
      return { url: null, error: `HC standard TTS failed: Gemini exhausted — ${geminiResult.error}` };
    }

    // Voice-over via ElevenLabs Speech-to-Speech
    console.log(`[TTS] Scene ${scene.number}: Transforming with ElevenLabs STS (${voiceGender})`);
    const stsResult = await transformWithElevenLabsSTS(
      geminiResult.url, stsVoiceId, scene.number, elevenLabsApiKey, supabase, storage,
    );
    if (stsResult.url) {
      console.log(`✅ Scene ${scene.number} SUCCEEDED: Gemini TTS → ElevenLabs STS (HC standard ${voiceGender})`);
      return { ...stsResult, provider: `ElevenLabs STS HC (${voiceGender})` };
    }
    return stsResult;
  }

  // ========== CASE 4: Default (English/other) — Lemonfox → Chatterbox → Gemini fallback ==========

  // Try Lemonfox first (if key available)
  if (lemonfoxApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Standard voice via Lemonfox TTS`);
    const lemonfoxResult = await generateLemonfoxTTS(
      scene, scene.number, lemonfoxApiKey, supabase, storage, voiceGender,
    );
    if (lemonfoxResult.url) return lemonfoxResult;
    console.warn(`[TTS] Scene ${scene.number}: Lemonfox failed (${lemonfoxResult.error}), falling back to Chatterbox`);
  }

  // Chatterbox fallback
  console.log(`[TTS] Scene ${scene.number}: Standard voice via Chatterbox`);
  const chatterboxResult = await generateChatterboxChunked(
    scene, scene.number, replicateApiKey, supabase, storage, voiceGender,
  );

  if (chatterboxResult.url) return chatterboxResult;

  // Chatterbox failed — fall back to Gemini TTS if keys are available
  if (googleApiKeys.length > 0) {
    console.warn(
      `[TTS] Scene ${scene.number}: Chatterbox exhausted (${chatterboxResult.error}). Falling back to Gemini TTS.`,
    );
    const geminiResult = await generateGeminiTTSWithKeyRotation(
      voiceoverText, scene.number, googleApiKeys, supabase, storage,
    );
    if (geminiResult.url) {
      console.log(`✅ Scene ${scene.number} SUCCEEDED via Gemini TTS fallback after Chatterbox failure`);
      return { ...geminiResult, provider: "Gemini TTS (Chatterbox fallback)" };
    }
    console.error(`[TTS] Scene ${scene.number}: Gemini TTS fallback also failed: ${geminiResult.error}`);
    return { url: null, error: `TTS failed: Lemonfox, Chatterbox (${chatterboxResult.error}), Gemini (${geminiResult.error})` };
  }

  // No fallback available
  return chatterboxResult;
}

/**
 * Generate audio for multiple scenes with batching (max 3 concurrent, 500ms delay between batches).
 * This reduces burst QPS to prevent Google rate limits.
 */
export async function generateAudioBatched(
  scenes: AudioScene[],
  config: AudioEngineConfig,
  onSceneComplete?: (index: number, result: AudioResult) => void,
): Promise<AudioResult[]> {
  const BATCH_SIZE = 3;
  const BATCH_DELAY_MS = 500;
  const results: AudioResult[] = new Array(scenes.length).fill({ url: null });

  for (let batchStart = 0; batchStart < scenes.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, scenes.length);
    console.log(`[AudioEngine] Processing batch ${batchStart + 1}-${batchEnd} of ${scenes.length}`);

    const batchPromises = [];
    for (let i = batchStart; i < batchEnd; i++) {
      batchPromises.push(
        generateSceneAudio(scenes[i], config).then((result) => {
          results[i] = result;
          onSceneComplete?.(i, result);
          return result;
        }),
      );
    }

    await Promise.all(batchPromises);

    // Delay between batches to reduce burst QPS
    if (batchEnd < scenes.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return results;
}
