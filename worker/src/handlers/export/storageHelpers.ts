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

/** Upload final MP4 to Supabase Storage using streaming REST. */
export async function uploadToSupabase(
  localPath: string,
  fileName: string
): Promise<string> {
  const stat = await fs.promises.stat(localPath);
  const stream = fs.createReadStream(localPath);

  const { WORKER_SUPABASE_URL: supabaseUrl, WORKER_SUPABASE_KEY: supabaseKey } =
    await import("../../lib/supabase.js");

  const storagePath = `exports/${fileName}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${storagePath}`;

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

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase upload failed (${response.status}): ${errText}`);
  }

  const { data: publicData } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(storagePath);
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
