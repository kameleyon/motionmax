/**
 * Hypereal Nano Banana Pro Edit — advanced image editing with natural
 * language and resolution control up to 4K.
 *
 * Model: nano-banana-pro-edit (11 credits)
 * Pricing: 1K/2K = $0.11, 4K = $0.22
 *
 * Used for "Apply Edit" in scene editing — modifies an existing image
 * based on a text instruction (e.g. "change the sky to sunset"). The
 * upstream accepts 1-14 source images per request; we always pass
 * exactly one (the scene's current frame) since the editor's affordance
 * is per-scene.
 */

import { writeApiLog } from "../lib/logger.js";

// nano-banana-pro-edit lives on the dedicated /images/edit endpoint,
// not /images/generate. Hitting /generate with an edit model can
// silently fall through to a text-to-image render that ignores the
// `images` array — exactly the failure mode user reported (a "Canada
// 2026" infographic returning a "Golden Key" storybook scene).
const HYPEREAL_IMAGE_EDIT_URL = "https://api.hypereal.cloud/v1/images/edit";
const NANO_BANANA_PRO_MODEL = "nano-banana-pro-edit";

export type NanoBananaProResolution = "1k" | "2k" | "4k";

/** Default to 2K — meaningful upgrade over the 1K legacy default
 *  without paying the 4K premium ($0.22 vs $0.11). Callers that need
 *  the full 4K bump can pass it through explicitly. */
const DEFAULT_RESOLUTION: NanoBananaProResolution = "2k";

export async function editImageWithNanoBanana(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  aspectRatio: string = "16:9",
  resolution: NanoBananaProResolution = DEFAULT_RESOLUTION,
): Promise<string> {
  console.log(`[NanoBananaProEdit] Editing image: "${prompt.substring(0, 60)}..." aspect=${aspectRatio} res=${resolution} src=${imageUrl.substring(0, 80)}...`);
  const startTime = Date.now();

  const response = await fetch(HYPEREAL_IMAGE_EDIT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NANO_BANANA_PRO_MODEL,
      prompt,
      images: [imageUrl],
      aspect_ratio: aspectRatio,
      resolution,
      output_format: "png",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Nano Banana Pro Edit API Error: ${response.status} - ${errorText}`);
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
    throw err;
  }

  const data = await response.json() as any;

  // Extract the edited image URL from response
  const editedUrl = data?.data?.[0]?.url || data?.outputUrl || data?.output_url || data?.url;

  if (!editedUrl) {
    // If async job, poll for result
    const jobId = data?.jobId;
    if (jobId) {
      const result = await pollNanoBananaJob(jobId, apiKey);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
      return result;
    }
    const err = new Error(`No image URL returned from Nano Banana Pro Edit: ${JSON.stringify(data).substring(0, 200)}`);
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
    throw err;
  }

  console.log(`[NanoBananaProEdit] Edit complete: ${editedUrl.substring(0, 80)}...`);
  writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
  return editedUrl;
}

/** Poll for async job completion */
async function pollNanoBananaJob(jobId: string, apiKey: string): Promise<string> {
  const maxAttempts = 30;
  const pollMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, pollMs));

    const url = `https://api.hypereal.cloud/v1/jobs/${jobId}?model=${NANO_BANANA_PRO_MODEL}&type=image`;
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!res.ok) continue;

    const data = await res.json() as any;
    if (data.status === "succeeded" || data.status === "completed") {
      const imageUrl = data.outputUrl || data.output_url || data.result?.url || data.output?.url || data.url || data?.data?.[0]?.url;
      if (imageUrl) return imageUrl;
      throw new Error("Nano Banana Pro Edit job completed but no URL found");
    }
    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Nano Banana Pro Edit failed: ${data.error || "Unknown error"}`);
    }
  }

  throw new Error("Nano Banana Pro Edit timed out");
}
