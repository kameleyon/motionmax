
# Fix: Hypereal 429 Rate Limit Persisting Despite Backoff

## Problem

Even with concurrency=1 and 15s backoff, every single Hypereal poll returns 429. The generation has 17 scenes with 11 still missing videos. Hypereal's rate limit appears to be very strict -- even 1 request per 15 seconds triggers it when you have many active jobs on the account.

The videos are likely **already completed** on Hypereal's side, but we cannot retrieve them because every status check is rejected.

## Root Cause

The 15-second backoff is per-scene. But the frontend processes scenes sequentially and each scene attempt triggers a new edge function call to Hypereal. With 11 scenes to poll, even with 15s delays, the effective request rate is too high for Hypereal's account-level rate limit.

## Solution: Aggressive Global Cooldown on 429

### Change 1: Backend - Increase cooldown and add jitter on 429

**File: `supabase/functions/generate-cinematic/index.ts`**

- When `resolveHyperealVideo` returns `RATE_LIMITED`, respond with `retryAfterMs: 30000` (30 seconds) instead of 15s
- This gives Hypereal's rate limit window more time to reset between polls

### Change 2: Frontend - Add global 429 cooldown across scenes

**File: `src/hooks/generation/cinematicPipeline.ts`**

Currently, when scene N gets a 429 and waits 15s, the frontend immediately tries scene N again. If that scene completes (or gives up), it moves to scene N+1 -- which also gets 429'd immediately.

The fix: after ANY 429 response, add an **extra cooldown before the next poll** regardless of which scene it's for. This means:

- Track a `lastRateLimitTime` timestamp in the polling loop
- Before each poll, check if we're within a 30s cooldown window from the last 429
- If so, wait until the cooldown expires before polling

### Change 3: Frontend - Skip already-completed scenes in retry loop

In `runCinematicVideo`, the retry rounds re-check scenes from the DB. But the main polling loop (lines 199-204) processes ALL scenes sequentially even if some already have `videoUrl`. The loop should check the DB for existing videoUrl before starting the poll for each scene.

Add a pre-check in `generateVideoForScene`: before starting the poll loop, fetch the latest scene data from DB. If `videoUrl` already exists, skip immediately.

## Summary of Changes

| File | Change |
|------|--------|
| `supabase/functions/generate-cinematic/index.ts` | Increase 429 `retryAfterMs` from 15s to 30s |
| `src/hooks/generation/cinematicPipeline.ts` | Add global cooldown tracking; skip scenes with existing videoUrl; increase retry sleep |

## Technical Details

### `supabase/functions/generate-cinematic/index.ts`

**Line 1839 (RATE_LIMITED handler):**
```
retryAfterMs: 15000  -->  retryAfterMs: 30000
```

**Line 1834 (SEEDANCE_TIMEOUT_RETRY handler):**
```
retryAfterMs: 15000  -->  retryAfterMs: 30000
```

### `src/hooks/generation/cinematicPipeline.ts`

**`generateVideoForScene` function (line 159):**
Add a DB pre-check at the start:
```
// Check if this scene already has a video (completed on backend while we were polling others)
const { data: checkGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
const checkScenes = normalizeScenes(checkGen?.scenes) ?? [];
if (checkScenes[sceneIdx]?.videoUrl) {
  completedVideos++;
  // update progress...
  return;
}
```

**Polling loop (line 183-184):**
When a 429-based `retryAfterMs` comes back (>= 20000), add extra logging and ensure the full duration is respected:
```
const waitMs = vidRes.retryAfterMs || 8000;
console.log(LOG, `Scene ${sceneIdx+1}: waiting ${waitMs/1000}s before next poll`);
await sleep(waitMs);
```

**Both initial and resume paths** get identical changes for consistency.
