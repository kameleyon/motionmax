/**
 * File download / upload / cleanup helpers for the export pipeline.
 * Streams data to/from disk to avoid loading large blobs into Node.js heap.
 */
import fs from "fs";
import { pipeline } from "stream/promises";
import { supabase } from "../../lib/supabase.js";

const BUCKET_NAME = "videos";

/** Stream a URL directly to disk without buffering in Node.js heap. */
export async function streamToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${url}: ${response.statusText}`);
  if (!response.body) throw new Error(`No response body for ${url}`);
  const dest = fs.createWriteStream(destPath);
  await pipeline(response.body, dest);
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
    const { data: publicData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
    return publicData.publicUrl;
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

      if (!patchRes.ok) {
        const err = await patchRes.text();
        throw new Error(`TUS PATCH failed at offset ${offset} (${patchRes.status}): ${err}`);
      }

      offset += chunkLen;
      const pct = Math.round((offset / fileSize) * 100);
      console.log(`[StorageUpload] TUS chunk uploaded — ${pct}%`);
    }
  } finally {
    await fd.close();
  }

  console.log(`[StorageUpload] TUS resumable upload complete`);
  const { data: publicData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
  return publicData.publicUrl;
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
