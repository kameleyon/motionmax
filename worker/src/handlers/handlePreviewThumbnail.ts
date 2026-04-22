/**
 * Generate a single preview thumbnail for the Intake form's "Live preview"
 * card. Takes the current prompt + visual style + aspect ratio and
 * returns a Supabase-hosted image URL.
 *
 * task_type: "preview_thumbnail"
 * payload:  { prompt: string, style: string, format: 'landscape' | 'portrait' }
 * result:   { imageUrl: string }
 *
 * Runs the same Hypereal (gemini-3-1-flash-t2i) → Replicate fallback as
 * scene images, so the preview is a FAITHFUL sample of what the user
 * will see in scene 1. Heavily cached at the service layer (prompt +
 * format key), so repeat identical calls are free.
 */

import { generateImage } from "../services/imageGenerator.js";
import { getStylePrompt } from "../services/prompts.js";

interface PreviewThumbnailPayload {
  prompt: string;
  style?: string;
  format?: string;
}

export async function handlePreviewThumbnail(
  _jobId: string,
  payload: PreviewThumbnailPayload,
  _userId?: string,
): Promise<{ imageUrl: string }> {
  const prompt = (payload.prompt ?? "").trim();
  if (prompt.length < 6) {
    throw new Error("Preview prompt too short (need 6+ chars)");
  }

  const styleId = payload.style || "realistic";
  const format = payload.format === "landscape" ? "landscape" : "portrait";

  // Same prompt shape as scene images: style preamble + the user's idea.
  const stylePreamble = getStylePrompt(styleId);
  const fullPrompt = `${stylePreamble}\n\n${prompt}`;

  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();

  if (!hyperealApiKey && !replicateApiKey) {
    throw new Error("No image provider configured (HYPEREAL_API_KEY or REPLICATE_API_KEY)");
  }

  console.log(`[PreviewThumbnail] style=${styleId} format=${format} prompt=${prompt.length} chars`);

  // `generateImage` already uploads to Supabase storage and caches by
  // (prompt, format) — so a user who types the same prompt twice gets
  // the same URL back for free. projectId just namespaces the storage
  // path; using a constant keeps all previews in one folder.
  const imageUrl = await generateImage(
    fullPrompt,
    hyperealApiKey,
    replicateApiKey,
    format,
    "__previews__", // pseudo-project-id bucket for all preview thumbnails
  );

  return { imageUrl };
}
