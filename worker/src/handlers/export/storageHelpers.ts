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

/** Upload final MP4 to Supabase Storage.
 *  Standard REST upload first; falls back to TUS resumable upload
 *  when the file exceeds the standard upload limit (413). */
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

  // If 413 Payload Too Large — fall back to TUS resumable upload
  if (response.status === 413) {
    console.warn(`[StorageUpload] Standard upload 413 (${sizeMB} MB) — trying TUS resumable`);
    return tusResumableUpload(localPath, storagePath, stat.size, supabaseUrl, supabaseKey);
  }

  throw new Error(`Supabase upload failed (${response.status}): ${errText}`);
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
