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

/**
 * C-6-2 / Shield S-006 — build a Content-Disposition header value that is
 * proof against CRLF / quote / backslash injection from a user-supplied
 * filename. Exported for unit tests.
 *
 * Strategy:
 *   1. Strip ALL CR / LF / NUL bytes — these are the primitives for
 *      response-splitting. There is no legitimate filename character
 *      that justifies allowing them through.
 *   2. Drop `"` and `\` from the quoted-string fallback so a closing
 *      quote can't be smuggled in.
 *   3. Fall back to a safe default if the result is empty.
 *   4. Emit both a sanitised `filename="…"` (legacy) and an RFC 5987
 *      `filename*=UTF-8''<percent-encoded>` form. Modern browsers
 *      prefer the latter and the percent-encoding step makes header
 *      injection impossible by construction (CR/LF cannot survive
 *      `encodeURIComponent`).
 */
export function buildContentDisposition(rawFilename: string): string {
  // Strip control characters (incl. CR, LF, NUL, tab) entirely.
  // deno-lint-ignore no-control-regex
  const stripped = rawFilename.replace(/[\r\n\0\t\x00-\x1f\x7f]/g, "");

  // Quoted-string fallback for legacy clients: kill the quote /
  // backslash characters that would let an attacker close the quoted
  // string early and append further header tokens.
  const quotedSafe = stripped.replace(/["\\]/g, "");

  // If sanitisation emptied the string, fall back to a generic name.
  const legacy = quotedSafe.length > 0 ? quotedSafe : "file";

  // RFC 5987 percent-encoding for the canonical form.
  const encoded = encodeURIComponent(stripped.length > 0 ? stripped : "file");

  return `attachment; filename="${legacy}"; filename*=UTF-8''${encoded}`;
}

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

  // C-6-2 / Shield S-006 — Path normalization to defeat traversal attempts.
  // Reject obvious abuse vectors before we run the authorization check.
  // ".." → directory traversal; backslash → Windows-style traversal that
  // Storage may interpret differently; leading "/" → absolute path; URL-
  // encoded variants of the same (Storage accepts %2E%2E in some paths).
  const lowered = filePath.toLowerCase();
  if (
    filePath.includes("..") ||
    filePath.includes("\\") ||
    filePath.startsWith("/") ||
    lowered.includes("%2e%2e") ||
    lowered.includes("%2f") ||
    lowered.includes("%5c") ||
    filePath.includes("\0")
  ) {
    return new Response("Invalid path", { status: 400 });
  }

  // C-6-2 / Shield S-006 — Strict prefix match instead of substring.
  // The previous `filePath.includes(user.id)` allowed any user whose
  // UUID happened to be a substring of the path to read the file.
  // `startsWith(user.id + "/")` enforces that the file lives directly
  // under a directory named for the caller's UUID — i.e. proper IDOR
  // containment. The trailing "/" prevents a "userid-suffix"-style
  // bypass (`<uuid>otherstuff/...` no longer matches).
  if (!filePath.startsWith(user.id + "/")) {
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
  const rawFilename = filePath.split("/").pop() || "file";

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
    // C-6-2 / Shield S-006 — Filename may carry user-controlled bytes
    // (project name / scene title baked into the storage path). Without
    // sanitisation an attacker can inject CR/LF into Content-Disposition
    // and split the HTTP response into two messages (response-splitting),
    // or unbalance the quoted-string with `"` / `\` and smuggle further
    // header tokens. Build both a sanitised quoted `filename=` (for
    // legacy clients) and an RFC 5987 `filename*=UTF-8''…` form which
    // is percent-encoded and has no quote-escaping ambiguity. Browsers
    // prefer the latter when both are present.
    headers["Content-Disposition"] = buildContentDisposition(rawFilename);
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
    message: `serve-media: ${bucket}/${rawFilename}`,
    details: { bucket, contentType, download },
  });

  // 302 redirect to the signed URL — browser follows it transparently
  return new Response(null, { status: 302, headers });
}
Deno.serve(handler);
