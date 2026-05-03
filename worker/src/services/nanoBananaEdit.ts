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
import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";

const HYPEREAL_IMAGE_EDIT_URL = "https://api.hypereal.cloud/v1/images/generate";
const NANO_BANANA_PRO_MODEL = "nano-banana-pro-edit";

export type NanoBananaProResolution = "1k" | "2k" | "4k";

/** Default per Hypereal spec is "1k". */
const DEFAULT_RESOLUTION: NanoBananaProResolution = "1k";

/** Re-host an r2.dev (or any external) image URL on Supabase. r2.dev
 *  has hotlink protection — motionmax.io referers get 404'd — so we
 *  ALWAYS persist the bytes to our own bucket before handing the URL
 *  back to the editor. Mirrors imageGenerator.ts's uploadToStorage.
 *
 *  Trusts the response's Content-Type to decide the storage extension
 *  + MIME — a stale "always-png" assumption is what shipped the URL
 *  the user saw 404 on (Hypereal returned a JPEG; we wrote it under
 *  a .png path with image/png MIME, which Supabase happily stored but
 *  the public URL Supabase auto-resolves only matches when the actual
 *  content matches the declared type). */
async function rehostToSupabase(externalUrl: string, projectId: string): Promise<string> {
  const res = await fetch(externalUrl);
  if (!res.ok) throw new Error(`Edit re-host fetch failed: ${res.status} ${externalUrl.substring(0, 80)}`);
  const contentType = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
  const ext =
    contentType === "image/jpeg" || contentType === "image/jpg" ? "jpg"
    : contentType === "image/webp" ? "webp"
    : "png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const fileName = `${projectId}/${uuidv4()}.${ext}`;
  console.log(`[NanoBananaProEdit] Re-host upload: bucket=scene-images path=${fileName} ct=${contentType} bytes=${bytes.length}`);
  const { error } = await supabase.storage
    .from("scene-images")
    .upload(fileName, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Edit re-host upload failed: ${error.message} (path=${fileName})`);
  const { data } = supabase.storage.from("scene-images").getPublicUrl(fileName);
  console.log(`[NanoBananaProEdit] Re-host public URL: ${data.publicUrl}`);
  return data.publicUrl;
}

export async function editImageWithNanoBanana(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  aspectRatio: string = "16:9",
  resolution: NanoBananaProResolution = DEFAULT_RESOLUTION,
  projectId?: string,
): Promise<string> {
  if (!imageUrl || typeof imageUrl !== "string" || imageUrl.trim().length === 0) {
    throw new Error("editImageWithNanoBanana: imageUrl is required and must be a non-empty string");
  }

  const images = [imageUrl];
  const requestBody = {
    model: NANO_BANANA_PRO_MODEL,
    prompt,
    images,
    aspect_ratio: aspectRatio,
    resolution,
    output_format: "png",
  };

  console.log(`[NanoBananaProEdit] images.length=${images.length} src=${imageUrl.substring(0, 100)}`);
  console.log(`[NanoBananaProEdit] Editing image: "${prompt.substring(0, 60)}..." aspect=${aspectRatio} res=${resolution}`);
  const startTime = Date.now();

  const response = await fetch(HYPEREAL_IMAGE_EDIT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
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
      const polledUrl = await pollNanoBananaJob(jobId, apiKey);
      const finalUrl = projectId ? await rehostToSupabase(polledUrl, projectId) : polledUrl;
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
      return finalUrl;
    }
    const err = new Error(`No image URL returned from Nano Banana Pro Edit: ${JSON.stringify(data).substring(0, 200)}`);
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
    throw err;
  }

  console.log(`[NanoBananaProEdit] Edit complete (r2): ${editedUrl}`);
  const finalUrl = projectId ? await rehostToSupabase(editedUrl, projectId) : editedUrl;
  writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: NANO_BANANA_PRO_MODEL, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[NanoBananaProEdit] background log failed:', (err as Error).message); });
  return finalUrl;
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
