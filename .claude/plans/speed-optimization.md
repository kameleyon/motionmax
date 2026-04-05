# Speed Optimization Plan — Full Generation Pipeline

## Current Reality (after reading EVERYTHING)

### Cinematic Pipeline (the one that matters most for 150s videos)
```
Phase                    Time          Details
──────────────────────── ───────────── ──────────────────────────────────
1. Script (LLM)          ~10-30s       OpenRouter call
2. Audio+Images PARALLEL  ~3-8 min     Already parallel! (cinematicPipeline.ts L83-85)
   ├─ Audio (Qwen3 TTS)   ~1-3 min    5 scenes per batch via Replicate
   └─ Images (Hypereal)   ~2-5 min    All fired in parallel, + retry round
3. Video (Kling I2V)     ~15-30 min   THE KILLER — batches of 4, each polls 20s×40 attempts
4. Finalize              ~5s           DB writes
5. Export (FFmpeg)        ~2-8 min     Concat + mux (no Ken Burns for cinematic)
──────────────────────── ───────────── ──────────────────────────────────
TOTAL                    ~25-45 min
```

### Standard Pipeline (doc2video/storytelling)
```
Phase                    Time          Details
──────────────────────── ───────────── ──────────────────────────────────
1. Script (LLM)          ~10-30s       OpenRouter call
2. Audio+Images           ~5-10 min    NOW parallel (user already patched standardPipeline.ts)
   ├─ Audio (TTS)          ~2-5 min   Batches of 3
   └─ Images (Hypereal)    ~3-8 min   Batches of 9 + 2 retry rounds
3. Finalize              ~5s           DB writes
4. Export (FFmpeg)        ~3-15 min    Ken Burns disabled, just mux+concat
──────────────────────── ───────────── ──────────────────────────────────
TOTAL                    ~10-25 min
```

### Where the actual time is burned

**For Cinematic (the 41-min case): Kling video generation is ~70% of total time**
- 15 scenes × 10s each = 150s video
- Each scene: Kling I2V takes 2-8 minutes to generate (async API, polling every 20s)
- Batches of 4 scenes at a time (VIDEO_BATCH_SIZE = 4 in cinematicPipeline.ts L141)
- 15 scenes / 4 per batch = 4 batches × ~5 min each = ~20 min just waiting for Kling
- PLUS: scenes with `end_image` (transitions) wait up to 5 min for next scene's image
- PLUS: 1 retry round for failed videos (sequential, not batched)

**For Standard: Export FFmpeg mux is the bottleneck**
- But Ken Burns is ALREADY disabled (exportVideo.ts L193-196)
- Export is just: download files → mux video+audio per scene → concat → upload
- This is mostly I/O bound (downloading from Supabase Storage)

---

## The Plan

### Change 1: Increase Cinematic Video Batch Size (5 min → saves ~10-15 min)
**File**: `src/hooks/generation/cinematicPipeline.ts`

The `VIDEO_BATCH_SIZE = 4` is the primary throttle. Since Kling jobs are remote API calls
(not local CPU/memory), we can safely increase this. The only constraint is Hypereal API
rate limits.

**Action**:
- Increase `VIDEO_BATCH_SIZE` from 4 to **8** (or even all scenes at once if rate limits allow)
- This cuts the number of sequential batches in half
- 15 scenes / 8 per batch = 2 batches instead of 4

### Change 2: Fire Videos As Soon As Each Image Is Ready (save ~3-5 min)
**File**: `src/hooks/generation/cinematicPipeline.ts`

Currently the pipeline is: ALL images first → THEN all videos (two-phase sequential).
But videos only need their own image + next scene's image. We're waiting for ALL images
before starting ANY video.

**Action**:
- Restructure `runCinematicVisuals()` to start video generation per scene as soon as
  that scene's image (and next scene's image) are available
- Use a "streaming" approach: image completes → immediately queue video for that scene
- The worker-side `handleCinematicVideo` already has polling logic to wait for next
  scene's image (L136-174), so the infrastructure exists

### Change 3: Parallelize Video Retry Round (save ~2-5 min)
**File**: `src/hooks/generation/cinematicPipeline.ts`

Currently at L228, missing video retries are SEQUENTIAL (`for...of` loop with `await`).
Since these are independent API calls, they should be parallel.

**Action**:
- Change the retry loop to use `Promise.allSettled()` instead of sequential `for...of`

### Change 4: Collapse Standard Pipeline Queue Overhead (save ~1-2 min)
**File**: `worker/src/handlers/` + `worker/src/index.ts`

Each phase transition (script → audio → images → finalize) goes through:
1. Frontend inserts job row
2. Worker polls every 2s and claims it
3. Worker executes
4. Frontend polls every 2s and sees completion
5. Frontend inserts next job

That's ~4-6s of dead time per transition × 4 transitions = ~20s. Not huge, but it
adds up when combined with DB round-trips.

**Action**:
- Create a new worker task type `generate_full` that runs script → parallel(audio, images) → finalize
  in a single job, eliminating inter-phase queue overhead
- Frontend dispatches ONE job, polls ONE job
- Keep existing per-phase jobs for resume/retry capability

### Change 5: Speed Up Export for Cinematic (save ~2-5 min)
**File**: `worker/src/handlers/exportVideo.ts` + `worker/src/handlers/export/sceneEncoder.ts`

For cinematic, export does: download each scene's video+audio → mux → concat → compress → upload.
Ken Burns is already disabled. The bottleneck is sequential muxing.

**Action**:
- `SCENE_BATCH_SIZE` is already 3 (env default). Verify this is used for cinematic exports
- For cinematic scenes that already have `videoUrl` + `audioUrl`, the mux step (sceneEncoder.ts L319-368)
  uses `-preset fast` — change to `-preset ultrafast` for cinematic mux
- Skip compression step if total file size is reasonable (most cinematic exports are already
  well-compressed since Kling outputs optimized MP4s)

### Change 6: Reduce Hypereal Polling Interval (save ~1-3 min cumulative)
**File**: `worker/src/services/hypereal.ts`

Current polling: 20s base interval with ±25% jitter, up to 40 attempts.
Most Kling jobs complete in 2-4 minutes. With 20s polling, you might wait up to 19 extra
seconds per scene after it's actually done.

**Action**:
- Use adaptive polling: start at 10s for first 6 polls (2 min), then 20s after
- Reduce `maxAttempts` from 40 to 30 (10 min max is plenty — Kling rarely takes >5 min)

---

## Expected Impact

| Change | Cinematic (41 min) | Standard (20 min) |
|--------|-------------------|-------------------|
| 1. Bigger video batches | -10 min | N/A |
| 2. Stream images→videos | -3 min | N/A |
| 3. Parallel video retries | -3 min | N/A |
| 4. Single-job pipeline | -1 min | -1 min |
| 5. Faster export mux | -2 min | -2 min |
| 6. Faster polling | -2 min | N/A |
| **TOTAL SAVINGS** | **~20 min (→ ~20 min)** | **~3 min (→ ~17 min)** |

For standard pipeline, the remaining time is dominated by external API latency (image
generation, TTS) which we can't control. For cinematic, we can potentially get under
20 minutes by maximizing parallelism of the Kling video generation step.

---

## Files to modify

1. `src/hooks/generation/cinematicPipeline.ts` — Changes 1, 2, 3
2. `worker/src/services/hypereal.ts` — Change 6
3. `worker/src/handlers/exportVideo.ts` — Change 5
4. `worker/src/handlers/export/sceneEncoder.ts` — Change 5 (preset tweak)
5. `worker/src/index.ts` — Change 4 (new task type routing)
6. `worker/src/handlers/generateFull.ts` — Change 4 (NEW file, single-job orchestrator)
7. `src/hooks/generation/callPhase.ts` — Change 4 (new phase dispatch)
8. `src/hooks/generation/standardPipeline.ts` — Change 4 (use single job)
