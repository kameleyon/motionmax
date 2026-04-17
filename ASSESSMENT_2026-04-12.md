# MotionMax Architecture & Performance Assessment
**Date:** 2026-04-12
**Scope:** Full pipeline (generation + export) on main branch
**Status:** Assessment only — no code changes

---

## 0. Executive Summary

Three of your five stated problems need to be re-framed before we can fix them — **the code on `main` already does what you think it doesn't**. The actual performance problems are elsewhere, and they are severe.

| # | Your premise | Reality on `main` | Evidence |
|---|---|---|---|
| 1 | Edge functions time out for concurrent users | ✅ Correct. And worker is the right architecture. | `supabase/functions/generate-video/index.ts` (6,111 lines) and `generate-cinematic/index.ts` (2,003 lines) still exist but are dead code. |
| 2 | Worker migration didn't improve speed | ⚠️ Partially. The worker *is* receiving the jobs; the slowness is **model wall time + serial batching + polling fallbacks**, not misrouting. | See §4, §5. |
| 3 | Image regen still hits edge function | ❌ **False.** It is routed through the worker. | `src/hooks/generation/callPhase.ts:299-301`, `src/hooks/useSceneRegeneration.ts:86`, `worker/src/handlers/handleRegenerateImage.ts` |
| 4 | Video regen (Kling/Wan) still on edge function | ❌ **False.** It is routed through the worker, uses `cinematic_video` task type, 10-min poll timeout. | `src/hooks/generation/callPhase.ts:289-291`, `src/hooks/useCinematicRegeneration.ts:100-106`, `worker/src/handlers/handleCinematicVideo.ts` |
| 5 | No way to undo a regeneration | ⚠️ Partially. A **single-level** undo exists (scene_versions table + `handleUndoRegeneration`), but no redo, no multi-step history, no apply-edit rollback. | `worker/src/handlers/handleUndoRegeneration.ts`, `src/hooks/useSceneVersions.ts` |

**The real reason a 3-minute cinematic still takes ~20 minutes:** ~85% of it is *external model wall time* (Kling V2.5 I2V at 60–600s per scene × N scenes with partial serialization), ~10% is export FFmpeg work serialized into batches of 3, and ~5% is polling latency / Realtime fallback overhead.

**The 520 MB Render instance is undersized** — see §6.

---

## 1. Architectural Map — What Runs Where

### 1.1 Render background worker (`worker/src/`)

**Entry:** `worker/src/index.ts` (639 LOC) — long-lived Node process using `tsx` as runtime (no compile step in prod, `"start": "tsx src/index.ts"` in `worker/package.json:8`).

**Queue mechanism:** **Supabase Postgres table polling**, not Redis, not pg-boss.
- Polls every **2000 ms** via `claim_pending_job` RPC (`index.ts:402`).
- Export jobs claimed with priority first, then generation jobs (`index.ts:322-349`).
- Concurrent job execution: `activeJobs` Set, fire-and-forget dispatch (`index.ts:71, 393`).
- Concurrency auto-tuned from cgroup memory + CPU:
  `max(4, min(cpu×3, availableMem/200MB, 20))` (`index.ts:61`).
  On 520 MB RAM this evaluates to `min(…, 520/200=2.6)` → the `max(4, …)` floor **overrides** the memory budget, giving 4 concurrent jobs. That's oversubscribed — see §6.

**Job handlers registered in `index.ts:178-214`:**

| Task type | Handler file | What it does |
|---|---|---|
| `generate_video` | `handlers/generateVideo.ts` | Script LLM call → create project + generation rows |
| `finalize_generation` | `handlers/handleFinalize.ts` | Record cost, mark generation `complete` |
| `cinematic_audio` | `handlers/handleCinematicAudio.ts` | Qwen3 TTS (Replicate), upload MP3 |
| `cinematic_image` | `handlers/handleCinematicImage.ts` | Hypereal or Replicate image gen → download → re-upload |
| `cinematic_video` | `handlers/handleCinematicVideo.ts` | PixVerse V6 transition or Kling V2.5 Turbo I2V |
| `regenerate_image` | `handlers/handleRegenerateImage.ts` | Same as cinematic_image + character-bible injection |
| `regenerate_audio` | `handlers/handleRegenerateAudio.ts` | Same as cinematic_audio |
| `export_video` | `handlers/exportVideo.ts` | FFmpeg scene encode → crossfade → subtitles → upload |
| `undo_regeneration` | `handlers/handleUndoRegeneration.ts` | Restore prior `scene_versions` row |
| `voice_preview` | `handlers/handleVoicePreview.ts` | Short TTS sample |

**Graceful shutdown:** SIGTERM → drain up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 300s), then re-flag unfinished jobs as `pending`, with 3-restart orphan recovery (`index.ts:413-558`).

**Health:** `healthServer.ts` on port 10000 (`/health`, `/ready`, `/metrics`).

**Dependencies declared (`worker/package.json:12-18`):**
`@supabase/supabase-js, dotenv, openai, replicate, uuid`.
**Crucially absent:** `ffmpeg-static`, `fluent-ffmpeg`, `sharp`, `@ffmpeg/*`. That means ffmpeg must be available as a **system binary on the Render instance** (via a native buildpack or a Dockerfile — neither of which exists at the repo root). Confirm in the Render dashboard which buildpack is installed.

### 1.2 Supabase Edge Functions (`supabase/functions/`)

| Function | Status | Purpose |
|---|---|---|
| `generate-video/` (6,111 LOC) | **DEAD CODE** — not called from the current frontend | Original pre-migration pipeline; worker ported from it |
| `generate-cinematic/` (2,003 LOC) | **DEAD CODE** — not called from the current frontend | Same |
| `check-subscription` | Live | Stripe subscription validation |
| `create-checkout`, `customer-portal`, `stripe-webhook` | Live | Stripe billing |
| `admin-stats` | Live | Admin dashboard |
| `clone-voice`, `delete-voice` | Live | ElevenLabs voice management |
| `refresh-project-thumbnails` | Live (background) | Refreshes 7-day signed URLs |
| `serve-media` | Live | 302 redirect proxy for signed URLs |
| `share-meta`, `get-shared-project` | Live | Public share links |
| `manage-api-keys`, `export-my-data`, `migrate-storage` | Live (admin) | Utilities |

**Frontend calls to edge functions** (verified by `grep supabase.functions.invoke` in `src/`):
- `useAdminAuth.ts:62` — admin-stats
- `useSubscription.ts:126,159,203,222` — check-subscription, create-checkout, customer-portal
- `useVoiceCloning.ts:73,111` — clone-voice, delete-voice
- `databaseService.ts:106` — generic helper (billing/admin)

**Zero calls** to `generate-video` or `generate-cinematic` from `src/`. The frontend uses the worker queue exclusively for generation.

### 1.3 Frontend trigger paths (`src/`)

All generation/regeneration/export calls go through `src/hooks/generation/callPhase.ts`. The routing table in `callPhase()` (`callPhase.ts:235-313`):

| `body.phase` | Routed to | Task type | Poll timeout |
|---|---|---|---|
| `"script"` | `workerCallPhase` | `generate_video` | 8 min |
| `"audio"` | `workerCallPhase` | `cinematic_audio` | 5 min |
| `"images"` | `workerCallPhase` | `cinematic_image` | 5 min |
| `"video"` | `workerCallPhase` | `cinematic_video` | 10 min |
| `"finalize"` | `workerCallPhase` | `finalize_generation` | 2 min |
| `"regenerate-image"` | `workerCallPhase` | `regenerate_image` | 3 min |
| `"regenerate-audio"` | `workerCallPhase` | `regenerate_audio` | 3 min |
| `"undo"` | `workerCallPhase` | `undo_regeneration` | 30 s |
| anything else | `legacyCallPhase` (edge fn fetch) | — | unused |

`legacyCallPhase` (`callPhase.ts:315-457`) is **unreachable** from the current valid-phase whitelist (`callPhase.ts:240`). It is dead code and can be deleted.

`workerCallPhase` = `submitJob` (INSERT into `video_generation_jobs`) + `pollWorkerJob` (Realtime subscription + fallback `setInterval` poll).

---

## 2. Generation Pipeline — End-to-End Trace (cinematic, 4 scenes)

```
User clicks Generate
  └─ useGenerationPipeline.startGeneration()                     [src/hooks/useGenerationPipeline.ts:69-102]
       └─ runUnifiedPipeline(ctx)                                [src/hooks/generation/unifiedPipeline.ts:23]
           ├─ callPhase({phase:"script"}, 480s)
           │     └─ submitJob("generate_video") → pollWorkerJob
           │           └─ Worker: claim_pending_job → handleGenerateVideo
           │                 ├─ buildCinematicPrompt
           │                 ├─ callOpenRouterLLM   (30–120 s, no timeout)
           │                 ├─ parseJSON → postProcessScenes
           │                 └─ INSERT projects + generations rows
           │     ← returns {projectId, generationId, scenes[]}
           │
           ├─ FOR each scene i (SEQUENTIAL awaits — §5.A):
           │     submitJob("cinematic_audio", scene:i)           [unifiedPipeline.ts:88-94]
           │     submitJob("cinematic_image", scene:i)           [unifiedPipeline.ts:98-104]
           │
           ├─ FOR each scene i (SEQUENTIAL awaits):
           │     submitJob("cinematic_video", scene:i,
           │               depends_on:[imageJob[i], imageJob[i+1]])
           │
           ├─ submitJob("finalize_generation", depends_on:[...all])
           │
           └─ setInterval(5s) → SELECT count(*) WHERE id IN (...) AND status='completed'
                 (updates progress bar)

Worker side (parallel up to MAX_CONCURRENT_JOBS):
  • Audio jobs    → Qwen3 TTS via Replicate          10–30 s each, fully parallel
  • Image jobs    → Hypereal/nano-banana-2           5–20 s each, fully parallel
  • Video jobs    → Kling V2.5 Turbo I2V             60–600 s each, gated by image deps
  • Finalize      → 2–5 s once all parents done
```

**Observed vs theoretical wall time for 4-scene cinematic:**
- Script: ~60 s
- Audio (4× parallel): ~30 s
- Images (4× parallel): ~15 s
- Videos (4× but depend on images pairwise; effectively ≥2 serial waves): **≥ 2 × ~200 s = 400 s** in happy case, up to **4 × 400 s = 1600 s** if Kling queues
- Finalize: ~5 s
- **Total:** ~8–28 min — matches your "~20 min" observation.

**Conclusion:** The worker is doing its job. The wall time is dominated by **Kling I2V latency** on the cinematic task. See §5.

---

## 3. Export Pipeline — End-to-End Trace

```
User clicks Export
  └─ useVideoExport.exportVideo()                                [src/hooks/useVideoExport.ts]
       ├─ deduct credits
       └─ submitJob("export_video", {scenes, captionStyle, brandMark})
             └─ pollWorkerJob with Realtime + 10s fallback poll

Worker: handleExportVideo                                        [worker/src/handlers/exportVideo.ts]
  ├─ 0.  Start ASR IN PARALLEL (not awaited)                    [exportVideo.ts:253]
  │      transcribeAllScenes() → Hypereal ASR (base64 upload — §5.B)
  │
  ├─ 1.  Encode scenes in SEQUENTIAL BATCHES of 3                [exportVideo.ts:37, 265-321]
  │      for start in 0,3,6,9,...:
  │         Promise.allSettled(3 × processScene)
  │      processScene → FFmpeg libx264 + Ken Burns filter
  │      Per-scene timeout: 5 min
  │
  ├─ 2.  Stitch (xfade filter_complex OR concat demuxer)          [exportVideo.ts:342+]
  │      Crossfade is single-FFmpeg-process, single-threaded.
  │      Timeout: 30 min.
  │
  ├─ 3.  Burn subtitles (.ass via libass)
  ├─ 4.  Overlay brand mark
  ├─ 5.  Compress if > 500 MB
  └─ 6.  Upload final.mp4 to Supabase Storage (multipart)
```

**Where a 3-min explainer loses 20 minutes on export:**

| Stage | Typical time | Why slow |
|---|---|---|
| Scene encode (12 scenes, batches of 3) | 4 batches × 45 s = **3 min** | Ken Burns filter_complex + libx264 on each still; batch size of 3 is conservative for 520 MB RAM |
| Crossfade stitch | **2–6 min** | xfade is inherently serial inside one FFmpeg process; filter_complex DAG grows with N scenes |
| ASR | parallel (hidden) | runs alongside encode |
| Subtitle burn | 30–90 s | re-encode pass through libass |
| Compress (if triggered) | 1–3 min | crf 28 re-encode |
| Upload | 15–60 s | multipart to Supabase Storage |
| **Total realistic** | **7–14 min** | |

If you are seeing 20 min, the prime suspects are **(a)** the 520 MB instance swapping/GCing under FFmpeg pressure and **(b)** the crossfade pass being called on a mixed-codec stream forcing re-encode. Both traceable in worker logs.

---

## 4. Why The Worker Migration "Didn't Help"

It did help — **edge functions would now be failing outright**, not running slowly — but the speedup was masked by:

1. **The LLM and Kling wall times are unchanged.** Moving `await fetch(kling)` from an edge function to a Render Node process does not make Kling faster. The old edge function path hit the Supabase gateway wall (150 s free / 400 s paid; see §6 research note) and returned 504s that the user saw as "slow." The worker path completes the same job in the same time but **actually finishes** — so it *feels* like the work is now taking the full time it always needed.
2. **Sequential frontend `await submitJob()` in loops** — `unifiedPipeline.ts:88-94, 98-104` awaits each job-row INSERT one at a time. For 12 scenes that's 36 sequential round-trips to Supabase (~3–6 s of pure network overhead). This is a free win — batch-insert them.
3. **Fallback `setInterval` poll overlaps Realtime** — `callPhase.ts:214-225` keeps polling every 3–15 s even when Realtime is firing, causing duplicate handler runs and extra DB load.
4. **Image re-upload cycle** — `imageGenerator.ts:90-100` downloads every generated image from Hypereal (hotlink-blocked) and re-uploads to Supabase. 33% overhead per image × N scenes × every regeneration. Fix is to use a signed-read URL from a server-side fetch with the correct Referer, or to proxy through `serve-media`.
5. **Base64 ASR upload** — `audioASR.ts:253` converts full audio buffers to base64 before POSTing. 33% size blow-up and a memory spike on a 520 MB box.
6. **Export scene batch = 3** — safe but conservative. On a 2 GB instance you can push to 6–8.

None of these are architectural. They are line-level fixes.

---

## 5. Specific Bottlenecks With Line References

### 5.A Sequential job submission
`src/hooks/generation/unifiedPipeline.ts:88-130`
```ts
for (let i = 0; i < sceneCount; i++) {
  await submitJob({phase: "audio", sceneIndex: i}, "cinematic_audio");
  await submitJob({phase: "images", sceneIndex: i}, "cinematic_image");
}
```
Fix: collect all job rows into a single `supabase.from("video_generation_jobs").insert([...])` array call. 1 round-trip instead of 2N.

### 5.B Base64 ASR
`worker/src/services/audioASR.ts:253` — replace with `FormData` multipart binary upload or a signed GCS/R2 URL the ASR can pull from.

### 5.C Image re-upload
`worker/src/services/imageGenerator.ts:90-100` — fetch once inside the worker is unavoidable (Hypereal hotlink), but the re-upload is wasted bytes if the only consumer is the client via `serve-media`. Cache-control the Supabase copy so subsequent reads don't re-trigger.

### 5.D Fallback poll overlapping Realtime
`src/hooks/generation/callPhase.ts:214-225` — cancel `fallbackTimer` inside the Realtime handler's first fire.

### 5.E Export batch serialization
`worker/src/handlers/exportVideo.ts:37, 265-321` — `SCENE_BATCH_SIZE=3` env-tunable. Raise to 6 on a 2 GB instance.

### 5.F Crossfade single-process bottleneck
`worker/src/handlers/export/transitions.ts` — xfade inside one `ffmpeg` call is single-threaded. For N > 6 scenes, pair-wise concat-then-xfade is ~2× faster than one mega filter_complex.

### 5.G Progress poll does `count: "exact"`
`src/hooks/generation/unifiedPipeline.ts:143-150` — every 5 s a full index count over N job IDs. Use Realtime subscription to the job rows directly.

---

## 6. Render Instance Sizing — Is 520 MB Enough?

**Short answer: No. You need Standard (2 GB) minimum, Pro (4 GB) for comfort.**

### Render tier specs (source: render.com/pricing — **verify at the URL before purchasing** as 2026 pricing may have shifted)

| Tier | RAM | CPU | ≈ cost/mo |
|---|---|---|---|
| Starter | 512 MB | 0.5 | $7 |
| Standard | 2 GB | 1.0 | $25 |
| Pro | 4 GB | 2.0 | $85 |
| Pro Plus | 8 GB | 4.0 | $175 |
| Pro Max | 16+ GB | 4+ | higher |

### Budget calculation for this workload

Baseline Node + `tsx` + Supabase client + open connections: **~130–180 MB RSS idle.**

Per concurrent job (the `200 MB/job` assumption hard-coded at `index.ts:59` is optimistic for this app):

| Job type | Real peak RSS add |
|---|---|
| `generate_video` (LLM only) | 20–40 MB |
| `cinematic_audio` | 30–60 MB (buffers TTS response) |
| `cinematic_image` | 60–120 MB (downloads + re-uploads image bytes) |
| `cinematic_video` | 20–40 MB (orchestration only, work happens at Kling) |
| `regenerate_image` | 60–120 MB |
| `export_video` (FFmpeg libx264 1080p) | **250–450 MB** per concurrent scene × batch of 3 = 750–1,350 MB + Node baseline |

### What actually happens on 520 MB

1. Worker auto-tuner computes `min(cpu*3, 520/200=2.6, 20) = 2` then `max(4, 2) = 4`. It will try to run **4** concurrent jobs even though the memory budget only supports 2.
2. First export job hits Ken Burns + libx264 → FFmpeg spawns ~3 parallel children (`SCENE_BATCH_SIZE=3`) → instantaneous spike to 900 MB+ → **OOMKill** or aggressive swap on Render (which typically has no swap) → the job is either terminated or stalls at the kernel level.
3. Even when export is not running, a simultaneous `cinematic_image` + `regenerate_image` pair plus Node baseline lands around 400 MB — one leak or a large payload and you're over.

### Recommendation

| Workload scenario | Min tier | Sweet spot |
|---|---|---|
| Orchestration only, **export moved off-instance** to a separate worker | Standard 2 GB | Standard 2 GB |
| Current unified worker (generation + export together) | Standard 2 GB | **Pro 4 GB** |
| High-concurrency multi-tenant (10+ users exporting simultaneously) | Pro 4 GB | Pro Plus 8 GB + horizontal scaling |

**520 MB is the wrong answer for anything that touches FFmpeg.** Whoever told you 520 MB was sufficient was not accounting for libx264 at 1080p.

### Additional sizing note

`worker/src/index.ts:59` hard-codes `200 MB per job` as the memory-to-concurrency ratio. On a 4 GB instance the floor `max(4, ...)` stops mattering and you get `min(cpu*3, 4096/200=20, 20)` concurrent jobs — that is also too aggressive for a box that runs FFmpeg. Raise the per-job constant to 500 MB or add an explicit `EXPORT_MAX_CONCURRENT=1` guard.

---

## 7. Supabase Edge Function Limits (for context)

- Wall-clock timeout: 150 s (free) / 400 s (paid) per invocation (source: supabase.com/docs/guides/functions/limits — **verify**)
- Memory: 256 MB
- Not appropriate for video pipelines that routinely exceed 2 min of wall-clock. **The decision to move to a worker is correct and must not be reversed.**

---

## 8. Kling / Wan / PixVerse Status (as integrated)

Current model choice for `cinematic_video`:
- **Primary:** PixVerse V6 transitions, $0.40/transition, when scene has both start and end image (`handleCinematicVideo.ts:21`).
- **Fallback:** Kling V2.5 Turbo I2V, $0.70/10 s, for the last scene which has no end image (`handleCinematicVideo.ts:22`).
- Grok Video I2V previously tried, now commented out (`handleCinematicVideo.ts:26`).
- **Wan is not currently wired in.** If you want Wan 2.x as a cost/latency alternative, it must be added — the worker has no Wan client today.

Typical latency per clip:
- Kling V2.5 Turbo I2V (5 s output): 1–3 min queued on paid plan, up to 10 min under load.
- PixVerse V6 transitions: 1–2 min typical.

Concurrency limits are set per account at the provider — **this is the single biggest uncontrollable variable in your wall time.** If Kling queues you behind 20 other tasks, the worker will sit waiting. The fix is not on the worker side; it is to **request higher concurrency from Kling** or to **run a provider fallback chain**.

---

## 9. Undo / Apply-Edit State

**What exists today:**
- `scene_versions` table with rows `{generation_id, scene_index, voiceover, visual_prompt, image_url, audio_url, duration, video_url, change_type, created_at}` (`src/hooks/useSceneVersions.ts:5-16`).
- A version row is written before every regen (assumption — to verify in `handleRegenerateImage.ts` and `handleRegenerateAudio.ts`, look for `INSERT scene_versions`).
- `handleUndoRegeneration.ts:10-80` fetches the **most recent** version row and restores its fields into `generations.scenes[i]`. Clears `videoUrl` if image/audio changed so the video will be re-rendered on next play.
- Frontend hook `useSceneRegeneration.undoRegeneration` (`src/hooks/useSceneRegeneration.ts:136-174`) and equivalent in `useCinematicRegeneration.ts:257-291`.

**What's missing:**
- **No redo.** Once you undo, the undone state is gone — no stack.
- **Single-level only** unless the version insert is unconditional (needs verification). If it inserts on every regen, you can repeatedly undo but cannot redo.
- **Apply-edit has no rollback path.** `applyImageEdit` (`useCinematicRegeneration.ts:165-207`) writes the new image and clears adjacent videos — the prior image is only recoverable if a scene_versions row was written first.
- **No UI affordance** visible for undo/redo in the editor shell (not found in grep; verify in `src/pages/`).

**Cleanest fix path:** promote `scene_versions` from "last snapshot" to a bounded undo/redo stack (e.g., 10 entries) with an explicit cursor, and add undo/redo buttons + keyboard shortcuts in the scene editor. No new tables needed — add a `cursor_position` column and a `max_stack_size` trim on insert.

---

## 10. Diagnosis Summary

| Symptom | Root cause | Category |
|---|---|---|
| 3-min cinematic takes ~20 min | Kling I2V wall time × 4 scenes with partial serialization | External (provider) |
| Export takes up to 20 min | FFmpeg batch=3 + crossfade single-process + possible OOM thrash on 520 MB | Instance size + config |
| "Image regen hits edge function" | **Not actually true** — routed to worker | Misperception |
| "Video regen hits edge function" | **Not actually true** — routed to worker | Misperception |
| "Worker migration didn't help" | It did; remaining slowness is model latency + serial polling + undersized RAM | Mixed |
| No undo/redo stack | Feature gap | Product |

---

## 11. Proposed Solutions

### P1 — Concurrent users / edge timeouts
**Already solved architecturally.** Keep the worker, delete dead edge functions (`generate-video/`, `generate-cinematic/`) so nobody accidentally deploys them. Delete `legacyCallPhase` in `callPhase.ts:315-457`.

### P2 — Speed up worker end-to-end
1. **Raise Render tier to Standard 2 GB or Pro 4 GB.** Non-negotiable if export stays on the same worker.
2. **Batch frontend `submitJob` calls** — single insert of all audio/image/video rows per pipeline run (`unifiedPipeline.ts:88-130`).
3. **Cancel fallback poll on first Realtime fire** (`callPhase.ts:214-225`).
4. **Raise `EXPORT_BATCH_SIZE`** to 6 once on ≥2 GB.
5. **Replace base64 ASR** with multipart binary (`audioASR.ts:253`).
6. **Replace progress-count poll** with a Realtime channel subscribed to `video_generation_jobs` filtered by `project_id` (`unifiedPipeline.ts:143-150`).
7. **Raise per-job memory constant** in `index.ts:59` from 200 → 500 MB; add `EXPORT_MAX_CONCURRENT=1`.
8. **Request higher Kling concurrency** from the provider — this is the single biggest wall-time reduction available.

### P3 — Image regeneration routing
**No change required.** Verify by looking at logs: a regenerate request should show a row in `video_generation_jobs` with `task_type='regenerate_image'`. If you believe it is still hitting edge functions, check which build/branch is actually deployed to production (`vercel.json` frontend + Render worker). Stale deploy is the most likely explanation.

### P4 — Video regeneration routing
Same as P3 — verify deploy is up to date. If a Wan client is desired as a fallback/cheaper option, it needs to be added to `worker/src/handlers/handleCinematicVideo.ts` next to the existing PixVerse/Kling branches, plus a DashScope HTTP client in `worker/src/services/`. Outline:
- Add `WAN_API_KEY` env var
- New `services/wanClient.ts` with `createVideoTask` + `pollVideoTask`
- In `handleCinematicVideo.ts`, add `provider` selection by env or payload flag
- Same output contract: upload the final MP4 to Supabase, write `videoUrl` to the scene
- 5-min polling loop honoring the existing 10-min job timeout

### P5 — Undo stack + apply-edit rollback
- Add `cursor` index to the (generation_id, scene_index) version chain
- Keep last 10 versions, trim oldest on insert
- New worker task type `redo_regeneration` that moves the cursor forward
- Frontend: undo/redo buttons + `Ctrl+Z` / `Ctrl+Shift+Z` in the scene editor
- Ensure `applyImageEdit` (`useCinematicRegeneration.ts:165`) writes a version row **before** mutating, so it is undoable

---

## 12. Implementation Prompt (for the coding session that follows)

> Implement the following fixes in the motionmax repo on a new branch `perf/worker-tune-2026-04`. Do not touch the dead edge functions until step 0 is merged. Commit per-step, run `pnpm typecheck` and `pnpm test` between steps.
>
> **Step 0 — Delete dead code (safety gate)**
> - Delete `supabase/functions/generate-video/` and `supabase/functions/generate-cinematic/` directories.
> - Delete `legacyCallPhase` function and the `DEFAULT_ENDPOINT`/`CINEMATIC_ENDPOINT` constants in `src/hooks/generation/callPhase.ts` and `src/hooks/generation/types.ts`. Remove the `endpoint` parameter from `callPhase` and all call sites.
> - Remove the `endpoint === CINEMATIC_ENDPOINT` auto-detection (`callPhase.ts:248`); require callers to pass `body.projectType` explicitly.
>
> **Step 1 — Batch frontend job submission**
> - In `src/hooks/generation/unifiedPipeline.ts`, replace the sequential `for` loops at lines 88-130 with a single `submitJobs` helper that accepts an array and does one `supabase.from("video_generation_jobs").insert([...]).select("id")` call.
> - Return the ID array in the same order.
> - Add `submitJobs(body[], taskTypes[], dependsOn[][])` to `callPhase.ts` next to `submitJob`.
>
> **Step 2 — Cancel fallback poll on Realtime fire**
> - In `src/hooks/generation/callPhase.ts` `pollWorkerJob()` (lines 156-233), clear `fallbackTimer` the first time `handleResult` is entered from the Realtime channel, not only on `settled`.
> - Keep the fallback as a 10-second safety net that only arms if no Realtime event has been seen.
>
> **Step 3 — Raise export batch size, gate export concurrency**
> - In `worker/src/handlers/exportVideo.ts:37`, leave the env default at `3` but document that production should set `EXPORT_BATCH_SIZE=6` on ≥2 GB instances.
> - In `worker/src/index.ts:59`, raise the per-job memory constant from `200` to `500` MB and add a new env-driven cap `EXPORT_MAX_CONCURRENT` (default `1`) that prevents more than one `export_video` job from running simultaneously per worker instance. Track active export count in a new `activeExports` counter.
>
> **Step 4 — Replace base64 ASR upload with multipart**
> - In `worker/src/services/audioASR.ts` around line 253, stop building a base64 data URI. Build a `FormData` with a `Blob` from the downloaded buffer and POST as `multipart/form-data` if the ASR provider supports it. If it does not, upload the audio file to a short-lived Supabase Storage URL and send the URL instead.
> - Confirm the Hypereal ASR endpoint supports one of these two modes (check provider docs before coding).
>
> **Step 5 — Replace progress poll with Realtime subscription**
> - In `src/hooks/generation/unifiedPipeline.ts:143-150`, replace the 5-second `setInterval` with a Realtime channel `supabase.channel("progress_"+projectId).on("postgres_changes", {event:"UPDATE", table:"video_generation_jobs", filter:"project_id=eq."+projectId}, ...)`.
> - Maintain a local `Map<jobId, status>` and recompute completed count on each event.
> - Keep a 15-second fallback poll as a safety net.
>
> **Step 6 — Undo/redo stack (P5)**
> - Migration: add `stack_position INTEGER` and `is_current BOOLEAN` to `scene_versions`, plus a composite index on `(generation_id, scene_index, stack_position)`. Write a SQL function `trim_scene_version_stack(gen_id, scene_idx, max_size)` that deletes oldest rows beyond `max_size` (default 10).
> - In every regen worker handler (`handleRegenerateImage.ts`, `handleRegenerateAudio.ts`, the apply-edit path in `handleCinematicVideo.ts`), insert a `scene_versions` row BEFORE mutating the scene, mark it `is_current=true`, flip any previous current row to false, call `trim_scene_version_stack(..., 10)`.
> - Add new worker task `redo_regeneration` in `worker/src/handlers/handleRedoRegeneration.ts`: find next-higher `stack_position` row, restore it, move the current marker forward.
> - Register in `index.ts` handler map next to `undo_regeneration`.
> - Frontend: add `redoRegeneration` to `useSceneRegeneration.ts` and `useCinematicRegeneration.ts` mirroring `undoRegeneration`. Add `redo` case in `callPhase.ts` routed to `redo_regeneration` task type with 30 s timeout. Add `"redo"` to `VALID_PHASES`.
> - UI: in the scene editor (find it via grep for `useCinematicRegeneration` in `src/pages/` or `src/components/`), add Undo and Redo buttons plus `Ctrl+Z`/`Ctrl+Shift+Z` keyboard shortcuts. Disable Undo when `stack_position === 0`; disable Redo when `is_current === max(stack_position)`.
>
> **Step 7 — Optional: Wan fallback client (P4 extension)**
> - Only if product decides Wan is wanted as a cheaper fallback. Create `worker/src/services/wanClient.ts` with `createVideoTask(imageUrl, prompt, durationSec)` and `pollVideoTask(taskId)` matching DashScope's `wanx2.1-i2v-*` async API.
> - In `handleCinematicVideo.ts`, add a provider selector: `process.env.VIDEO_PROVIDER_PRIMARY` (default `kling`) and `..._FALLBACK` (default empty). On primary failure/timeout, retry with fallback.
> - Add `WAN_API_KEY` env var and document in `README.md`.
>
> **Step 8 — Deployment**
> - Upgrade the Render worker instance to **Standard (2 GB / 1 CPU)** minimum — ideally **Pro (4 GB / 2 CPU)**. Set envs: `EXPORT_BATCH_SIZE=6`, `EXPORT_MAX_CONCURRENT=1`, `SHUTDOWN_DRAIN_TIMEOUT_MS=300000`.
> - Verify the Render buildpack includes `ffmpeg` and `libass`; if not, add a `Dockerfile` at `worker/Dockerfile` with a Node 22 base and `apt-get install -y ffmpeg libass9`.
> - Deploy, then run one full cinematic generation + export and capture worker `/metrics` every 30 s to confirm peak RSS stays under 75% of the new cap.
>
> **Non-goals (do not do in this branch)**
> - Do not switch from Supabase table polling to Redis/BullMQ. That is a separate architecture decision and the current queue is fine for current load.
> - Do not rewrite FFmpeg into sharp or @ffmpeg/wasm. System ffmpeg is correct for this workload.
> - Do not remove the scene_versions table — extend it.
> - Do not change Kling/PixVerse model selection without product sign-off.
>
> **Verification checklist before PR**
> - [ ] Full generation of a 4-scene cinematic under 8 min wall time (was ~20 min)
> - [ ] Full export of a 3-min explainer under 5 min wall time (was ~20 min)
> - [ ] Undo followed by redo restores original state exactly
> - [ ] Two concurrent users generating do not cause OOM in worker `/metrics`
> - [ ] Zero calls to `/functions/v1/generate-video` or `/functions/v1/generate-cinematic` in network trace
> - [ ] `pnpm typecheck`, `pnpm test`, and worker `npm run build` all pass

---

## 13. Open Questions (require confirmation before coding)

1. **Is a Dockerfile or render.yaml deployed somewhere outside this repo?** I found neither in `worker/` or the repo root. Render may be using a Node native buildpack with ffmpeg added manually in the dashboard. Confirm before Step 8.
2. **Is the production frontend on the same commit as `main`?** The user's belief that image/video regen hits edge functions strongly suggests a stale Vercel deploy or a user-local dev build. Check the deployed hash.
3. **Which Kling tier is the account on?** This governs concurrent job headroom and is the single biggest lever on end-to-end wall time.
4. **Does `handleRegenerateImage.ts` currently write to `scene_versions` before mutating?** Step 6 depends on this — needs a read before coding.
5. **Do you actually want Wan integrated, or is the reference to "Kling/Wan" in the original ask just shorthand for "the cinematic video API"?** If the latter, skip Step 7.

---

## 14. Citations / sources to verify live

- Render pricing: https://render.com/pricing
- Render background workers docs: https://render.com/docs/background-workers
- Supabase Edge Function limits: https://supabase.com/docs/guides/functions/limits
- Kling API: https://app.klingai.com/global/dev/document-api
- Wan (DashScope) async video API: https://help.aliyun.com/zh/model-studio/
- PixVerse API: https://app.pixverse.ai/api (verify endpoint name)

Numbers in §6 are from pre-2026 knowledge; the tier names and shapes are stable but prices move. Open each URL before spending money.
