/**
 * Utility for generating optimized thumbnail URLs from Supabase storage.
 * Appends width/height/format query params for Supabase Image Transformations.
 *
 * For non-Supabase URLs (external CDN, AI-generated), returns the URL as-is.
 */

const SUPABASE_STORAGE_PATTERN = /\/storage\/v1\/object\/(public|sign)\//;

interface ThumbnailOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: "webp" | "avif" | "origin";
}

const DEFAULTS: Required<ThumbnailOptions> = {
  width: 400,
  height: 400,
  quality: 75,
  format: "webp",
};

/**
 * Append Supabase image transformation params to a storage URL.
 * Non-Supabase URLs are returned unchanged.
 */
export function thumbnailUrl(
  imageUrl: string | null | undefined,
  options?: ThumbnailOptions
): string | null {
  if (!imageUrl) return null;

  // Only transform Supabase storage URLs
  if (!SUPABASE_STORAGE_PATTERN.test(imageUrl)) return imageUrl;

  const opts = { ...DEFAULTS, ...options };

  // Build transformation query string
  const params = new URLSearchParams();
  params.set("width", String(opts.width));
  params.set("height", String(opts.height));
  params.set("quality", String(opts.quality));
  if (opts.format !== "origin") {
    params.set("format", opts.format);
  }

  // If URL already has query params (e.g. signed URLs with ?token=...), append with &
  const separator = imageUrl.includes("?") ? "&" : "?";
  return `${imageUrl}${separator}${params.toString()}`;
}

/**
 * Shortcut for grid/card thumbnails (300x300 WebP).
 */
export function gridThumbnailUrl(imageUrl: string | null | undefined): string | null {
  return thumbnailUrl(imageUrl, { width: 300, height: 300, quality: 70 });
}

/**
 * Shortcut for full-preview images (preserve more quality).
 */
export function previewImageUrl(imageUrl: string | null | undefined): string | null {
  return thumbnailUrl(imageUrl, { width: 1024, height: 1024, quality: 85 });
}
