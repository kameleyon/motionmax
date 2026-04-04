/**
 * Hypereal Nano Banana Edit — fast image editing with natural language.
 * Model: nano-banana-edit (3 credits, $0.04/image)
 *
 * Used for "Apply Edit" in scene editing — modifies an existing image
 * based on a text instruction (e.g. "change the sky to sunset").
 */

const HYPEREAL_IMAGE_URL = "https://api.hypereal.cloud/v1/images/generate";

export async function editImageWithNanoBanana(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  aspectRatio: string = "16:9",
): Promise<string> {
  console.log(`[NanoBananaEdit] Editing image: "${prompt.substring(0, 60)}..." aspect=${aspectRatio}`);

  const response = await fetch(HYPEREAL_IMAGE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "nano-banana-edit",
      prompt,
      images: [imageUrl],
      aspect_ratio: aspectRatio,
      output_format: "png",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Nano Banana Edit API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;

  // Extract the edited image URL from response
  const editedUrl = data?.data?.[0]?.url || data?.outputUrl || data?.output_url || data?.url;

  if (!editedUrl) {
    // If async job, poll for result
    const jobId = data?.jobId;
    if (jobId) {
      return pollNanoBananaJob(jobId, apiKey);
    }
    throw new Error(`No image URL returned from Nano Banana Edit: ${JSON.stringify(data).substring(0, 200)}`);
  }

  console.log(`[NanoBananaEdit] Edit complete: ${editedUrl.substring(0, 80)}...`);
  return editedUrl;
}

/** Poll for async job completion */
async function pollNanoBananaJob(jobId: string, apiKey: string): Promise<string> {
  const maxAttempts = 30;
  const pollMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollMs));

    const url = `https://api.hypereal.cloud/v1/jobs/${jobId}?model=nano-banana-edit&type=image`;
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!res.ok) continue;

    const data = await res.json() as any;
    if (data.status === "succeeded" || data.status === "completed") {
      const imageUrl = data.outputUrl || data.output_url || data.result?.url || data.output?.url || data.url || data?.data?.[0]?.url;
      if (imageUrl) return imageUrl;
      throw new Error("Nano Banana Edit job completed but no URL found");
    }
    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Nano Banana Edit failed: ${data.error || "Unknown error"}`);
    }
  }

  throw new Error("Nano Banana Edit timed out");
}
