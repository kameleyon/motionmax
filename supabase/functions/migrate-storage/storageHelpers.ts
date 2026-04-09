import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";

export const BUCKETS = [
  "scene-images",
  "audio-files",
  "scene-videos",
  "project-thumbnails",
  "style-references",
  "videos",
  "voice_samples",
  "source_uploads",
  "audio",
];

interface StorageFile {
  name: string;
  path: string;
  size: number;
  created_at: string;
}

/** Recursively list all files in a bucket under a given prefix */
export async function listAllFiles(
  admin: SupabaseClient,
  bucket: string,
  prefix = ""
): Promise<StorageFile[]> {
  const files: StorageFile[] = [];
  const { data, error } = await admin.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });

  if (error || !data) return files;

  for (const item of data) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id) {
      files.push({
        name: item.name,
        path: fullPath,
        size: (item.metadata as Record<string, unknown>)?.size as number ?? 0,
        created_at: item.created_at ?? "",
      });
    } else {
      const nested = await listAllFiles(admin, bucket, fullPath);
      files.push(...nested);
    }
  }

  return files;
}

/** Count files across all 9 buckets */
export async function actionListAll(admin: SupabaseClient) {
  const counts: Record<string, number> = {};
  for (const bucket of BUCKETS) {
    const files = await listAllFiles(admin, bucket);
    counts[bucket] = files.length;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { buckets: counts, total };
}

/** List all files in a specific bucket */
export async function actionListBucket(admin: SupabaseClient, bucket: string) {
  if (!BUCKETS.includes(bucket)) {
    return { error: `Unknown bucket: ${bucket}. Valid: ${BUCKETS.join(", ")}` };
  }
  const files = await listAllFiles(admin, bucket);
  return { bucket, count: files.length, files };
}

/** Generate 7-day signed download URLs for every file in a bucket */
export async function actionManifest(admin: SupabaseClient, bucket: string) {
  if (!BUCKETS.includes(bucket)) {
    return { error: `Unknown bucket: ${bucket}. Valid: ${BUCKETS.join(", ")}` };
  }

  const files = await listAllFiles(admin, bucket);
  const SEVEN_DAYS = 60 * 60 * 24 * 7;
  const manifest: Array<{ path: string; signedUrl: string; size: number }> = [];

  // Process in batches of 50 to stay within rate limits
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const paths = batch.map((f) => f.path);

    const { data, error } = await admin.storage
      .from(bucket)
      .createSignedUrls(paths, SEVEN_DAYS);

    if (error || !data) continue;

    for (let j = 0; j < data.length; j++) {
      manifest.push({
        path: batch[j].path,
        signedUrl: data[j].signedUrl ?? "",
        size: batch[j].size,
      });
    }
  }

  return {
    bucket,
    generated_at: new Date().toISOString(),
    expires_in: "7 days",
    count: manifest.length,
    files: manifest,
  };
}

/** Proxy-download a single file and return the Blob or an error object */
export async function actionDownload(
  admin: SupabaseClient,
  bucket: string,
  path: string
): Promise<Blob | { error: string }> {
  if (!BUCKETS.includes(bucket)) {
    return { error: `Unknown bucket: ${bucket}` };
  }
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) {
    return { error: error?.message ?? "File not found" };
  }
  return data;
}
