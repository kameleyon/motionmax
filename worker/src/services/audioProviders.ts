/**
 * TTS provider implementations for the Node.js worker.
 * Ported from supabase/functions/_shared/audioEngine.ts.
 * Key change: base64Decode → Buffer.from(str, "base64") via base64ToUint8Array.
 */

import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";
import {
  sanitizeVoiceover,
  sanitizeForGeminiTTS,
  splitTextIntoChunks,
  pcmToWav,
  extractPcmFromWav,
  stitchWavBuffers,
  base64ToUint8Array,
} from "./audioWavUtils.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Storage ────────────────────────────────────────────────────────

export async function uploadAudio(
  bytes: Uint8Array,
  contentType: string,
  projectId: string,
  sceneNumber: number,
  suffix?: string,
): Promise<string> {
  const ext = contentType.includes("mpeg") ? "mp3" : "wav";
  const name = suffix ? `scene-${sceneNumber}-${suffix}-${Date.now()}.${ext}` : `scene-${sceneNumber}-${Date.now()}.${ext}`;
  // Use the same "audio" bucket + path pattern as the edge function
  const filePath = `${projectId}/${name}`;

  const { error } = await supabase.storage
    .from("audio")
    .upload(filePath, bytes, { contentType, upsert: true });

  if (error) throw new Error(`Audio upload failed: ${error.message}`);

  // Return a 7-day signed URL (matching edge function behaviour)
  const { data: signedData, error: signError } = await supabase.storage
    .from("audio")
    .createSignedUrl(filePath, 604800);

  if (signError || !signedData?.signedUrl) {
    throw new Error(`Audio signed URL failed: ${signError?.message}`);
  }

  return signedData.signedUrl;
}

// ── Gemini TTS ─────────────────────────────────────────────────────

const GEMINI_MODELS = [
  { name: "gemini-2.5-pro-preview-tts", label: "2.5 Pro Preview TTS" },
  { name: "gemini-2.5-flash-preview-tts", label: "2.5 Flash Preview TTS" },
];
const KEY_ROTATION_ROUNDS = 5;

async function callGeminiTTSModel(
  text: string, sceneNumber: number, apiKey: string, model: { name: string; label: string }, round: number,
): Promise<{ url: string | null; error?: string; durationSeconds?: number; provider?: string }> {
  let voiceoverText = sanitizeForGeminiTTS(text);
  if (!voiceoverText || voiceoverText.length < 2) return { url: null, error: "No voiceover text" };

  // Promo pattern removal
  const promo = [
    /\b(swiv|follow|like|subscribe|kòmante|comment|pataje|share|abòneman)\b[^.]*\./gi,
    /\b(swiv kont|follow the|like and|share this)\b[^.]*$/gi,
    /\.\s*(swiv|like|pataje|share|follow)[^.]*$/gi,
  ];
  for (const p of promo) voiceoverText = voiceoverText.replace(p, ".");
  voiceoverText = voiceoverText.replace(/\.+/g, ".").replace(/\s+/g, " ").trim();

  if (round > 0) {
    const variations = [
      voiceoverText, "Please narrate the following: " + voiceoverText,
      "Read this story aloud: " + voiceoverText, voiceoverText + " End of narration.",
      "Educational content: " + voiceoverText, "Documentary narration: " + voiceoverText,
    ];
    voiceoverText = variations[round % variations.length];
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `[Speak with natural enthusiasm and warmth] ${voiceoverText}` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Enceladus" } } },
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 429) throw Object.assign(new Error(`Gemini quota exhausted`), { quotaExhausted: true });
    return { url: null, error: `Gemini ${model.label} ${res.status}: ${err.substring(0,100)}` };
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "OTHER") return { url: null, error: "Gemini content filter" };
  if (!candidate?.content?.parts?.[0]?.inlineData?.data) return { url: null, error: "No audio data" };

  let pcm = base64ToUint8Array(candidate.content.parts[0].inlineData.data);
  // Trim trailing silence
  const SILENCE_THRESHOLD = 300;
  let trimEnd = pcm.length;
  for (let i = pcm.length - 2; i >= 0; i -= 2) {
    const sample = Math.abs(((pcm[i] | (pcm[i+1] << 8)) << 16) >> 16);
    if (sample > SILENCE_THRESHOLD) { trimEnd = Math.min(pcm.length, i + 14400); break; }
  }
  if (trimEnd < pcm.length) pcm = pcm.slice(0, trimEnd);

  return { url: "__pcm__", durationSeconds: Math.max(1, pcm.length / 48000), provider: `Gemini ${model.label}`, error: undefined };
  // Note: caller handles wav conversion + upload; return raw data via side-band
  // Actually, return url as placeholder — let the caller handle
}

export async function generateGeminiTTS(
  text: string,
  sceneNumber: number,
  googleApiKeys: string[],
  projectId: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string; pcmBytes?: Uint8Array }> {
  for (let round = 0; round < KEY_ROTATION_ROUNDS; round++) {
    if (round > 0) await sleep(3000 * round);
    for (const apiKey of googleApiKeys) {
      for (const model of GEMINI_MODELS) {
        try {
          let voiceoverText = sanitizeForGeminiTTS(text);
          if (!voiceoverText || voiceoverText.length < 2) return { url: null, error: "No text" };
          const promo = [
            /\b(swiv|follow|like|subscribe|kòmante|comment|pataje|share|abòneman)\b[^.]*\./gi,
            /\b(swiv kont|follow the|like and|share this)\b[^.]*$/gi,
          ];
          for (const p of promo) voiceoverText = voiceoverText.replace(p, ".");
          voiceoverText = voiceoverText.replace(/\.+/g, ".").replace(/\s+/g, " ").trim();

          if (round > 0) {
            const v = ["Please narrate: ", "Read aloud: ", "Educational: ", "Story: "];
            voiceoverText = v[round % v.length] + voiceoverText;
          }

          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `[Speak with natural enthusiasm] ${voiceoverText}` }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Enceladus" } } },
                },
              }),
            },
          );

          if (!res.ok) {
            const err = await res.text();
            if (res.status === 429) break; // rotate key
            continue;
          }

          const data = await res.json();
          const candidate = data.candidates?.[0];
          if (candidate?.finishReason === "OTHER" || !candidate?.content?.parts?.[0]?.inlineData?.data) continue;

          let pcm = base64ToUint8Array(candidate.content.parts[0].inlineData.data);
          const SILENCE_THRESHOLD = 300;
          let trimEnd = pcm.length;
          for (let i = pcm.length - 2; i >= 0; i -= 2) {
            const sample = Math.abs(((pcm[i] | (pcm[i+1] << 8)) << 16) >> 16);
            if (sample > SILENCE_THRESHOLD) { trimEnd = Math.min(pcm.length, i + 14400); break; }
          }
          if (trimEnd < pcm.length) pcm = pcm.slice(0, trimEnd);

          const wav = pcmToWav(pcm, 24000, 1, 16);
          const url = await uploadAudio(wav, "audio/wav", projectId, sceneNumber);
          const durationSeconds = Math.max(1, pcm.length / (24000 * 2));
          console.log(`[TTS-Gemini] Scene ${sceneNumber} ✅ ${model.label}`);
          return { url, durationSeconds, provider: `Gemini ${model.label}` };
        } catch (err: any) {
          if (err?.quotaExhausted) break;
        }
      }
    }
  }
  return { url: null, error: "All Gemini keys exhausted" };
}

// ── ElevenLabs TTS ─────────────────────────────────────────────────

export async function generateElevenLabsTTS(
  text: string, sceneNumber: number, voiceId: string, apiKey: string, projectId: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const sanitized = sanitizeVoiceover(text);
  if (!sanitized || sanitized.length < 2) return { url: null, error: "No text" };

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text: sanitized, model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.65, use_speaker_boost: true } }),
  });

  if (!res.ok) return { url: null, error: `ElevenLabs TTS ${res.status}` };

  const bytes = new Uint8Array(await res.arrayBuffer());
  const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber);
  return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: "ElevenLabs TTS" };
}

// ── ElevenLabs STS ─────────────────────────────────────────────────

export async function transformElevenLabsSTS(
  sourceUrl: string, voiceId: string, sceneNumber: number, apiKey: string, projectId: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const srcRes = await fetch(sourceUrl);
  if (!srcRes.ok) return { url: null, error: `Download source audio: ${srcRes.status}` };
  const srcBytes = new Uint8Array(await srcRes.arrayBuffer());

  const boundary = `----ElevenLabsSTS${Date.now()}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="source.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    srcBytes,
    enc.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\neleven_multilingual_sts_v2\r\n`),
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="voice_settings"\r\n\r\n{"stability":0.3,"similarity_boost":0.75,"style":0.65,"use_speaker_boost":true}\r\n`),
    enc.encode(`--${boundary}--\r\n`),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }

  const res = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!res.ok) return { url: null, error: `ElevenLabs STS ${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber, "sts");
  return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: "ElevenLabs STS" };
}

// ── LemonFox TTS ───────────────────────────────────────────────────

export async function generateLemonfoxTTS(
  text: string, sceneNumber: number, voiceGender: string, apiKey: string, projectId: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const sanitized = sanitizeVoiceover(text);
  if (!sanitized) return { url: null, error: "No text" };
  const voice = voiceGender === "male" ? "adam" : "river";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.lemonfox.ai/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: sanitized, voice, response_format: "mp3" }),
    });
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * attempt); continue; }
      return { url: null, error: `Lemonfox ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) return { url: null, error: "Empty audio" };
    const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber);
    return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: `Lemonfox (${voice})` };
  }
  return { url: null, error: "Lemonfox failed" };
}

// ── Fish Audio TTS ─────────────────────────────────────────────────

const FISH_AUDIO_FEMALE_VOICE = "c64a9003acb44737ae2a2d548c772b91";
const FISH_AUDIO_MALE_VOICE = "06a8fa125ea54698b0c84feac214abad";

export async function generateFishAudioTTS(
  text: string, sceneNumber: number, apiKey: string, projectId: string, voiceId?: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const referenceId = voiceId || FISH_AUDIO_FEMALE_VOICE;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", model: "s2" },
      body: JSON.stringify({ text, reference_id: referenceId, format: "mp3" }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[FishAudio] Attempt ${attempt} failed (${res.status}): ${errBody.substring(0, 300)}`);
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * Math.pow(2, attempt-1)); continue; }
      return { url: null, error: `Fish Audio ${res.status}: ${errBody.substring(0, 100)}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) return { url: null, error: "Empty audio" };
    const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber);
    return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: "Fish Audio TTS" };
  }
  return { url: null, error: "Fish Audio failed" };
}

// ── Replicate Chatterbox ───────────────────────────────────────────

export async function generateChatterboxTTS(
  text: string, sceneNumber: number, voiceGender: string, replicateApiKey: string, projectId: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const sanitized = sanitizeVoiceover(text);
  if (!sanitized) return { url: null, error: "No text" };
  const voice = voiceGender === "male" ? "Ethan" : "Marisol";
  const chunks = splitTextIntoChunks(sanitized, 400);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const wavsPromises = chunks.map(async (chunk, idx) => {
        const createRes = await fetch("https://api.replicate.com/v1/models/resemble-ai/chatterbox-turbo/predictions", {
          method: "POST",
          headers: { Authorization: `Bearer ${replicateApiKey}`, "Content-Type": "application/json", Prefer: "wait" },
          body: JSON.stringify({ input: { text: chunk, voice, temperature: 0.9, top_p: 1, top_k: 1800, repetition_penalty: 2 } }),
        });
        if (!createRes.ok) throw new Error(`Chatterbox chunk ${idx} failed: ${createRes.status}`);
        let pred = await createRes.json();
        while (pred.status !== "succeeded" && pred.status !== "failed") {
          await sleep(1000);
          const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { Authorization: `Bearer ${replicateApiKey}` } });
          pred = await poll.json();
        }
        if (pred.status === "failed") throw new Error(`Chatterbox chunk ${idx} failed`);
        const audioRes = await fetch(pred.output);
        return new Uint8Array(await audioRes.arrayBuffer());
      });
      const wavBuffers = await Promise.all(wavsPromises);
      const finalWav = chunks.length === 1 ? wavBuffers[0] : stitchWavBuffers(wavBuffers);
      const parsed = extractPcmFromWav(finalWav);
      const duration = Math.max(1, parsed.pcm.length / (parsed.sampleRate * parsed.numChannels * (parsed.bitsPerSample / 8)));
      const url = await uploadAudio(finalWav, "audio/wav", projectId, sceneNumber);
      return { url, durationSeconds: duration, provider: "Chatterbox" };
    } catch (err) {
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  return { url: null, error: "Chatterbox failed" };
}
