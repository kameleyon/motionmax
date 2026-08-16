/**
 * Export-time 4K upres pass.
 *
 * The image generation chain caps out at 1536x1024 (gpt-image-2 via
 * Hypereal; the OpenRouter and Gemini fallbacks are no higher), so a
 * 3840x2160 export built straight from generated frames would just be
 * a 2.5x stretch. `nano-banana-pro-edit` is the only 4K-capable model
 * we have wired, and it reconstructs real detail rather than
 * interpolating — so image-backed scenes are routed through it at
 * `resolution: "4k"` before encoding.
 *
 * Video-backed scenes are NOT handled here. Seedance renders at 1080p
 * and ffmpeg lanczos-upscales those clips; that is an accepted
 * limitation of the feature, not a gap in this module.
 *
 * Cost: ~$0.22/image (see providerRates.hypereal_nano_banana_pro).
 * This is the most expensive image call the worker makes, which is why
 * the caller gates it on plan and only runs it at export time — never
 * on scene regeneration, where the spend would be thrown away.
 */

import { editImageWithNanoBanana } from "../../services/nanoBananaEdit.js";

/** Concurrent upres calls. Deliberately low: a 10-scene project would
 *  otherwise open 10 simultaneous Hypereal requests, and this runs
 *  inside an export job that already holds one of MAX_EXPORT_JOBS slots. */
const UPRES_CONCURRENCY = 3;

const ASPECT_BY_FORMAT: Record<string, string> = {
  landscape: "16:9",
  portrait: "9:16",
  square: "1:1",
};

/**
 * Identity-preserving instruction.
 *
 * This prompt must introduce NO content. Nano Banana Pro will happily
 * treat a bare prompt as a fresh generation request, so the phrasing
 * mirrors the guardrail already proven in handleRegenerateImage.ts:
 * lead by forbidding change, then state the only permitted operation.
 * Any noun added here would appear in every 4K scene of every project.
 */
const UPRES_INSTRUCTION =
  "EDIT THE IMAGE, DO NOT CHANGE THE IMAGE. Preserve the composition, " +
  "subject, framing, pose, colour palette, lighting and artistic style " +
  "EXACTLY as they already are. Do not add, remove, replace or " +
  "reinterpret any element. Do not add text. The ONLY permitted change " +
  "is to resolve finer detail: sharpen existing texture, recover edge " +
  "definition, and render the same image at higher fidelity.";

export interface Upres4KResult {
  /** Same length and order as the input. Entries that failed hold the
   *  original URL, so this is always safe to encode from. */
  urls: string[];
  /** Count genuinely reconstructed at 4K. */
  upscaled: number;
  /** Count that fell back to the original resolution. */
  failed: number;
}

/**
 * Upres a list of scene image URLs to 4K.
 *
 * Never throws and never rejects. A per-image failure falls back to the
 * original URL — a 4K export carrying two 1536px scenes is a far better
 * outcome than a failed export the user waited minutes for.
 *
 * The caller is responsible for the total-failure case: if `upscaled`
 * is 0 there is no real 4K detail anywhere, and the export should drop
 * back to a 1080p render rather than ship an all-upscaled file labelled
 * 4K.
 *
 * @param imageUrls  Scene image URLs, in scene order. Empty/undefined
 *                   entries pass through untouched.
 * @param format     Project format — selects the aspect ratio.
 * @param apiKey     HYPEREAL_API_KEY (the edit/video key, not the
 *                   image-generation key).
 */
export async function upresScenesTo4K(
  imageUrls: (string | undefined | null)[],
  format: string,
  apiKey: string,
  projectId?: string,
  attribution: { userId: string | null; generationId: string | null; jobId: string | null } =
    { userId: null, generationId: null, jobId: null },
): Promise<Upres4KResult> {
  const aspectRatio = ASPECT_BY_FORMAT[format] || "16:9";
  const urls: string[] = imageUrls.map((u) => u ?? "");
  let upscaled = 0;
  let failed = 0;

  if (!apiKey) {
    console.warn("[Upres4K] HYPEREAL_API_KEY missing — skipping upres, all scenes stay at source resolution");
    return { urls, upscaled: 0, failed: imageUrls.filter(Boolean).length };
  }

  // Indices worth spending money on. Blank entries are video-backed or
  // empty scenes and are left exactly as they came in.
  const targets = urls
    .map((url, index) => ({ url, index }))
    .filter(({ url }) => typeof url === "string" && url.trim().length > 0);

  if (targets.length === 0) {
    console.log("[Upres4K] No image-backed scenes to upres");
    return { urls, upscaled: 0, failed: 0 };
  }

  console.log(`[Upres4K] Upscaling ${targets.length} scene image(s) to 4K (aspect=${aspectRatio}, concurrency=${UPRES_CONCURRENCY})`);

  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const { url, index } = targets[cursor++];
      try {
        const upresUrl = await editImageWithNanoBanana(
          url,
          UPRES_INSTRUCTION,
          apiKey,
          aspectRatio,
          "4k",
          projectId,
          attribution,
        );
        urls[index] = upresUrl;
        upscaled++;
        console.log(`[Upres4K] scene ${index}: OK`);
      } catch (err) {
        // Keep the original URL. The encoder will lanczos-scale it to
        // the 4K canvas, which is exactly what this scene would have
        // got without the feature.
        failed++;
        console.warn(`[Upres4K] scene ${index}: FAILED, using source image — ${(err as Error).message}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPRES_CONCURRENCY, targets.length) }, () => runWorker()),
  );

  console.log(`[Upres4K] Done: ${upscaled} upscaled, ${failed} fell back`);
  return { urls, upscaled, failed };
}
