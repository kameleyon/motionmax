/**
 * File download / upload / cleanup helpers for the export pipeline.
 * Streams data to/from disk to avoid loading large blobs into Node.js heap.
 */
import fs from "fs";
import { pipeline } from "stream/promises";
import { supabase } from "../../lib/supabase.js";
import { validateMedia, MediaValidationError, type MediaKind } from "./mediaValidator.js";

const BUCKET_NAME = "videos";

/** Return the direct public URL for a storage file.
 *  Video elements need direct URLs — they can't follow 302 redirects. */
function getPublicVideoUrl(storagePath: string): string {
  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Extract the storage path (bucket/path) from a Supabase signed URL.
 * Returns null if the URL is not a signed storage URL.
 */
function extractStoragePath(signedUrl: string): string | null {
  try {
    const url = new URL(signedUrl);
    const pathMatch = url.pathname.match(/\/storage\/v1\/object\/sign\/(.+)/);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Re-sign a Supabase signed storage URL to get a fresh token.
 * Returns the original URL unchanged if it's not a signed URL.
 */
async function refreshSignedUrl(url: string): Promise<string> {
  if (!url || !url.includes("/storage/v1/object/sign/")) return url;

  const fullPath = extractStoragePath(url);
  if (!fullPath) return url;

  const slashIndex = fullPath.indexOf("/");
  if (slashIndex === -1) return url;

  const bucket = fullPath.substring(0, slashIndex);
  const storagePath = fullPath.substring(slashIndex + 1);

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600); // 1 hour — plenty for download

  if (error || !data?.signedUrl) {
    console.warn(`[StorageHelpers] Failed to refresh signed URL for ${bucket}/${storagePath}:`, error?.message);
    return url; // Fallback to original
  }

  console.log(`[StorageHelpers] Refreshed signed URL for ${bucket}/${storagePath}`);
  return data.signedUrl;
}

/**
 * Extract bucket name and object path from a Supabase public-object URL.
 * Returns null when the URL is not in the expected format.
 */
function extractPublicUrlParts(url: string): { bucket: string; path: string } | null {
  const m = url.match(/\/object\/public\/([^/]+)\/(.+)/);
  return m ? { bucket: m[1], path: m[2] } : null;
}

/** Resolve the best fetchable URL for a storage object, preferring a fresh
 *  signed URL when we can generate one. Prevents stale-public-URL 400s and
 *  expired-signature 403s. */
async function resolveFetchUrl(url: string): Promise<string> {
  // scene-images public URLs → skip public-URL attempt entirely; use signed URL.
  // The Storage metadata cache can lag behind DB changes, causing spurious 400s.
  if (url.includes("/object/public/scene-images/")) {
    const parts = extractPublicUrlParts(url);
    if (parts) {
      const { data, error } = await supabase.storage
        .from(parts.bucket)
        .createSignedUrl(parts.path, 3600);
      if (!error && data?.signedUrl) {
        console.log(`[StorageHelpers] Using signed URL for scene-images/${parts.path}`);
        return data.signedUrl;
      }
    }
    return url;
  }
  // Refresh expired signed URLs for non-public paths.
  return refreshSignedUrl(url);
}

/** Try to produce a fresh signed URL for any Supabase storage URL
 *  (public or signed). Returns null if we can't parse the URL. */
async function makeFreshSignedUrl(url: string): Promise<string | null> {
  // Signed URL form: /storage/v1/object/sign/<bucket>/<path>
  const signedPath = extractStoragePath(url);
  if (signedPath) {
    const slash = signedPath.indexOf("/");
    if (slash > 0) {
      const bucket = signedPath.substring(0, slash);
      const storagePath = signedPath.substring(slash + 1);
      const { data } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 3600);
      if (data?.signedUrl) return data.signedUrl;
    }
  }
  // Public URL form: /object/public/<bucket>/<path>
  const pub = extractPublicUrlParts(url);
  if (pub) {
    const { data } = await supabase.storage.from(pub.bucket).createSignedUrl(pub.path, 3600);
    if (data?.signedUrl) return data.signedUrl;
  }
  return null;
}

/** Fetch a URL to disk. Handles 400/403 fallback to signed URL. */
async function fetchToDisk(url: string, destPath: string): Promise<void> {
  let response = await fetch(url);

  // Fallback: any public URL that still returns 400/403 → create signed URL.
  if ((response.status === 400 || response.status === 403) && url.includes("/object/public/")) {
    const parts = extractPublicUrlParts(url);
    if (parts) {
      const { data, error } = await supabase.storage
        .from(parts.bucket)
        .createSignedUrl(parts.path, 3600);
      if (!error && data?.signedUrl) {
        console.warn(`[StorageHelpers] Public URL returned ${response.status} for ${parts.bucket}/${parts.path} — retrying with signed URL`);
        response = await fetch(data.signedUrl);
      }
    }
  }

  if (!response.ok) throw new Error(`Download failed ${url}: ${response.statusText}`);
  if (!response.body) throw new Error(`No response body for ${url}`);
  const dest = fs.createWriteStream(destPath);
  await pipeline(response.body, dest);
}

/** Stream a URL directly to disk without buffering in Node.js heap.
 *
 *  When `expectedKind` is passed, validates the downloaded file's magic bytes
 *  against the expected media type. If validation fails, retries ONCE with a
 *  fresh signed URL (covers stale CDN caches / truncated responses). Any
 *  second failure is reported as a clear MediaValidationError — much better
 *  than a downstream ffmpeg error like "Header missing" on a corrupt MP3.
 *
 *  For scene-images public URLs: always converts to a fresh signed URL first
 *  because the Supabase Storage service caches the bucket's public flag and
 *  may return 400 even after the bucket is marked public.
 *  For other public URLs: falls back to a signed URL on 400/403. */
export async function streamToFile(
  url: string,
  destPath: string,
  expectedKind?: MediaKind,
): Promise<void> {
  const fetchUrl = await resolveFetchUrl(url);
  await fetchToDisk(fetchUrl, destPath);

  // If caller didn't request validation, we're done.
  if (!expectedKind) return;

  try {
    await validateMedia(destPath, expectedKind);
    return;
  } catch (firstErr) {
    if (!(firstErr instanceof MediaValidationError)) throw firstErr;
    console.warn(
      `[StorageHelpers] ${expectedKind} validation failed on first download (${firstErr.reason}): ` +
        `${firstErr.diagnostic ?? firstErr.message}. Retrying with fresh signed URL...`,
    );

    // Retry once with a freshly-signed URL.
    const freshUrl = await makeFreshSignedUrl(url);
    if (!freshUrl) {
      throw new Error(
        `${expectedKind} download corrupted and URL cannot be re-signed (${firstErr.reason}): ${url} — ${firstErr.diagnostic ?? ""}`,
      );
    }
    // Remove the bad file so the retry writes fresh bytes.
    try { await fs.promises.unlink(destPath); } catch { /* ignore */ }
    await fetchToDisk(freshUrl, destPath);

    try {
      await validateMedia(destPath, expectedKind);
      console.log(`[StorageHelpers] ${expectedKind} validation passed after retry`);
    } catch (secondErr) {
      if (!(secondErr instanceof MediaValidationError)) throw secondErr;
      throw new Error(
        `${expectedKind} download still corrupted after retry (${secondErr.reason}): ${url} — ${secondErr.diagnostic ?? secondErr.message}`,
      );
    }
  }
}

/** Size threshold (in bytes) above which we skip straight to TUS resumable. */
const TUS_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB

/** Upload final MP4 to Supabase Storage.
 *  Standard REST upload first; falls back to TUS resumable upload
 *  when the file exceeds the standard upload limit (413).
 *  Files above 50 MB skip REST and go directly to TUS. */
export async function uploadToSupabase(
  localPath: string,
  fileName: string
): Promise<string> {
  const stat = await fs.promises.stat(localPath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  console.log(`[StorageUpload] File: ${fileName} — ${sizeMB} MB`);

  const { WORKER_SUPABASE_URL: supabaseUrl, WORKER_SUPABASE_KEY: supabaseKey } =
    await import("../../lib/supabase.js");

  const storagePath = `exports/${fileName}`;

  // Large files → skip REST entirely and go straight to TUS
  if (stat.size > TUS_THRESHOLD_BYTES) {
    console.log(`[StorageUpload] File exceeds ${TUS_THRESHOLD_BYTES / (1024 * 1024)} MB — using TUS resumable directly`);
    return tusResumableUpload(localPath, storagePath, stat.size, supabaseUrl, supabaseKey);
  }

  // Try standard REST upload first
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${storagePath}`;
  const stream = fs.createReadStream(localPath);

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      apikey: supabaseKey,
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "x-upsert": "true",
    },
    body: stream as any,
    duplex: "half",
  } as any);

  if (response.ok) {
    console.log(`[StorageUpload] Standard upload succeeded (${sizeMB} MB)`);
    return getPublicVideoUrl(storagePath);
  }

  const errText = await response.text();

  // Detect 413 from either HTTP status OR response body (Supabase may
  // return HTTP 400 with {"statusCode":"413","error":"Payload too large"})
  if (isPayloadTooLarge(response.status, errText)) {
    console.warn(`[StorageUpload] Payload too large (${sizeMB} MB) — trying TUS resumable`);
    return tusResumableUpload(localPath, storagePath, stat.size, supabaseUrl, supabaseKey);
  }

  throw new Error(`Supabase upload failed (${response.status}): ${errText}`);
}

/** Check whether a failed upload response indicates 413 Payload Too Large.
 *  Supabase may return HTTP 413 directly, or HTTP 400 with the 413 code
 *  embedded in the JSON body. */
function isPayloadTooLarge(httpStatus: number, body: string): boolean {
  if (httpStatus === 413) return true;
  try {
    const parsed = JSON.parse(body);
    const code = String(parsed?.statusCode ?? "");
    const error = String(parsed?.error ?? "").toLowerCase();
    if (code === "413" || error.includes("payload too large")) return true;
  } catch {
    // body is not JSON — check raw text
    if (body.includes("413") && body.toLowerCase().includes("payload too large")) return true;
  }
  return false;
}

/** TUS resumable upload — handles large files that exceed the standard upload limit.
 *  Uploads in 6 MB chunks via the Supabase TUS endpoint. */
async function tusResumableUpload(
  localPath: string,
  storagePath: string,
  fileSize: number,
  supabaseUrl: string,
  supabaseKey: string,
): Promise<string> {
  const CHUNK_SIZE = 6 * 1024 * 1024; // 6 MB per chunk
  const tusUrl = `${supabaseUrl}/storage/v1/upload/resumable`;

  // Step 1: Create the upload
  const createRes = await fetch(tusUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      apikey: supabaseKey,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(fileSize),
      "Upload-Metadata": `bucketName ${btoa(BUCKET_NAME)},objectName ${btoa(storagePath)},contentType ${btoa("video/mp4")}`,
      "x-upsert": "true",
    },
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`TUS create failed (${createRes.status}): ${err}`);
  }

  const uploadLocation = createRes.headers.get("Location");
  if (!uploadLocation) throw new Error("TUS create did not return Location header");
  console.log(`[StorageUpload] TUS session created — uploading ${(fileSize / (1024 * 1024)).toFixed(1)} MB in ${Math.ceil(fileSize / CHUNK_SIZE)} chunks`);

  // Step 2: Upload in chunks
  const fd = await fs.promises.open(localPath, "r");
  let offset = 0;

  try {
    while (offset < fileSize) {
      const chunkLen = Math.min(CHUNK_SIZE, fileSize - offset);
      const buffer = Buffer.alloc(chunkLen);
      await fd.read(buffer, 0, chunkLen, offset);

      // Retry TUS PATCH up to 3 times on transient errors (500, 502, 503)
      let patchOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const patchRes = await fetch(uploadLocation, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${supabaseKey}`,
            apikey: supabaseKey,
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(chunkLen),
          },
          body: buffer,
        });

        if (patchRes.ok) {
          patchOk = true;
          break;
        }

        const err = await patchRes.text();
        if (patchRes.status >= 500 && attempt < 3) {
          console.warn(`[StorageUpload] TUS PATCH transient error at offset ${offset} (${patchRes.status}), retry ${attempt}/3...`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw new Error(`TUS PATCH failed at offset ${offset} (${patchRes.status}): ${err}`);
      }
      if (!patchOk) throw new Error(`TUS PATCH failed at offset ${offset} after 3 retries`);

      offset += chunkLen;
      const pct = Math.round((offset / fileSize) * 100);
      console.log(`[StorageUpload] TUS chunk uploaded — ${pct}%`);
    }
  } finally {
    await fd.close();
  }

  console.log(`[StorageUpload] TUS resumable upload complete`);
  return getPublicVideoUrl(storagePath);
}

/** Silently remove files (cleanup helper). */
export function removeFiles(...paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
