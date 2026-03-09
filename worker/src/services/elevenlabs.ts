import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";

export async function generateSpeechUrl(
  text: string,
  voiceId: string,
  elevenLabsApiKey: string,
  projectId?: string
): Promise<string> {
  console.log(`[ElevenLabs] Generating audio for voice: ${voiceId}`);

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Accept": "audio/mpeg",
      "xi-api-key": elevenLabsApiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs API Error: ${response.status} - ${err}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);

  if (audioBuffer.length < 100) {
    throw new Error(`ElevenLabs returned suspiciously small audio (${audioBuffer.length} bytes)`);
  }

  // Upload to Supabase Storage
  const fileName = `audio/${projectId || "worker"}/${uuidv4()}.mp3`;
  const { error: uploadError } = await supabase.storage
    .from("generation-assets")
    .upload(fileName, audioBuffer, {
      contentType: "audio/mpeg",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload audio to Supabase Storage: ${uploadError.message}`);
  }

  const { data: publicData } = supabase.storage
    .from("generation-assets")
    .getPublicUrl(fileName);

  console.log(`[ElevenLabs] Audio uploaded: ${publicData.publicUrl} (${audioBuffer.length} bytes)`);
  return publicData.publicUrl;
}
