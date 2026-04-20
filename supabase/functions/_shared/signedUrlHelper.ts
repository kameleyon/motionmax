/**
 * Shared helper for Supabase signed URL operations.
 *
 * Previously duplicated across get-shared-project and refresh-project-thumbnails.
 * Centralised here to keep the refresh logic in one place.
 */

/** Returns true if the URL is a Supabase signed storage URL. */
export function isSignedUrl(url: string): boolean {
  return typeof url === "string" && url.includes("/storage/v1/object/sign/");
}

/**
 * Extracts the bucket + path string from a signed URL.
 * Returns "bucket/path/to/file" or null if the URL cannot be parsed.
 */
export function extractStoragePath(signedUrl: string): string | null {
  try {
    const url = new URL(signedUrl);
    // Path format: /storage/v1/object/sign/bucket/path/to/file
    const pathMatch = url.pathname.match(/\/storage\/v1\/object\/sign\/(.+)/);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Generates a fresh signed URL from an existing (possibly expired) signed URL.
 * Falls back to the original URL on any error.
 *
 * @param supabase  Supabase client (any role)
 * @param oldUrl    Existing signed URL
 * @param expiresIn Desired TTL in seconds (default: 7 days)
 * @param logPrefix Optional prefix for log messages, e.g. "[my-function]"
 */
export async function refreshSignedUrl(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  oldUrl: string,
  expiresIn = 604800,
  logPrefix = "[signedUrlHelper]",
): Promise<string> {
  if (!oldUrl || !isSignedUrl(oldUrl)) {
    return oldUrl;
  }

  const fullPath = extractStoragePath(oldUrl);
  if (!fullPath) return oldUrl;

  const slashIndex = fullPath.indexOf("/");
  if (slashIndex === -1) return oldUrl;

  const bucket = fullPath.substring(0, slashIndex);
  const path = fullPath.substring(slashIndex + 1);

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn);

    if (error || !data?.signedUrl) {
      console.error(`${logPrefix} Failed to refresh signed URL for ${path}:`, error);
      return oldUrl;
    }

    return data.signedUrl;
  } catch (err) {
    console.error(`${logPrefix} Unexpected error refreshing signed URL:`, err);
    return oldUrl;
  }
}
