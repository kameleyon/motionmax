@echo off
REM ============================================================================
REM  MOTIONMAX GENERATION PIPELINE PERFORMANCE OPTIMIZATION REPORT
REM  Generated: 2026-04-06
REM  Audited by: 4 Specialized Agents (Cinematic Pipeline Tracer, Standard
REM              Pipeline Tracer, API Overlap Analyzer, Worker Analyzer)
REM  Focus: Why does cinematic take ~30 min? What can be optimized?
REM ============================================================================
REM
REM  CURRENT TIMING BREAKDOWN (12-scene cinematic video):
REM  =====================================================
REM  Phase 1: Script Generation ........... 30-90 seconds
REM  Phase 2: Audio Generation ............ 60-90 seconds (batched 5 at a time)
REM  Phase 3: Image Generation ............ 60-120 seconds (all 12 parallel)
REM  Phase 4: Video Generation (Kling) .... 5-20 MINUTES (the bottleneck)
REM  Phase 5: Finalize .................... 5-15 seconds
REM  Phase 6: Export (FFmpeg stitch) ...... 2-10 minutes
REM  Overhead: Polling + DB reads ......... 1-3 minutes wasted
REM  =====================================================
REM  TOTAL: ~10-30 minutes (Kling video = 60-80%% of total time)
REM
REM  AFTER OPTIMIZATIONS: ~6-15 minutes estimated (40-50%% faster)
REM
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #              THE #1 BOTTLENECK: KLING VIDEO GENERATION                   #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  BOTTLENECK-01: Video Scenes Process ONE AT A TIME (Sequential)
REM  File: worker/src/handlers/handleCinematicVideo.ts
REM  Impact: MASSIVE - this is why it takes 30 minutes
REM ============================================================================
REM
REM  PROBLEM: Each cinematic_video job processes a SINGLE scene. For 12 scenes
REM  the worker picks up scene 0, waits 60-180s for Kling, then scene 1, etc.
REM  Even though the worker supports 4-20 concurrent jobs, the CLIENT submits
REM  video jobs with image dependency chains that serialize them.
REM
REM  CURRENT FLOW:
REM    Image 0 done + Image 1 done -> Video 0 starts (60-180s)
REM    Image 1 done + Image 2 done -> Video 1 starts (60-180s)
REM    ... but each video POLLS for 60-180s before completing
REM
REM  The good news: the client DOES fire all 12 video promises simultaneously
REM  (cinematicPipeline.ts line 195). The dependency is only on images, not
REM  on previous videos. So videos CAN run in parallel IF images complete fast.
REM
REM  THE REAL BOTTLENECK: Hypereal/Kling API rate limiting.
REM  - Worker polls Hypereal every 10-20s per video
REM  - After 4 consecutive 429s -> job fails with rate-limit error
REM  - Global cooldown of 15s applied to ALL jobs after ANY 429
REM
REM  OPTIMIZATION OPTIONS:
REM
REM  Option A: Use Kling V3.0 Standard (faster model)
REM    - Model: kling-3-0-std-i2v (currently using kling-2-6-i2v-pro)
REM    - V3.0 is reported to be 2-3x faster generation
REM    - Cost: 42 credits vs 35 credits (20% more but 2x faster)
REM    - In worker/src/services/hypereal.ts, change default model
REM
REM  Option B: Submit ALL video jobs upfront with server-side dependency
REM    - Instead of client waiting for images then submitting video jobs,
REM      submit ALL video jobs immediately with a "depends_on" field
REM    - Worker checks if image exists before starting Kling call
REM    - If image not ready, re-queue with 10s delay (not fail)
REM    - This removes the client as a bottleneck in the chain
REM
REM  Option C: Remove end_image transition requirement for first pass
REM    - Currently each video needs BOTH scene N image AND scene N+1 image
REM    - The N+1 dependency adds latency (can't start video until next
REM      scene's image is done too)
REM    - Generate initial videos WITHOUT end_image transitions
REM    - Add transitions as a post-processing step (FFmpeg crossfade)
REM    - This unblocks every video as soon as its OWN image is ready
REM    - Savings: potentially 30-60s per scene
REM
REM  Option D: Upgrade Hypereal API tier for higher rate limits
REM    - Current: appears to hit 429s at ~4 concurrent video requests
REM    - Higher tier would allow more parallel video generation
REM    - Check hypereal.cloud pricing for enterprise/bulk tiers
REM
REM  ESTIMATED SAVINGS: 5-15 minutes (Option C alone saves ~3-5 min)
REM ============================================================================

REM ============================================================================
REM  BOTTLENECK-02: Kling Video Polling Too Frequent (Wasted DB Reads)
REM  File: src/hooks/generation/callPhase.ts, line 128
REM  File: worker/src/services/hypereal.ts, lines 272-357
REM  Impact: HIGH - up to 1080 wasted DB reads per generation
REM ============================================================================
REM
REM  PROBLEM: Client polls worker job status every 2 seconds (POLL_INTERVAL).
REM  Kling videos take 60-180 seconds. For 12 scenes running in parallel:
REM    12 scenes * 90 polls avg * 2s = 1080 DB reads just for video polling
REM
REM  Plus the worker itself polls Hypereal every 10-20s per scene.
REM
REM  FIX: Adaptive polling based on task type. In callPhase.ts:
REM
REM    const POLL_INTERVALS: Record<string, number> = {
REM      generate_video: 5000,     // Script: 30-90s, poll every 5s
REM      cinematic_video: 15000,   // Kling: 60-180s, poll every 15s
REM      cinematic_audio: 3000,    // TTS: 5-20s, poll every 3s
REM      cinematic_image: 5000,    // Image: 10-60s, poll every 5s
REM      process_audio: 3000,      // Batch audio: similar to per-scene
REM      process_images: 5000,     // Batch images: similar
REM      finalize_generation: 2000,// Fast: 5-15s, keep 2s
REM      export_video: 10000,      // Export: 2-10min, poll every 10s
REM      default: 2000
REM    };
REM
REM  For cinematic_video alone this reduces DB reads from 1080 to ~144.
REM  Combined with Supabase Realtime (already used for export), this
REM  could eliminate polling entirely for video phase.
REM
REM  BETTER FIX: Use Supabase Realtime for ALL phases (not just export).
REM  The infrastructure already exists in useVideoExport.ts. Replicate it
REM  for generation phases. Then polling becomes a fallback only.
REM
REM  ESTIMATED SAVINGS: ~900 DB reads/generation, ~1-2 min polling overhead
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #            DUPLICATE/REDUNDANT STEPS IN THE PIPELINE                     #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  REDUNDANCY-01: 4 TTS Providers in Cascade (Only Need 2)
REM  File: supabase/functions/_shared/audioEngine.ts, lines 892-1032
REM  Impact: HIGH - adds latency on TTS failures + maintenance burden
REM ============================================================================
REM
REM  CURRENT CASCADE (Default Route):
REM    1. Lemonfox TTS (adam/river voices)
REM       |-- if fails -->
REM    2. Chatterbox Turbo (Replicate)
REM       |-- if fails -->
REM    3. Fish Audio TTS (female English)
REM       |-- if fails -->
REM    4. Gemini TTS (key rotation, 5 rounds)
REM       |-- if all fail -->
REM    ERROR
REM
REM  PROBLEM: When primary fails, each fallback adds 5-15 seconds of latency
REM  (API call + timeout). A scene that fails Lemonfox, Chatterbox, AND Fish
REM  Audio before succeeding on Gemini adds 15-45s of unnecessary waiting.
REM
REM  All 4 providers produce similar quality English TTS at ~$0.01/min.
REM  Chatterbox and Fish Audio overlap completely with Lemonfox for English.
REM
REM  RECOMMENDED CONSOLIDATION:
REM    Route 1 (English, standard voice): Lemonfox -> Gemini (2 providers)
REM    Route 2 (Custom voice / cloned): ElevenLabs direct (1 provider)
REM    Route 3 (Haitian Creole): Gemini -> ElevenLabs STS (unchanged)
REM
REM  REMOVE: Chatterbox (Replicate) and Fish Audio from cascade.
REM
REM  FIX in audioEngine.ts - simplify the cascade:
REM    async function generateAudio(text, voice, language) {
REM      if (voice.isCustom) return elevenlabsTTS(text, voice.id);
REM      if (language === "ht") return geminiTTS(text) |> elevenlabsSTS(voice);
REM      try { return await lemonfoxTTS(text, voice); }
REM      catch { return await geminiTTS(text); }
REM    }
REM
REM  COST SAVINGS: Remove Fish Audio and Replicate TTS API costs.
REM  TIME SAVINGS: 5-45s per scene on fallback paths.
REM  MAINTENANCE: 2 fewer API integrations to maintain/monitor.
REM ============================================================================

REM ============================================================================
REM  REDUNDANCY-02: Character Descriptions Generated TWICE
REM  Files: supabase/functions/generate-video/index.ts (lines 3154, 3744)
REM  Impact: MEDIUM - extra AI call + image generation per character
REM ============================================================================
REM
REM  CURRENT FLOW:
REM    Step 1: OpenRouter generates script WITH character descriptions embedded
REM            (the LLM prompt asks for character visual descriptions)
REM    Step 2: SEPARATE Hypereal calls generate reference images for each
REM            character using those descriptions (lines 3726-3773)
REM
REM  PROBLEM: The character descriptions from Step 1 are extracted and
REM  re-processed in Step 2. The image generation call re-interprets them
REM  through another AI model. This is redundant processing.
REM
REM  FIX: Cache character visual descriptions from script generation.
REM  Pass them directly to scene image prompts as "character_reference"
REM  context, avoiding the separate Hypereal character image generation
REM  step entirely. OR generate character reference images AS PART of the
REM  scene image batch (not as a separate pre-step).
REM
REM  ESTIMATED SAVINGS: 10-30s + $0.04-0.16 per generation (1-4 characters)
REM ============================================================================

REM ============================================================================
REM  REDUNDANCY-03: Dual Image Generation Services for Same Output
REM  File: supabase/functions/generate-video/index.ts (lines 888-950, 4026)
REM  Impact: LOW (fallback only) - but adds code complexity
REM ============================================================================
REM
REM  CURRENT: Hypereal (primary) + Replicate nano-banana-2 (fallback)
REM  Both use Gemini 3.1 Flash T2I model underneath. Same pricing ($0.04).
REM  Same output quality. Replicate is only called if Hypereal fails.
REM
REM  RECOMMENDATION: Keep as-is (fallback is valid architecture), but
REM  document that both are identical models. If Hypereal reliability
REM  is >99.5%, consider removing Replicate image fallback to simplify.
REM ============================================================================

REM ============================================================================
REM  REDUNDANCY-04: Triple Video Generation Providers (Only 1 Used)
REM  Files: supabase/functions/generate-cinematic/index.ts
REM         worker/src/services/hypereal.ts
REM  Impact: LOW - Grok video model appears unused/commented out
REM ============================================================================
REM
REM  CURRENT: Hypereal Kling (primary) -> Replicate Seedance (fallback 1)
REM           -> Replicate Grok Video (fallback 2, commented out)
REM
REM  The Grok Video model is referenced but appears commented out in the
REM  worker. Seedance is a valid fallback.
REM
REM  FIX: Remove dead Grok video code. Keep Kling + Seedance as primary/fallback.
REM ============================================================================

REM ============================================================================
REM  REDUNDANCY-05: Voice Cloning is 2 API Calls Instead of 1
REM  Files: supabase/functions/_shared/audioEngine.ts
REM         supabase/functions/clone-voice/index.ts
REM  Impact: MEDIUM - doubles latency for custom voice TTS
REM ============================================================================
REM
REM  CURRENT (Haitian Creole + Custom Voice):
REM    1. Gemini TTS generates base audio (API call #1, ~5-10s)
REM    2. ElevenLabs Speech-to-Speech transforms voice (API call #2, ~5-10s)
REM    Total: 10-20s per scene
REM
REM  OPTIMAL:
REM    1. ElevenLabs TTS with cloned voice ID directly (API call #1, ~5-10s)
REM    Total: 5-10s per scene
REM
REM  For custom (non-Haitian-Creole) voices, Route 2 already does this
REM  correctly (single ElevenLabs call). The issue is only Route 1 (HC).
REM
REM  FIX: For HC + custom voice, use ElevenLabs TTS directly with the
REM  cloned voice ID. ElevenLabs eleven_multilingual_v2 supports Haitian
REM  Creole. Skip the Gemini intermediate step.
REM
REM  ESTIMATED SAVINGS: 5-10s per scene for HC custom voice users.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #            UNNECESSARY OVERHEAD & WASTED TIME                            #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  OVERHEAD-01: Audio Batched at 5 When All 12 Could Fire Simultaneously
REM  File: src/hooks/generation/cinematicPipeline.ts, lines 102-128
REM  Impact: MEDIUM - adds 1-2 unnecessary batch rounds
REM ============================================================================
REM
REM  CURRENT: AUDIO_CONCURRENCY = 5
REM    Batch 1: scenes 0-4 (5 jobs) -> wait for all -> ~15-30s
REM    Batch 2: scenes 5-9 (5 jobs) -> wait for all -> ~15-30s
REM    Batch 3: scenes 10-11 (2 jobs) -> wait for all -> ~5-15s
REM    Total: 35-75s (3 sequential batches)
REM
REM  OPTIMAL: Fire all 12 simultaneously.
REM  Each audio job is a REMOTE worker task. The client isn't doing CPU work.
REM  The worker has 4-20 concurrent job capacity. Rate limiting is handled
REM  server-side by the TTS providers, not by client batching.
REM
REM  FIX: In cinematicPipeline.ts, change audio processing:
REM
REM    // BEFORE (batched):
REM    for (let batchStart = 0; batchStart < sceneCount; batchStart += AUDIO_CONCURRENCY) {
REM      const batch = scenes.slice(batchStart, batchStart + AUDIO_CONCURRENCY)
REM        .map(processAudioScene);
REM      await Promise.allSettled(batch);
REM    }
REM
REM    // AFTER (all parallel):
REM    const allAudio = Array.from({ length: sceneCount }, (_, i) =>
REM      processAudioScene(i)
REM    );
REM    await Promise.allSettled(allAudio);
REM
REM  ESTIMATED SAVINGS: 15-40s (eliminates 1-2 batch rounds)
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-02: 12 Individual DB Reads Before Video Submission
REM  File: src/hooks/generation/cinematicPipeline.ts, lines 198-200
REM  Impact: MEDIUM - 12 SELECT queries that could be 1
REM ============================================================================
REM
REM  CURRENT: Before submitting each video job, the code does:
REM    const gen = await supabase.from("generations")
REM      .select("scenes").eq("id", generationId).maybeSingle();
REM    if (gen.data?.scenes?.[i]?.videoUrl) return; // skip
REM
REM  This runs 12 times (once per scene). All 12 read the SAME row.
REM
REM  FIX: Read once at the start of runCinematicVisuals:
REM
REM    const { data: gen } = await supabase.from("generations")
REM      .select("scenes").eq("id", generationId).maybeSingle();
REM    const existingVideos = new Set(
REM      gen?.scenes
REM        ?.map((s, i) => s.videoUrl ? i : -1)
REM        .filter(i => i >= 0) || []
REM    );
REM    // In processVideo: if (existingVideos.has(i)) return;
REM
REM  ESTIMATED SAVINGS: 11 DB reads eliminated.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-03: Two Retry Phases Read Same DB Row Separately
REM  File: src/hooks/generation/cinematicPipeline.ts, lines 232, 287
REM  Impact: LOW - 1 extra DB read
REM ============================================================================
REM
REM  CURRENT:
REM    retryMissingVideos() reads generations.scenes (line 232)
REM    retryMissingImages() reads generations.scenes (line 287)
REM    These run back-to-back sequentially.
REM
REM  FIX: Single read, shared between both retry functions:
REM
REM    const { data } = await supabase.from("generations")
REM      .select("scenes").eq("id", generationId).maybeSingle();
REM    const scenes = data?.scenes || [];
REM    const missingImages = scenes.filter((s, i) => !s.imageUrl).map(i);
REM    const missingVideos = scenes.filter((s, i) => !s.videoUrl).map(i);
REM    if (missingImages.length) await retryImages(missingImages);
REM    if (missingVideos.length) await retryVideos(missingVideos);
REM
REM  ESTIMATED SAVINGS: 1 DB read, ~100ms.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-04: Image Retry is Sequential (Should Be Parallel)
REM  File: src/hooks/generation/cinematicPipeline.ts, line 295
REM  Impact: MEDIUM - serializes retry with 15s cooldowns
REM ============================================================================
REM
REM  CURRENT: Missing images are retried one-by-one in a for loop with
REM  15s GLOBAL_COOLDOWN_MS between each. If 4 images failed:
REM    4 images * (15s cooldown + 10-60s generation) = 100-300s
REM
REM  FIX: Submit all retry jobs in parallel. Let the WORKER handle rate
REM  limiting (it already has per-API backoff logic):
REM
REM    const retryPromises = missingIndices.map(idx =>
REM      callPhase({ phase: "images", generationId, projectId, sceneIndex: idx })
REM    );
REM    await Promise.allSettled(retryPromises);
REM
REM  ESTIMATED SAVINGS: 45-240s for multi-image retry scenarios.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-05: Duplicate Polling System During Generation
REM  File: src/components/workspace/CinematicWorkspace.tsx, lines 145-168
REM  Impact: LOW - extra DB reads every 10s
REM ============================================================================
REM
REM  CURRENT: The workspace has a SECOND independent poll loop on the
REM  generations table (every 10 seconds) alongside the primary pipeline's
REM  own 2s job polling. Two separate mechanisms poll simultaneously.
REM
REM  The workspace poll is a mobile resilience fallback to detect worker
REM  completion when the browser was backgrounded (and the primary pipeline's
REM  WebSocket/poll was suspended by the OS).
REM
REM  FIX: Make the workspace poll only activate when the document becomes
REM  visible again (visibilitychange event), not continuously:
REM
REM    document.addEventListener("visibilitychange", () => {
REM      if (document.visibilityState === "visible" && isGenerating) {
REM        checkGenerationStatus(); // one-shot check on tab focus
REM      }
REM    });
REM
REM  ESTIMATED SAVINGS: ~6 DB reads/minute during generation.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-06: sleep(1200) Loop in Resume Pipeline (Dead Code?)
REM  File: src/hooks/generation/cinematicPipeline.ts, line 362
REM  Impact: LOW but suspicious
REM ============================================================================
REM
REM  CURRENT: Inside resumeCinematicPipeline audio processing:
REM    while (!audioComplete) {
REM      await sleep(1200);
REM      // re-check audio status
REM    }
REM
REM  This is a SECOND polling mechanism layered on top of the worker queue.
REM  workerCallPhase already blocks until the job completes. This while loop
REM  should never be needed.
REM
REM  FIX: Remove the while loop. Trust workerCallPhase to block until done.
REM  If the concern is timeout, increase the timeout parameter instead.
REM ============================================================================

REM ============================================================================
REM  OVERHEAD-07: 15s Global Cooldown Penalizes ALL Jobs for ONE 429
REM  File: src/hooks/generation/cinematicPipeline.ts, line 21
REM  Impact: HIGH - one rate limit delays all parallel image jobs
REM ============================================================================
REM
REM  CURRENT: GLOBAL_COOLDOWN_MS = 15000 is a MODULE-LEVEL variable.
REM  If ANY image or video job gets a 429 from Hypereal, lastRateLimitTime
REM  is set, and ALL subsequent jobs wait 15s before submitting.
REM
REM  PROBLEM: With 12 parallel image jobs, one 429 on scene 3 makes
REM  scenes 4-11 all wait 15s before even submitting. This creates a
REM  thundering herd after the cooldown expires.
REM
REM  FIX: Move rate limiting to the WORKER side (it already has per-API
REM  backoff in hypereal.ts). Remove the client-side global cooldown.
REM  The worker is better positioned to manage API rate limits because
REM  it has visibility into ALL concurrent requests, not just one client's.
REM
REM  ALTERNATIVE: Per-job cooldown instead of global:
REM    // Only the job that got 429 waits, others continue
REM    if (result.rateLimited) {
REM      await sleep(15000);
REM      return retryPhase(job);
REM    }
REM
REM  ESTIMATED SAVINGS: 15-45s per generation when rate limits hit.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #           PIPELINE ARCHITECTURE OPTIMIZATIONS                            #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  ARCH-01: Start Audio + Images IMMEDIATELY After Script (Already Done!)
REM  Status: ALREADY OPTIMIZED
REM ============================================================================
REM
REM  The pipeline already runs audio and visuals in parallel:
REM    const audioPromise = runCinematicAudio(...)
REM    const visualsPromise = runCinematicVisuals(...)
REM    await Promise.all([audioPromise, visualsPromise])
REM
REM  This is correct. No change needed.
REM ============================================================================

REM ============================================================================
REM  ARCH-02: Start Video Gen BEFORE All Images Complete (Streaming)
REM  Status: ALREADY OPTIMIZED
REM ============================================================================
REM
REM  Videos already start as soon as their image dependency resolves:
REM    await imagePromises[i];        // wait for this scene's image
REM    if (i < sceneCount - 1)
REM      await imagePromises[i + 1];  // wait for next scene's image (transition)
REM    // then immediately submit video job
REM
REM  This streaming dependency graph is well-designed. The only improvement
REM  is removing the i+1 dependency (see BOTTLENECK-01 Option C).
REM ============================================================================

REM ============================================================================
REM  ARCH-03: Use Supabase Realtime for ALL Phases (Not Just Export)
REM  File: src/hooks/useVideoExport.ts (already implements Realtime)
REM  Impact: HIGH - eliminate polling entirely
REM ============================================================================
REM
REM  CURRENT: Export phase uses Supabase Realtime WebSocket + fallback poll.
REM  ALL OTHER phases use polling-only (2s interval).
REM
REM  FIX: Create a generic useJobSubscription hook:
REM
REM    function useJobSubscription(jobId: string) {
REM      useEffect(() => {
REM        const channel = supabase
REM          .channel(`job_${jobId}`)
REM          .on("postgres_changes", {
REM            event: "UPDATE",
REM            schema: "public",
REM            table: "video_generation_jobs",
REM            filter: `id=eq.${jobId}`
REM          }, (payload) => {
REM            if (payload.new.status === "completed") resolve(payload.new);
REM            if (payload.new.status === "failed") reject(payload.new);
REM          })
REM          .subscribe();
REM        return () => supabase.removeChannel(channel);
REM      }, [jobId]);
REM    }
REM
REM  With Realtime, jobs complete instantly when the worker finishes.
REM  No 2s polling delay. No wasted DB reads.
REM
REM  Keep 15s fallback poll for Realtime connection drops.
REM
REM  ESTIMATED SAVINGS: 1000+ DB reads/generation, 1-3 min latency reduction.
REM ============================================================================

REM ============================================================================
REM  ARCH-04: Pre-Submit ALL Jobs at Generation Start (Server-Side Deps)
REM  Impact: HIGH - removes client as bottleneck
REM ============================================================================
REM
REM  CURRENT: Client orchestrates the pipeline step-by-step:
REM    1. Submit script job -> poll -> wait for completion
REM    2. Submit audio jobs -> poll -> wait
REM    3. Submit image jobs -> poll -> wait
REM    4. Submit video jobs (after images) -> poll -> wait
REM    5. Submit finalize job -> poll -> wait
REM
REM  If the user's browser tabs out, closes, or loses connection,
REM  the pipeline stalls because the CLIENT is the orchestrator.
REM
REM  PROPOSED: Submit ALL jobs at generation start with dependencies:
REM
REM    INSERT INTO video_generation_jobs VALUES
REM      (script_job, "generate_video", "pending", NULL),
REM      (audio_0, "cinematic_audio", "waiting", script_job),
REM      (audio_1, "cinematic_audio", "waiting", script_job),
REM      ...
REM      (image_0, "cinematic_image", "waiting", script_job),
REM      ...
REM      (video_0, "cinematic_video", "waiting", [image_0, image_1]),
REM      (video_1, "cinematic_video", "waiting", [image_1, image_2]),
REM      ...
REM      (finalize, "finalize_generation", "waiting", [all_videos, all_audio]),
REM      (export, "export_video", "waiting", finalize);
REM
REM  Worker logic: only claim jobs where ALL dependencies are "completed".
REM  Client becomes a read-only progress viewer, not an orchestrator.
REM
REM  BENEFITS:
REM    - Pipeline continues even if user closes browser
REM    - No client polling overhead
REM    - Worker handles all sequencing server-side
REM    - Natural retry: failed jobs don't block independent branches
REM
REM  ESTIMATED EFFORT: 2-3 days (add depends_on column, update claim_pending_job)
REM  ESTIMATED SAVINGS: 2-5 min (no client round-trips between phases)
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #               KLING-SPECIFIC OPTIMIZATIONS                               #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  KLING-01: Use Kling V3.0 Standard Instead of V2.6 Pro
REM  File: worker/src/services/hypereal.ts
REM  Impact: HIGH - potentially 2-3x faster generation
REM ============================================================================
REM
REM  CURRENT MODEL PRIORITY:
REM    Primary: kling-2-5-i2v (V2.5 Turbo, 35 credits)
REM    Fallback: kling-2-6-i2v-pro (V2.6 Pro, 35 credits)
REM
REM  AVAILABLE BUT NOT USED:
REM    kling-3-0-std-i2v (V3.0 Standard, 42 credits)
REM    - Supports native end_image transitions
REM    - Valid durations: 3, 5, 10, 15s
REM    - Reported 2-3x faster generation time
REM
REM  FIX: Change primary model in hypereal.ts:
REM    const DEFAULT_VIDEO_MODEL = "kling-3-0-std-i2v";
REM
REM  COST IMPACT: 42 vs 35 credits per scene (20% increase in Hypereal cost)
REM  TIME IMPACT: 30-60s per scene instead of 60-180s (potential 50%+ faster)
REM  NET EFFECT: Pay 20% more, generate 50-66% faster. Worth it.
REM ============================================================================

REM ============================================================================
REM  KLING-02: Use 5s Duration Instead of 10s Where Appropriate
REM  File: worker/src/handlers/handleCinematicVideo.ts
REM  Impact: MEDIUM - faster generation for shorter clips
REM ============================================================================
REM
REM  CURRENT: All scenes forced to 10s duration.
REM  Kling generates faster for shorter durations (5s vs 10s).
REM
REM  FIX: For "short" length videos, use 5s per scene instead of 10s.
REM  The script already specifies per-scene duration - respect it:
REM
REM    const duration = scene.duration <= 5 ? 5 : 10;
REM
REM  For a 12-scene "short" video, this cuts total Kling processing time
REM  roughly in half for scenes that don't need the full 10 seconds.
REM
REM  ESTIMATED SAVINGS: 30-60s per short video.
REM ============================================================================

REM ============================================================================
REM  KLING-03: Reduce Kling Polling Intervals in Worker
REM  File: worker/src/services/hypereal.ts, lines 272-357
REM  Impact: LOW - reduces API load, not generation time
REM ============================================================================
REM
REM  CURRENT:
REM    First 6 polls: 10s interval
REM    After 6 polls: 20s interval
REM    Max 40 polls (~13-15 min timeout)
REM
REM  These intervals are reasonable and don't affect actual generation time.
REM  The only optimization is using Hypereal webhooks (if supported) instead
REM  of polling. Check if Hypereal offers webhook callbacks on job completion.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                      STANDARD PIPELINE NOTES                             #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  The standard pipeline (doc2video, storytelling, smartflow) is SIMPLER:
REM    1. Script generation (worker job)
REM    2. Images in batches of 9 (worker job, parallel within batch)
REM    3. Audio in batches of 3 (worker job, parallel within batch)
REM    4. Finalize (worker job)
REM    5. Export (worker job)
REM
REM  NO video generation step (no Kling). This is why standard videos are
REM  much faster (5-10 minutes vs 20-30 minutes for cinematic).
REM
REM  Standard pipeline optimizations:
REM  - Same polling improvements apply (adaptive intervals)
REM  - Same Realtime WebSocket optimization applies
REM  - Image batch size of 9 is already good
REM  - Audio batch size of 3 could be increased (cinematic uses 5)
REM
REM  STANDARD-SPECIFIC ISSUES FOUND:
REM
REM  STD-01: Audio batch size is 3 (cinematic is 5). No technical reason
REM    for the difference. Raising to 5 or all-parallel saves 1-2 batch rounds.
REM    File: worker/src/handlers/handleAudio.ts (BATCH_SIZE = 3)
REM    FIX: Change BATCH_SIZE to 5 or remove batching entirely.
REM
REM  STD-02: Per-image FULL JSONB array overwrite in handleImages.ts
REM    Lines 192-209: After each single image completes, the worker writes
REM    the ENTIRE scenes[] array back to the generations table. With 9 images
REM    per batch, that's 9 sequential full-array writes of potentially large
REM    JSONB. The atomic update_scene_field RPC already exists in sceneUpdate.ts
REM    but handleImages doesn't use it.
REM    FIX: Use update_scene_field(generationId, sceneIndex, "imageUrl", url)
REM    instead of overwriting the entire scenes array per image.
REM    SAVINGS: ~80%% reduction in DB write volume for image phase.
REM
REM  STD-03: flushSceneProgress() does read-then-write per IMAGE (not per batch)
REM    File: worker/src/lib/sceneProgress.ts, lines 172-185
REM    Each image completion triggers a full read + write of the job payload.
REM    For 45 images (15 scenes * 3 each): 45 extra read+write pairs.
REM    FIX: Batch the flush to once-per-batch (not once-per-image).
REM    Set flush: false on individual updates, flush once after batch settles.
REM
REM  STD-04: Standard pipeline runs 2 image retry rounds (cinematic does 1)
REM    File: src/hooks/generation/standardPipeline.ts, line 123
REM    Cinematic was reduced to 1 round to prevent double-billing on timeouts.
REM    Standard still runs 2 rounds - same double-billing risk applies.
REM    FIX: Align to 1 retry round like cinematic.
REM
REM  STD-05: Image retry uses sequential do-while loop
REM    File: src/hooks/generation/standardPipeline.ts, lines 133-143
REM    do { await callPhase() } while (retryResult.hasMore) - each retry
REM    dispatches a new worker job and blocks. Should dispatch all missing
REM    batches in parallel.
REM
REM  STD-06: Export uses getUser() (network call) vs getSession() (local)
REM    File: src/hooks/useVideoExport.ts, line 179
REM    All other auth checks use getSession() (local storage, instant).
REM    Export uses getUser() which makes a live API request (~200-500ms).
REM    FIX: Change to getSession() for consistency and speed.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #               API COST CONSOLIDATION SUMMARY                             #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  CURRENT API SPEND (estimated per cinematic video):
REM
REM  Script (OpenRouter/Claude):     $0.003-0.01
REM  Images (Hypereal, 12 scenes):   $0.48 (12 * $0.04)
REM  Character refs (Hypereal, 2-4): $0.08-0.16
REM  Audio (TTS cascade):            $0.12-0.20
REM  Video (Kling, 12 scenes):       $4.20 (12 * $0.35)
REM  Export (compute only):          $0.00 (included in Render)
REM  ------------------------------------------------
REM  TOTAL PER VIDEO:                ~$5.00-5.10
REM
REM  AFTER CONSOLIDATION:
REM  Script:                         $0.003-0.01 (unchanged)
REM  Images:                         $0.48 (unchanged)
REM  Character refs:                 $0.00 (eliminated, reuse from script)
REM  Audio (2 providers max):        $0.12 (fewer fallback calls)
REM  Video (Kling V3.0):             $5.04 (12 * $0.42, 20% more)
REM  ------------------------------------------------
REM  TOTAL PER VIDEO:                ~$5.65
REM
REM  NET: ~$0.55 more per video but 40-50% FASTER generation.
REM  The time savings likely improves user retention more than the
REM  $0.55 cost increase matters.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                 PRIORITIZED ACTION PLAN                                  #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  PHASE 1: QUICK WINS (Day 1) - Save 3-8 minutes
REM  Estimated effort: 4-6 hours
REM ============================================================================
REM
REM  1. Remove end_image dependency for first pass (BOTTLENECK-01 Option C)
REM     - Each video starts when its OWN image is ready (not i+1)
REM     - Use FFmpeg crossfade for transitions in export step
REM     - Saves: 30-60s per scene = 3-5 min total
REM
REM  2. Fire ALL 12 audio jobs simultaneously (OVERHEAD-01)
REM     - Remove AUDIO_CONCURRENCY=5 batching
REM     - Saves: 15-40s
REM
REM  3. Single DB read for video skip-check (OVERHEAD-02)
REM     - Read generations.scenes once, not 12 times
REM     - Saves: ~500ms + 11 DB reads
REM
REM  4. Adaptive polling intervals (BOTTLENECK-02)
REM     - 15s for video, 5s for images, 3s for audio
REM     - Saves: 900+ DB reads, 1-2 min polling latency
REM
REM  5. Remove global cooldown, let worker handle rate limits (OVERHEAD-07)
REM     - Saves: 15-45s when rate limits occur

REM ============================================================================
REM  PHASE 2: MEDIUM EFFORT (Days 2-3) - Save 2-5 more minutes
REM  Estimated effort: 1-2 days
REM ============================================================================
REM
REM  1. Upgrade to Kling V3.0 Standard (KLING-01)
REM     - Change DEFAULT_VIDEO_MODEL in hypereal.ts
REM     - Test transition quality with native end_image
REM     - Saves: 2-5 min (50%+ faster Kling generation)
REM
REM  2. Consolidate TTS to 2 providers (REDUNDANCY-01)
REM     - Keep Lemonfox + Gemini. Remove Chatterbox + Fish Audio
REM     - Saves: 5-45s on fallback paths + maintenance
REM
REM  3. Eliminate character description re-processing (REDUNDANCY-02)
REM     - Cache from script phase, pass to image prompts
REM     - Saves: 10-30s + $0.08-0.16/generation
REM
REM  4. Use Supabase Realtime for all phases (ARCH-03)
REM     - Extend export's Realtime pattern to all job types
REM     - Saves: 1-3 min polling overhead

REM ============================================================================
REM  PHASE 3: MAJOR ARCHITECTURE (Week 2) - Save 2-5 more minutes
REM  Estimated effort: 2-3 days
REM ============================================================================
REM
REM  1. Server-side pipeline orchestration (ARCH-04)
REM     - Pre-submit all jobs with dependency graph
REM     - Client becomes read-only progress viewer
REM     - Pipeline survives browser close
REM     - Saves: 2-5 min client round-trip overhead
REM
REM  2. Parallel image retry (OVERHEAD-04)
REM     - Submit all retry jobs at once
REM     - Saves: 45-240s for retry scenarios
REM
REM  3. Respect per-scene duration for Kling (KLING-02)
REM     - Use 5s for short scenes, 10s for long
REM     - Saves: 30-60s for short videos


REM ############################################################################
REM #                                                                          #
REM #                 WHAT'S ALREADY WELL OPTIMIZED                            #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  These are GOOD patterns - do NOT change:
REM
REM  1. Audio + Visuals run in parallel (Promise.all) - CORRECT
REM  2. Videos start as soon as image dependencies resolve (streaming) - CORRECT
REM  3. Atomic job claiming (FOR UPDATE SKIP LOCKED) - CORRECT
REM  4. Worker auto-tunes concurrency based on container memory - CORRECT
REM  5. Credit refund on job failure - CORRECT
REM  6. Epoch-based stale pipeline prevention - CORRECT
REM  7. Export uses Realtime WebSocket + fallback poll - CORRECT
REM  8. Worker priority: export jobs claimed first - CORRECT
REM  9. Graceful shutdown with 5-min drain - CORRECT
REM  10. No artificial delays in worker (no sleep padding) - CORRECT
REM  11. Image batch of 9 in standard pipeline - REASONABLE
REM  12. Kling adaptive polling (10s fast / 20s slow) - REASONABLE
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #              EXPECTED RESULTS AFTER ALL OPTIMIZATIONS                    #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM
REM  BEFORE (current 12-scene cinematic):
REM  ====================================
REM  Script:    30-90s
REM  Audio:     60-90s  (3 batches of 5)
REM  Images:    60-120s (parallel but global cooldown)
REM  Videos:    5-20min (Kling V2.5/V2.6, image dependency chain)
REM  Finalize:  5-15s
REM  Export:    2-10min
REM  Overhead:  1-3min  (polling, round-trips)
REM  -----------
REM  TOTAL:     10-30 MINUTES
REM
REM
REM  AFTER Phase 1+2 optimizations:
REM  ==============================
REM  Script:    30-90s   (unchanged - LLM bound)
REM  Audio:     15-30s   (all 12 parallel, 2 providers)
REM  Images:    30-60s   (no global cooldown, parallel)
REM  Videos:    3-8min   (Kling V3.0, no i+1 dependency)
REM  Finalize:  5-15s    (unchanged)
REM  Export:    2-10min  (unchanged - FFmpeg bound)
REM  Overhead:  10-30s   (Realtime, adaptive polling)
REM  -----------
REM  TOTAL:     6-15 MINUTES (40-50%% faster)
REM
REM
REM  AFTER Phase 3 (server-side orchestration):
REM  ==========================================
REM  Script:    30-90s
REM  Audio:     15-30s   (overlapped with images)
REM  Images:    30-60s   (overlapped with audio)
REM  Videos:    3-8min   (starts immediately as images complete)
REM  Finalize:  5-15s
REM  Export:    2-10min  (starts immediately after finalize)
REM  Overhead:  ~0s      (server-side, no client round-trips)
REM  -----------
REM  TOTAL:     5-12 MINUTES (50-60%% faster)
REM
REM  NOTE: Kling video generation is the hard floor. Even with all
REM  optimizations, you cannot go faster than Kling's processing time.
REM  The only way to beat ~3-5 min floor is to switch to a faster
REM  video generation service (when one becomes available).
REM
REM ============================================================================

echo.
echo  =====================================================
echo   MOTIONMAX PIPELINE PERFORMANCE REPORT
echo  =====================================================
echo.
echo   #1 Bottleneck: Kling I2V video generation (60-80%% of time)
echo.
echo   Current:   10-30 minutes per cinematic video
echo   After Ph1: 6-15 minutes  (quick wins, Day 1)
echo   After Ph2: 5-12 minutes  (Kling V3.0 + consolidation)
echo   After Ph3: 5-10 minutes  (server-side orchestration)
echo.
echo   Hard floor: ~3-5 min (Kling processing time, cannot optimize)
echo.
echo   Key optimizations:
echo   - Remove end_image dependency (saves 3-5 min)
echo   - Upgrade to Kling V3.0 (saves 2-5 min)
echo   - Fire all audio in parallel (saves 15-40s)
echo   - Adaptive polling / Realtime (saves 1-3 min)
echo   - Server-side orchestration (saves 2-5 min)
echo.
echo   Open this file in a text editor for full details.
echo  =====================================================
echo.
pause
