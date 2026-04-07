@echo off
REM ============================================================================
REM  MOTIONMAX PIPELINE PERFORMANCE REPORT V2 (POST-REFACTOR)
REM  Generated: 2026-04-07
REM  Audited by: 4 Specialized Agents on the REFACTORED codebase
REM  Previous report: PIPELINE_PERFORMANCE_REPORT.cmd (pre-refactor)
REM ============================================================================
REM
REM  WHAT CHANGED IN THE REFACTOR (improvements already made):
REM  ==========================================================
REM  [FIXED] standardPipeline.ts merged into unifiedPipeline.ts
REM  [FIXED] Audio batch size raised from 3 to 5
REM  [FIXED] Per-image DB writes now use atomic jsonb_set RPC (no full array overwrite)
REM  [FIXED] Image retry rounds reduced from 2 to 1 (prevents double-billing)
REM  [FIXED] Character consistency integrated into script phase (no separate step)
REM  [FIXED] Credit deduction moved to edge function (server-side)
REM  [FIXED] Per-job 429 backoff replaced global cooldown (in worker)
REM  [FIXED] Worker credit refund on failure
REM  [FIXED] Export handler modularized (sceneEncoder, transitions, compression)
REM  [NEW]   Qwen3 TTS as primary cinematic audio (9 speakers, multi-language)
REM  [NEW]   Grok Video I2V for export AI enhancement
REM  [NEW]   Research phase for all project types
REM  [NEW]   Unified pipeline handles both standard and cinematic
REM
REM  CURRENT TIMING (12-scene cinematic video):
REM  ===========================================
REM  Phase 1: Script (research + LLM) .... 30-120 seconds
REM  Phase 2: Audio (Qwen3 TTS, 3 batches) 30-90 seconds
REM  Phase 3: Images (all 12 parallel) .... 5-25 seconds
REM  Phase 4: Video (Kling V2.5, parallel)  90-600 seconds (THE BOTTLENECK)
REM  Phase 5: Finalize .................... 2-5 seconds
REM  Phase 6: Export (user-triggered) ..... 120-600 seconds
REM  Overhead: Polling + DB reads ......... 30-60 seconds
REM  =============================================
REM  TOTAL: ~7-20 minutes (down from 10-30 min pre-refactor)
REM
REM  REMAINING OPTIMIZATIONS POSSIBLE: ~3-8 more minutes savings
REM
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #              REMAINING BOTTLENECKS (Post-Refactor)                       #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  BOTTLENECK-01: Kling V2.5 Used as Primary (V3.0 Available But Unused)
REM  File: worker/src/handlers/handleCinematicVideo.ts, line 232
REM  File: worker/src/services/hypereal.ts (V3.0 implemented but not wired)
REM  Impact: CRITICAL - this is still 60-80%% of total generation time
REM ============================================================================
REM
REM  CURRENT MODEL CHAIN:
REM    Primary: kling-2-5-i2v (V2.5 Turbo, 35 credits) -> 60-180s per clip
REM    Fallback: kling-2-6-i2v-pro (V2.6 Pro, 35 credits)
REM
REM  AVAILABLE BUT NOT WIRED:
REM    kling-3-0-std-i2v (V3.0 Standard, 42 credits)
REM    - Already fully implemented in hypereal.ts (lines 115-188)
REM    - Supports native end_image transitions
REM    - Supports 3, 5, 10, 15s durations (more flexible)
REM    - Reported 2-3x faster generation
REM
REM  ALSO AVAILABLE:
REM    veo-3-1-i2v (Google Veo 3.1 Fast, 72 credits)
REM    - Implemented in worker/src/services/ltxVideo.ts
REM    - Native first/last frame interpolation
REM    - NOT active in current pipeline
REM
REM  FIX: In handleCinematicVideo.ts, change the primary model call:
REM    // BEFORE: const result = await generateKlingV25Video(...)
REM    // AFTER:  const result = await generateKlingV30Video(...)
REM    // Keep V2.5 as fallback instead of V2.6
REM
REM  COST: +20%% per scene (42 vs 35 credits)
REM  TIME SAVINGS: potentially 30-120s per scene = 6-24 min for 12 scenes
REM  NET: Pay 20%% more, generate 50-66%% faster. Almost certainly worth it.
REM ============================================================================

REM ============================================================================
REM  BOTTLENECK-02: Video Still Waits for i+1 Image (end_image dependency)
REM  File: src/hooks/generation/cinematicPipeline.ts, lines 192-197
REM  Impact: HIGH - serializes video starts behind image completion
REM ============================================================================
REM
REM  CURRENT: Scene N video waits for BOTH:
REM    await imagePromises[i];      // this scene's image
REM    await imagePromises[i + 1];  // NEXT scene's image (for transition)
REM
REM  Plus if next image is missing after promise resolves, the WORKER
REM  polls DB every 15s for up to 5 minutes waiting for it.
REM
REM  This means the earliest a video can start is when TWO consecutive
REM  images are ready. If image 5 takes 30s but image 6 takes 60s,
REM  video 5 is blocked for the full 60s.
REM
REM  OPTIONS:
REM
REM  Option A (recommended with V3.0): Keep end_image transitions.
REM    V3.0 has native end_image support and is much faster. The i+1
REM    dependency becomes less painful when images complete in 5-15s.
REM
REM  Option B: Remove end_image for first pass, add transitions in export.
REM    Generate all videos with start_image only. Use FFmpeg crossfade
REM    during export for transitions. Unblocks every video immediately.
REM    Saves: 5-30s per scene on the dependency wait.
REM
REM  Option C: Pre-generate placeholder end_images.
REM    Use a fast AI call to generate a "transition target" image before
REM    the full scene image is ready. Replace with real image later.
REM
REM  ESTIMATED SAVINGS: 1-5 min depending on image generation variance
REM ============================================================================

REM ============================================================================
REM  BOTTLENECK-03: Client Polling Still Fixed at 2s (Not Adaptive)
REM  File: src/hooks/generation/callPhase.ts, line 128
REM  File: worker/src/index.ts, line 402
REM  Impact: MEDIUM - ~1000+ wasted DB reads per generation
REM ============================================================================
REM
REM  CURRENT: POLL_INTERVAL = 2000ms for ALL phase types.
REM
REM  For a 12-scene cinematic video:
REM    - Script (30-120s): 15-60 polls (need ~5s interval)
REM    - 12 audio jobs (~15s each): 12 * 7 = 84 polls (need ~3s interval)
REM    - 12 image jobs (~10s each): 12 * 5 = 60 polls (need ~5s interval)
REM    - 12 video jobs (~120s each): 12 * 60 = 720 polls (need ~15s interval)
REM    - Finalize (~3s): 2 polls (2s is fine)
REM    Total: ~880 polls at 2s = 880 DB reads
REM
REM  With adaptive intervals:
REM    Total: ~200 polls = 200 DB reads (77%% reduction)
REM
REM  FIX: In callPhase.ts, make pollWorkerJob accept interval parameter:
REM
REM    const POLL_INTERVALS = {
REM      generate_video: 5000,     // Script: 30-120s
REM      cinematic_audio: 3000,    // Audio: 10-30s
REM      cinematic_image: 5000,    // Image: 5-20s
REM      cinematic_video: 15000,   // Kling: 60-600s
REM      finalize_generation: 2000,// Fast: 2-5s
REM      export_video: 10000,      // Export: 2-10 min
REM    };
REM
REM  BETTER FIX: Use Supabase Realtime for ALL phases (see ARCH-01).
REM
REM  ESTIMATED SAVINGS: 680 fewer DB reads + ~30-60s latency reduction
REM ============================================================================

REM ============================================================================
REM  BOTTLENECK-04: Audio Batched at 5 When All 12 Could Fire Simultaneously
REM  File: src/hooks/generation/unifiedPipeline.ts, line 17
REM  Impact: MEDIUM - adds 1-2 unnecessary batch waits
REM ============================================================================
REM
REM  CURRENT: AUDIO_CONCURRENCY = 5 (improved from 3, good)
REM    Batch 1: scenes 0-4 (parallel) -> wait -> ~10-30s
REM    Batch 2: scenes 5-9 (parallel) -> wait -> ~10-30s
REM    Batch 3: scenes 10-11 (parallel) -> wait -> ~10-15s
REM    Total: 30-75s (3 sequential batch waits)
REM
REM  OPTIMAL: Fire all 12 simultaneously.
REM  Each audio job is a REMOTE worker task. The client isn't doing CPU work.
REM  The worker handles rate limiting server-side. Client batching is
REM  unnecessary overhead.
REM
REM  FIX:
REM    // BEFORE:
REM    for (let batchStart = 0; ...; batchStart += AUDIO_CONCURRENCY) {
REM      const batch = ...; await Promise.all(batch);
REM    }
REM
REM    // AFTER:
REM    const allAudio = Array.from({ length: sceneCount }, (_, i) =>
REM      callPhase({ phase: "audio", sceneIndex: i })
REM    );
REM    await Promise.allSettled(allAudio);
REM
REM  ESTIMATED SAVINGS: 15-40s (eliminates 1-2 batch waits)
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                  REMAINING REDUNDANCIES                                  #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  REDUNDANCY-01: Old 4-Provider TTS Cascade Still Active (Non-Cinematic)
REM  File: worker/src/services/audioRouter.ts
REM  Impact: MEDIUM - adds latency on TTS failures for standard projects
REM ============================================================================
REM
REM  CINEMATIC: Uses Qwen3 TTS (good, single provider, 9 speakers)
REM
REM  STANDARD (doc2video, storytelling, smartflow) English Male:
REM    Lemonfox (adam) -> Fish Audio -> Chatterbox (Replicate)
REM    3 providers for the same job.
REM
REM  STANDARD English Female:
REM    Fish Audio -> Chatterbox (Replicate)
REM    2 providers.
REM
REM  RECOMMENDATION: Consider using Qwen3 for ALL project types, not just
REM  cinematic. Qwen3 supports multi-language (EN, FR, ES, DE, IT, PT, RU,
REM  ZH, JA, KO) and has 9 distinct speakers. This would:
REM    - Eliminate Lemonfox, Fish Audio, and Chatterbox from the cascade
REM    - Reduce from 4 API integrations to 2 (Qwen3 + ElevenLabs for clones)
REM    - Simplify audioRouter.ts significantly
REM    - Reduce maintenance burden
REM
REM  KEEP: ElevenLabs (for custom cloned voices)
REM  KEEP: Gemini TTS (for Haitian Creole only)
REM  REMOVE: Lemonfox, Fish Audio, Chatterbox
REM
REM  ESTIMATED SAVINGS: 5-45s on fallback paths + 3 fewer API keys to manage
REM ============================================================================

REM ============================================================================
REM  REDUNDANCY-02: Voice Cloning Still 2-Step for Haitian Creole
REM  File: worker/src/services/audioRouter.ts (HC + clone voice path)
REM  Impact: LOW - only affects HC + custom voice users
REM ============================================================================
REM
REM  CURRENT (HC + clone voice):
REM    Step 1: Gemini TTS generates base audio (~5-10s)
REM    Step 2: ElevenLabs Speech-to-Speech transforms voice (~5-10s)
REM    Total: 10-20s per scene
REM
REM  ElevenLabs eleven_multilingual_v2 supports Haitian Creole natively.
REM  Could use ElevenLabs TTS directly with cloned voice ID (1 API call).
REM
REM  ESTIMATED SAVINGS: 5-10s per scene for HC custom voice users.
REM ============================================================================

REM ============================================================================
REM  REDUNDANCY-03: handleImages.ts and handleAudio.ts are DEAD CODE
REM  Files: worker/src/handlers/handleImages.ts
REM         worker/src/handlers/handleAudio.ts
REM  Impact: LOW - no performance impact, just code clutter
REM ============================================================================
REM
REM  PROBLEM: The unified pipeline routes ALL audio to "cinematic_audio"
REM  and ALL images to "cinematic_image" task types, even for standard
REM  projects. The old bulk handlers (handleImages with batch-of-9,
REM  handleAudio with batch-of-3) have no task_type route in index.ts.
REM
REM  FIX: Delete both files. They are unreachable dead code.
REM  Also clean up any references in index.ts imports.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                   OVERHEAD & WASTED TIME                                 #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  OVERHEAD-01: 12 Redundant DB Reads in Video Phase
REM  File: worker/src/handlers/handleCinematicVideo.ts
REM  Impact: MEDIUM - 12 simultaneous reads of the same row
REM ============================================================================
REM
REM  CURRENT: Each of the 12 video jobs independently reads the FULL
REM  generations.scenes row to check if videoUrl already exists.
REM  12 parallel jobs = 12 reads of the same large JSONB row.
REM
REM  FIX: The skip-check should use a targeted query:
REM    SELECT scenes->sceneIndex->>'videoUrl'
REM    FROM generations WHERE id = $1
REM
REM  Or better: the client can pass a "skip" flag when dispatching the
REM  video job, since it already knows which scenes have videos from
REM  the image phase results.
REM
REM  ESTIMATED SAVINGS: 11 DB reads, ~500ms total.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-02: Client-Side Global Cooldown Still Exists (cinematicPipeline)
REM  File: src/hooks/generation/cinematicPipeline.ts, lines 20-21
REM  Impact: MEDIUM - one 429 delays all remaining image jobs
REM ============================================================================
REM
REM  CURRENT: Module-level lastRateLimitTime + GLOBAL_COOLDOWN_MS = 15000ms.
REM  If ANY image job gets a retryAfterMs >= 20000, ALL subsequent image
REM  jobs from the same client wait 15s before submitting.
REM
REM  NOTE: The WORKER has per-job 429 backoff (good, this was fixed).
REM  But the CLIENT still has a global cooldown that penalizes all jobs.
REM
REM  FIX: Remove client-side global cooldown entirely. The worker's
REM  per-job backoff handles rate limiting properly. The client should
REM  just submit and let the worker manage API rate limits.
REM
REM  ESTIMATED SAVINGS: 15-45s when rate limits occur.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-03: Image Retry is Sequential (Not Parallel)
REM  File: src/hooks/generation/cinematicPipeline.ts, line 295
REM  Impact: LOW-MEDIUM (only when images fail)
REM ============================================================================
REM
REM  CURRENT: Missing images retried one-by-one in a for loop with
REM  rate-limit cooldown checks between each.
REM
REM  FIX: Fire all retry jobs in parallel:
REM    const retries = missingIndices.map(idx =>
REM      callPhase({ phase: "images", sceneIndex: idx })
REM    );
REM    await Promise.allSettled(retries);
REM
REM  NOTE: The unified pipeline (unifiedPipeline.ts line 184) already
REM  does this correctly with Promise.allSettled. This issue is only
REM  in the cinematic-specific resume path.
REM
REM  ESTIMATED SAVINGS: 30-120s for multi-image retry scenarios.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-04: Export Uses getUser() Instead of getSession()
REM  File: src/hooks/useVideoExport.ts, line 179
REM  Impact: LOW - adds ~200-500ms + network failure risk
REM ============================================================================
REM
REM  CURRENT: getUser() makes a live API request to validate session.
REM  All other pipeline code uses getSession() (local storage, instant).
REM  callPhase.ts line 98 has an explicit comment explaining why getSession
REM  is preferred.
REM
REM  FIX: Change getUser() to getSession():
REM    const { data: { session } } = await supabase.auth.getSession();
REM    if (!session?.user) throw new Error("Not authenticated");
REM
REM  ESTIMATED SAVINGS: 200-500ms per export start.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-05: Duration Force-Set to 11s Twice
REM  File: worker/src/handlers/generateVideo.ts, lines 365 + 397-399
REM  File: worker/src/handlers/sceneProcessor.ts
REM  Impact: NONE (correctness issue, no perf impact)
REM ============================================================================
REM
REM  sceneProcessor.ts forces duration = 11 for all non-smartflow projects.
REM  Then generateVideo.ts forces duration = 11 AGAIN specifically for
REM  cinematic (lines 397-399). The second override is redundant.
REM
REM  FIX: Remove the duplicate override in generateVideo.ts.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #              ARCHITECTURAL IMPROVEMENTS                                  #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  ARCH-01: Use Supabase Realtime for ALL Phases (Not Just Export)
REM  File: src/hooks/useVideoExport.ts (already implements Realtime)
REM  Impact: HIGH - eliminate 880+ polling reads per generation
REM ============================================================================
REM
REM  CURRENT: Export uses Realtime + 5s fallback polling (dual mechanism).
REM  ALL generation phases (script, audio, image, video, finalize) use
REM  polling-only at 2s intervals.
REM
REM  The Realtime infrastructure is already proven in the export flow.
REM  Extending it to all phases is a moderate effort with high payoff.
REM
REM  FIX: Create a generic waitForJob() that uses Realtime + poll fallback:
REM
REM    async function waitForJob(jobId: string, timeoutMs: number) {
REM      return new Promise((resolve, reject) => {
REM        const channel = supabase
REM          .channel(`job_${jobId}`)
REM          .on("postgres_changes", {
REM            event: "UPDATE",
REM            schema: "public",
REM            table: "video_generation_jobs",
REM            filter: `id=eq.${jobId}`
REM          }, (payload) => {
REM            if (payload.new.status === "completed") {
REM              cleanup(); resolve(payload.new);
REM            }
REM            if (payload.new.status === "failed") {
REM              cleanup(); reject(new Error(payload.new.error_message));
REM            }
REM          })
REM          .subscribe();
REM
REM        // Fallback poll every 15s
REM        const fallback = setInterval(async () => {
REM          const { data } = await supabase
REM            .from("video_generation_jobs")
REM            .select("status,result,error_message")
REM            .eq("id", jobId).single();
REM          if (data?.status === "completed") { cleanup(); resolve(data); }
REM          if (data?.status === "failed") { cleanup(); reject(...); }
REM        }, 15000);
REM
REM        function cleanup() {
REM          supabase.removeChannel(channel);
REM          clearInterval(fallback);
REM        }
REM        setTimeout(() => { cleanup(); reject(new Error("Timeout")); }, timeoutMs);
REM      });
REM    }
REM
REM  Replace pollWorkerJob() in callPhase.ts with this.
REM
REM  ESTIMATED SAVINGS: 680+ fewer DB reads, ~30-60s latency reduction.
REM  Jobs complete INSTANTLY when worker finishes (no 2s poll delay).
REM ============================================================================

REM ============================================================================
REM  ARCH-02: Server-Side Job Dependencies (Still Not Implemented)
REM  Impact: HIGH - pipeline survives browser close
REM ============================================================================
REM
REM  CURRENT: No depends_on column. Flat video_generation_jobs table.
REM  The CLIENT orchestrates phase sequencing (script -> audio+images ->
REM  finalize). If browser closes mid-generation, pipeline stalls.
REM
REM  The refactor moved credit deduction server-side and decoupled the
REM  client from direct API calls, but the CLIENT is still the orchestrator
REM  that submits phase 2 after phase 1 completes.
REM
REM  PROPOSED: Add depends_on column to video_generation_jobs:
REM
REM    ALTER TABLE video_generation_jobs
REM      ADD COLUMN depends_on UUID[] DEFAULT '{}';
REM
REM  Update claim_pending_job to only claim jobs where ALL dependencies
REM  have status = "completed":
REM
REM    WHERE status = 'pending'
REM      AND (depends_on = '{}' OR NOT EXISTS (
REM        SELECT 1 FROM video_generation_jobs dep
REM        WHERE dep.id = ANY(j.depends_on)
REM          AND dep.status != 'completed'
REM      ))
REM
REM  Then pre-submit ALL jobs at generation start:
REM    script_job -> depends_on: []
REM    audio_0    -> depends_on: [script_job]
REM    audio_1    -> depends_on: [script_job]
REM    image_0    -> depends_on: [script_job]
REM    video_0    -> depends_on: [image_0, image_1]
REM    finalize   -> depends_on: [all_audio, all_video]
REM
REM  BENEFITS:
REM    - Pipeline continues if user closes browser
REM    - No client round-trips between phases
REM    - Worker handles ALL sequencing
REM    - Natural retry: failed jobs don't block independent branches
REM
REM  ESTIMATED EFFORT: 2-3 days
REM  ESTIMATED SAVINGS: 2-5 min (eliminates client orchestration overhead)
REM ============================================================================

REM ============================================================================
REM  ARCH-03: Consider Qwen3 for ALL Project Types (Not Just Cinematic)
REM  Impact: MEDIUM - simplifies TTS architecture
REM ============================================================================
REM
REM  CURRENT:
REM    Cinematic -> Qwen3 TTS (1 provider, 9 speakers, multi-lang)
REM    Standard  -> Lemonfox/Fish/Chatterbox cascade (3 providers)
REM
REM  Qwen3 already supports EN, FR, ES, DE, IT, PT, RU, ZH, JA, KO.
REM  It has 9 distinct speaker voices with emotional style inference.
REM
REM  FIX: Route standard projects through Qwen3 as well.
REM  Keep ElevenLabs for custom cloned voices only.
REM  Keep Gemini for Haitian Creole only.
REM
REM  This reduces the TTS stack from 5 providers to 3:
REM    Qwen3 (primary, all languages) + ElevenLabs (clones) + Gemini (HC)
REM
REM  ESTIMATED SAVINGS: Simpler code, fewer API keys, faster fallback.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                 WHAT'S WORKING WELL (Don't Change)                       #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  These are CORRECT and WELL-OPTIMIZED patterns:
REM
REM  1. Unified pipeline handles both standard and cinematic - GOOD
REM  2. Audio + Images run in parallel (Promise.all) - CORRECT
REM  3. Videos stream-start as images complete (Promise gates) - CORRECT
REM  4. Atomic jsonb_set RPC for scene updates (no full array overwrite) - FIXED
REM  5. Worker auto-tunes concurrency (4-20, CPU+memory aware) - CORRECT
REM  6. Per-job 429 backoff in worker (not global) - FIXED
REM  7. Credit deduction server-side with refund on failure - FIXED
REM  8. Epoch-based stale pipeline guard - SMART PATTERN
REM  9. Export uses Realtime + adaptive polling (dual mechanism) - CORRECT
REM  10. Worker priority: export jobs claimed first - CORRECT
REM  11. Graceful shutdown with 5-min drain - CORRECT
REM  12. Orphan job recovery on restart with restart counter - CORRECT
REM  13. Image retry reduced to 1 round (prevents double-billing) - FIXED
REM  14. Research phase for factual accuracy (all project types) - GOOD
REM  15. Qwen3 TTS with style inference for cinematic - EXCELLENT
REM  16. Audio batch size raised to 5 - IMPROVED
REM  17. All images fire simultaneously (no client batching) - CORRECT
REM  18. Character bible embedded in script phase - SIMPLIFIED
REM  19. Kling adaptive polling (10s fast / 20s slow, jitter) - GOOD
REM  20. No artificial delays in worker - CONFIRMED
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                   PRIORITIZED ACTION PLAN                                #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  PHASE 1: QUICK WINS (Day 1) - Save 2-5 minutes
REM  Estimated effort: 3-4 hours
REM ============================================================================
REM
REM  1. Upgrade to Kling V3.0 as primary model (BOTTLENECK-01)
REM     - Change 1 function call in handleCinematicVideo.ts
REM     - V3.0 already implemented in hypereal.ts, just not wired
REM     - Saves: potentially 3-12 min (biggest single improvement)
REM     - Cost: +20%% per video scene
REM
REM  2. Fire all 12 audio jobs simultaneously (BOTTLENECK-04)
REM     - Remove AUDIO_CONCURRENCY batching
REM     - Saves: 15-40s
REM
REM  3. Remove client-side global cooldown (OVERHEAD-02)
REM     - Delete lastRateLimitTime and GLOBAL_COOLDOWN_MS
REM     - Worker already handles rate limits per-job
REM     - Saves: 15-45s when rate limits occur
REM
REM  4. Delete dead code: handleImages.ts, handleAudio.ts (REDUNDANCY-03)
REM     - Clean up index.ts imports
REM     - Saves: 0 time, reduces confusion
REM
REM  5. Fix getUser() -> getSession() in export (OVERHEAD-04)
REM     - One line change
REM     - Saves: 200-500ms per export

REM ============================================================================
REM  PHASE 2: MEDIUM EFFORT (Days 2-3) - Save 1-3 more minutes
REM  Estimated effort: 1-2 days
REM ============================================================================
REM
REM  1. Add Supabase Realtime for all generation phases (ARCH-01)
REM     - Extend export's Realtime pattern to callPhase.ts
REM     - Saves: 30-60s latency + 680 DB reads
REM
REM  2. Adaptive polling as fallback (BOTTLENECK-03)
REM     - Different intervals per task type
REM     - Saves: 680 DB reads if Realtime isn't adopted
REM
REM  3. Consolidate TTS to Qwen3 for all project types (ARCH-03)
REM     - Route standard projects through Qwen3
REM     - Saves: 5-45s on fallback paths + maintenance
REM
REM  4. Parallel image retry in cinematic resume path (OVERHEAD-03)
REM     - Change sequential for loop to Promise.allSettled
REM     - Saves: 30-120s in retry scenarios

REM ============================================================================
REM  PHASE 3: MAJOR ARCHITECTURE (Week 2) - Save 2-5 more minutes
REM  Estimated effort: 2-3 days
REM ============================================================================
REM
REM  1. Server-side job dependencies (ARCH-02)
REM     - Add depends_on column to video_generation_jobs
REM     - Pre-submit ALL jobs at generation start
REM     - Client becomes read-only progress viewer
REM     - Pipeline survives browser close
REM     - Saves: 2-5 min (no client round-trips)
REM
REM  2. Remove end_image dependency (BOTTLENECK-02 Option B)
REM     - Only if V3.0 transitions aren't good enough
REM     - Use FFmpeg crossfade in export instead
REM     - Saves: 1-5 min


REM ############################################################################
REM #                                                                          #
REM #              EXPECTED RESULTS AFTER OPTIMIZATIONS                        #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM
REM  CURRENT (post-refactor, 12-scene cinematic):
REM  =============================================
REM  Script:    30-120s  (research + LLM)
REM  Audio:     30-90s   (3 batches of 5)
REM  Images:    5-25s    (all 12 parallel)
REM  Videos:    90-600s  (Kling V2.5, parallel)
REM  Finalize:  2-5s
REM  Export:    120-600s (user-triggered)
REM  Overhead:  30-60s   (polling)
REM  --------
REM  TOTAL:     7-20 MINUTES
REM
REM
REM  AFTER Phase 1 (Kling V3.0 + parallel audio + no cooldown):
REM  ===========================================================
REM  Script:    30-120s  (unchanged)
REM  Audio:     10-30s   (all 12 parallel)
REM  Images:    5-25s    (unchanged)
REM  Videos:    45-300s  (Kling V3.0, 2-3x faster)
REM  Finalize:  2-5s     (unchanged)
REM  Export:    120-600s (unchanged)
REM  Overhead:  20-40s   (less polling)
REM  --------
REM  TOTAL:     4-12 MINUTES (40-50%% faster)
REM
REM
REM  AFTER Phase 2 (Realtime + TTS consolidation):
REM  ===============================================
REM  Script:    30-120s
REM  Audio:     10-30s
REM  Images:    5-25s
REM  Videos:    45-300s
REM  Finalize:  2-5s
REM  Export:    120-600s
REM  Overhead:  5-10s    (Realtime, near-zero polling)
REM  --------
REM  TOTAL:     4-10 MINUTES
REM
REM
REM  AFTER Phase 3 (server-side orchestration):
REM  ============================================
REM  Script:    30-120s
REM  Audio:     10-30s   (overlapped, server-side)
REM  Images:    5-25s    (overlapped, server-side)
REM  Videos:    45-300s  (starts immediately)
REM  Finalize:  2-5s     (auto-triggered)
REM  Export:    120-600s (auto-triggered)
REM  Overhead:  ~0s      (no client round-trips)
REM  --------
REM  TOTAL:     3-8 MINUTES (browser can close!)
REM
REM  HARD FLOOR: ~2-5 min (Kling processing time, cannot optimize)
REM
REM ============================================================================

echo.
echo  =====================================================
echo   MOTIONMAX PIPELINE PERFORMANCE REPORT V2
echo   (Post-Refactor Assessment)
echo  =====================================================
echo.
echo   Refactor improvements already applied:
echo   - Unified pipeline (standard + cinematic)
echo   - Audio batch 3 -^> 5
echo   - Atomic jsonb_set (no full array overwrite)
echo   - Image retry 2 -^> 1 rounds
echo   - Server-side credit deduction
echo   - Per-job 429 backoff
echo   - Qwen3 TTS for cinematic
echo   - Character bible in script phase
echo.
echo   Current:   7-20 min per cinematic video
echo   After Ph1: 4-12 min  (Kling V3.0, parallel audio)
echo   After Ph2: 4-10 min  (Realtime, TTS consolidation)
echo   After Ph3: 3-8 min   (server-side orchestration)
echo   Hard floor: 2-5 min  (Kling processing time)
echo.
echo   #1 remaining bottleneck: Kling V2.5 (V3.0 available!)
echo   #1 remaining overhead:   Fixed 2s polling (Realtime available!)
echo   #1 remaining redundancy: 4-provider TTS cascade (Qwen3 can replace)
echo.
echo   Open this file in a text editor for full details.
echo  =====================================================
echo.
pause
