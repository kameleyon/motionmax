/**
 * CDN-aware URL rewriter for Supabase storage objects.
 *
 * If `VITE_CDN_PREFIX` is set (e.g. `https://cdn.motionmax.io`),
 * all Supabase storage URLs are rewritten to go through the CDN.
 * Otherwise the original Supabase URL is returned unchanged.
 *
 * Usage:
 *   import { cdnUrl } from "@/lib/cdnUrl";
 *   <img src={cdnUrl(row.image_url)} />
 */

const CDN_PREFIX: string = import.meta.env.VITE_CDN_PREFIX ?? "";
const SUPABASE_HOST_RE = /https?:\/\/[a-z0-9]+\.supabase\.co/;

/**
 * Replace the Supabase host portion of a storage URL with
 * the CDN prefix when configured.
 */
export function cdnUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!CDN_PREFIX) return url;
  if (!SUPABASE_HOST_RE.test(url)) return url;

  return url.replace(SUPABASE_HOST_RE, CDN_PREFIX);
}

/**
 * Build a full public storage URL through the CDN.
 * Combines bucket + path segments into a complete URL.
 */
export function cdnStorageUrl(
  supabaseUrl: string,
  bucket: string,
  path: string,
): string {
  const base = CDN_PREFIX || supabaseUrl;
  return `${base}/storage/v1/object/public/${bucket}/${path}`;
}
