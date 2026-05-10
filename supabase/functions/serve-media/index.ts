/**
 * Media proxy edge function.
 *
 * Streams video/image files from Supabase Storage through a clean URL.
 * This hides the raw Supabase storage URL from end users.
 *
 * Usage:
 *   /functions/v1/serve-media?bucket=videos&path=exports/video.mp4
 *   /functions/v1/serve-media?bucket=scene-images&path=project/image.png
 *
 * Proxied via Vercel rewrite:
 *   motionmax.io/api/video/exports/video.mp4
 *   → supabase.co/functions/v1/serve-media?bucket=videos&path=exports/video.mp4
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { writeSystemLog } from "../_shared/log.ts";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

const ALLOWED_BUCKETS = ["videos", "scene-images", "scene-videos", "audio"];

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export async function handler(req: Request): Promise<Response> {
  const requestOrigin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    // Use the shared allowlist instead of "*". Range + Authorization
    // headers must still be advertised for byte-range video playback.
    const preflight = handleCorsPreflightRequest(requestOrigin);
    if (preflight.status !== 204) return preflight;
    const headers = new Headers(preflight.headers);
    headers.set("Access-Control-Allow-Headers", "range, authorization");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    return new Response(null, { status: 204, headers });
  }

  // Require authentication
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
  if (authError || !user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Rate limiting
  const rateLimitResult = await checkRateLimit(supabase, {
    key: "serve-media",
    maxRequests: 60,
    windowSeconds: 60,
    userId: user.id,
  });
  if (!rateLimitResult.allowed) {
    return new Response("Rate limit exceeded. Try again later.", { status: 429 });
  }

  const url = new URL(req.url);
  const bucket = url.searchParams.get("bucket") || "videos";
  const filePath = url.searchParams.get("path");
  const download = url.searchParams.get("download") === "true";

  if (!filePath) {
    return new Response("Missing path parameter", { status: 400 });
  }

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return new Response("Invalid bucket", { status: 400 });
  }

  // Validate the requested path belongs to the authenticated user
  if (!filePath.includes(user.id)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Generate a short-lived signed URL (5 min)
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, 300, { download });

  if (error || !data?.signedUrl) {
    console.error("[serve-media] Failed to create signed URL:", error?.message);
    return new Response("File not found", { status: 404 });
  }

  // For download requests or if client just needs the file, redirect to signed URL
  // This is fast (no streaming through the function) and supports range requests
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  const filename = filePath.split("/").pop() || "file";

  // Build response headers off the shared CORS helper so the 302 only
  // advertises ACAO for allowlisted origins. Same-origin callers
  // (motionmax.io rewrite path) don't need ACAO; cross-origin direct
  // callers are gated by the allowlist.
  const cors = getCorsHeaders(requestOrigin);
  const headers: Record<string, string> = {
    ...cors,
    "Location": data.signedUrl,
    "Cache-Control": "private, max-age=120",
  };

  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  }

  // Hot-path system_info row so we can chart serve-media volume per
  // bucket on the admin dashboard without scraping function logs.
  // Awaited but writeSystemLog swallows errors → never blocks the
  // 302, never breaks playback.
  await writeSystemLog({
    supabase,
    category: "system_info",
    event_type: "media.served",
    userId: user.id,
    message: `serve-media: ${bucket}/${filename}`,
    details: { bucket, contentType, download },
  });

  // 302 redirect to the signed URL — browser follows it transparently
  return new Response(null, { status: 302, headers });
}
Deno.serve(handler);
