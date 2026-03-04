import fetch from "node-fetch";

const HYPEREAL_IMAGE_URL = "https://hypereal.tech/api/v1/images/generate";
const HYPEREAL_VIDEO_URL = "https://hypereal.tech/api/v1/videos/generate";
const HYPEREAL_JOB_POLL_URL = "https://hypereal.tech/api/v1/jobs";

export async function generateImage(prompt: string, apiKey: string, aspectRatio = "16:9") {
  console.log(`[Hypereal] Generating image for prompt: ${prompt.substring(0, 50)}...`);
  
  const response = await fetch(HYPEREAL_IMAGE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      model: "gemini-3-1-flash-t2i",
      format: aspectRatio
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Image API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  if (!data?.data?.[0]?.url) {
    throw new Error("No image URL returned from Hypereal");
  }

  return data.data[0].url;
}

export async function generateVideoFromImage(imageUrl: string, prompt: string, apiKey: string) {
  console.log(`[Hypereal] Starting Seedance I2V job...`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "seedance-1-5-pro-high",
      image_url: imageUrl,
      prompt: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Video API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;

  if (!jobId) throw new Error("No jobId returned from Hypereal Video API");

  return pollVideoJob(jobId, apiKey);
}

async function pollVideoJob(jobId: string, apiKey: string): Promise<string> {
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes max (assuming 5s delay)
  
  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
    
    console.log(`[Hypereal] Polling job ${jobId} (Attempt ${attempts})...`);
    
    const response = await fetch(`${HYPEREAL_JOB_POLL_URL}/${jobId}?model=seedance-1-5-pro-high&type=video`, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });

    if (!response.ok) {
       console.warn(`[Hypereal] Poll failed with status ${response.status}`);
       continue;
    }

    const data = await response.json() as any;
    
    if (data.status === "succeeded") {
      return data.outputUrl;
    } else if (data.status === "failed") {
      throw new Error(`Hypereal Video Job Failed: ${data.error}`);
    }
    // "processing" or "starting", so we loop again
  }

  throw new Error("Hypereal Video Job timed out waiting for success.");
}