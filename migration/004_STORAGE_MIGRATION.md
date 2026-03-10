# 004 — Storage File Migration Guide

Migrate all storage files (images, audio, videos, thumbnails, voices) from the **source** Supabase project to the **target** project using the `migrate-storage` edge function and a local Node.js script.

## Buckets (9 total)

| Bucket | Access | Typical content |
|---|---|---|
| `scene-images` | public | Generated scene images |
| `audio-files` | public | TTS / background audio |
| `scene-videos` | public | Per-scene video clips |
| `project-thumbnails` | public | Dashboard thumbnails |
| `style-references` | public | User-uploaded style refs |
| `videos` | public | Final exported videos |
| `voice_samples` | public | Cloned-voice WAV samples |
| `source_uploads` | public | Raw user uploads |
| `audio` | **private** | Private audio (signed URLs) |

---

## Prerequisites

- Admin account on the **source** project  
- Service-role keys for **both** source and target projects  
- Node.js ≥ 18 with `@supabase/supabase-js` installed  
- The `migrate-storage` edge function deployed on the **source** project

---

## Step 1 — Deploy the Edge Function

```bash
supabase functions deploy migrate-storage --project-ref <SOURCE_REF>
```

The function lives at `supabase/functions/migrate-storage/` with two files:

| File | Purpose |
|---|---|
| `index.ts` | Auth check, query-param routing |
| `storageHelpers.ts` | Recursive listing, manifest generation, proxy download |

---

## Step 2 — List Buckets & File Counts

Call the function as an authenticated admin:

```javascript
const { data: { session } } = await supabase.auth.getSession();
const headers = { Authorization: `Bearer ${session.access_token}` };

// Count files in every bucket
const res = await fetch(
  'https://<SOURCE_REF>.supabase.co/functions/v1/migrate-storage?action=list',
  { headers }
);
console.log(await res.json());
// → { buckets: { "scene-images": 1753, "audio": 42, ... }, total: 2100 }
```

List files in a single bucket:

```javascript
const res = await fetch(
  'https://<SOURCE_REF>.supabase.co/functions/v1/migrate-storage?action=list&bucket=audio',
  { headers }
);
const { count, files } = await res.json();
```

---

## Step 3 — Generate Signed Manifests

For each bucket, generate a manifest of 7-day signed download URLs:

```javascript
const res = await fetch(
  'https://<SOURCE_REF>.supabase.co/functions/v1/migrate-storage?action=manifest&bucket=audio',
  { headers }
);
const manifest = await res.json();

// Save manifest to disk (browser)
const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = 'audio_manifest.json';
a.click();
```

Repeat for every bucket:

```
scene-images, audio-files, scene-videos, project-thumbnails,
style-references, videos, voice_samples, source_uploads, audio
```

Each manifest JSON has the shape:

```json
{
  "bucket": "audio",
  "generated_at": "2026-03-10T05:00:00.000Z",
  "expires_in": "7 days",
  "count": 42,
  "files": [
    { "path": "user-id/file.mp3", "signedUrl": "https://...", "size": 102400 }
  ]
}
```

---

## Step 4 — Run the Migration Script

Save the script below as `migrate-storage.mjs`:

```javascript
// migrate-storage.mjs
// Usage: node migrate-storage.mjs <manifest.json> <bucket_name>
//
// Env vars:
//   SOURCE_SUPABASE_URL   — old project URL
//   SOURCE_SERVICE_KEY    — old project service-role key
//   TARGET_SUPABASE_URL   — new project URL
//   TARGET_SERVICE_KEY    — new project service-role key

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const sourceUrl = process.env.SOURCE_SUPABASE_URL;
const sourceKey = process.env.SOURCE_SERVICE_KEY;
const targetUrl = process.env.TARGET_SUPABASE_URL;
const targetKey = process.env.TARGET_SERVICE_KEY;

if (!sourceUrl || !sourceKey || !targetUrl || !targetKey) {
  console.error('Set SOURCE_SUPABASE_URL, SOURCE_SERVICE_KEY, TARGET_SUPABASE_URL, TARGET_SERVICE_KEY');
  process.exit(1);
}

const [,, manifestPath, bucketName] = process.argv;
if (!manifestPath || !bucketName) {
  console.error('Usage: node migrate-storage.mjs <manifest.json> <bucket_name>');
  process.exit(1);
}

const source = createClient(sourceUrl, sourceKey);
const target = createClient(targetUrl, targetKey);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const files = manifest.files || [];

console.log(`Migrating ${files.length} files to bucket "${bucketName}"...`);

let success = 0;
let failed = 0;

for (const file of files) {
  try {
    const { data, error: dlError } = await source.storage
      .from(bucketName)
      .download(file.path);

    if (dlError || !data) {
      console.error(`  SKIP ${file.path}: ${dlError?.message || 'no data'}`);
      failed++;
      continue;
    }

    const { error: upError } = await target.storage
      .from(bucketName)
      .upload(file.path, data, { upsert: true, contentType: data.type });

    if (upError) {
      console.error(`  FAIL ${file.path}: ${upError.message}`);
      failed++;
    } else {
      success++;
      if (success % 50 === 0) console.log(`  Progress: ${success}/${files.length}`);
    }
  } catch (e) {
    console.error(`  ERROR ${file.path}: ${e.message}`);
    failed++;
  }
}

console.log(`\nDone! ${success} migrated, ${failed} failed out of ${files.length} total.`);
```

### Run it

```bash
npm install @supabase/supabase-js

export SOURCE_SUPABASE_URL="https://OLD_PROJECT.supabase.co"
export SOURCE_SERVICE_KEY="your-old-service-role-key"
export TARGET_SUPABASE_URL="https://NEW_PROJECT.supabase.co"
export TARGET_SERVICE_KEY="your-new-service-role-key"

node migrate-storage.mjs audio_manifest.json audio
node migrate-storage.mjs scene-images_manifest.json scene-images
node migrate-storage.mjs audio-files_manifest.json audio-files
node migrate-storage.mjs scene-videos_manifest.json scene-videos
node migrate-storage.mjs project-thumbnails_manifest.json project-thumbnails
node migrate-storage.mjs videos_manifest.json videos
node migrate-storage.mjs voice_samples_manifest.json voice_samples
node migrate-storage.mjs source_uploads_manifest.json source_uploads
```

---

## Step 5 — Verify

Run this SQL in the **target** project's SQL editor:

```sql
SELECT bucket_id, count(*)
FROM storage.objects
GROUP BY bucket_id
ORDER BY count DESC;
```

Compare counts against the `?action=list` output from Step 2.

---

## ⚠️ Important Notes

1. **Signed URLs in DB records** still point to the old project after migration.  
   The `get-shared-project` edge function's URL-refresh logic automatically generates new signed URLs for the target project at read time.

2. **Public bucket URLs** (`scene-images`, `audio-files`, etc.) will have new domains on the target.  
   Database rows referencing old public URLs need updating — the signed-URL refresh in edge functions handles this for scene data.

3. **The `audio` bucket** is private; all access is via signed URLs that the edge functions refresh automatically.

4. **Large files** (videos, exported clips) may time out during download/upload.  
   For `videos` and `scene-videos`, consider running the script in smaller batches or setting `NODE_OPTIONS="--max-http-header-size=80000"`.

5. **Manifest URLs expire in 7 days.** Run the migration script within that window after generating manifests.

---

## Proxy Download (single file)

For debugging or spot-checking, the edge function can proxy-download individual files:

```javascript
const res = await fetch(
  `https://<SOURCE_REF>.supabase.co/functions/v1/migrate-storage?action=download&bucket=audio&path=${encodeURIComponent('user-id/file.mp3')}`,
  { headers }
);
const blob = await res.blob();
```
