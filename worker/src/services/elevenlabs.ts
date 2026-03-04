import fetch from "node-fetch";

export async function generateSpeechUrl(
  text: string,
  voiceId: string,
  elevenLabsApiKey: string
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

  // Instead of directly using the edge stream, the worker saves it locally or uploads to Supabase Storage
  // For the moment, we capture the buffer.
  const arrayBuffer = await response.arrayBuffer();
  
  // Here we will eventually upload the buffer to Supabase Storage and return the URL
  // Return dummy URL to maintain shape in scaffolding phase
  return "https://example.com/mock-audio.mp3";
}