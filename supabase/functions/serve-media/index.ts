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

import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "range",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      },
    });
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

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

  const headers: Record<string, string> = {
    "Location": data.signedUrl,
    "Cache-Control": "private, max-age=120",
    "Access-Control-Allow-Origin": "*",
  };

  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  }

  // 302 redirect to the signed URL — browser follows it transparently
  return new Response(null, { status: 302, headers });
});
