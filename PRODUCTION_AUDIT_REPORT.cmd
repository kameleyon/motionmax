@echo off
REM ============================================================================
REM  MOTIONMAX PRODUCTION READINESS AUDIT REPORT
REM  Generated: 2026-04-06
REM  Audited by: 5 Specialized AI Agents (Code Quality, Silent Failures,
REM              Type Design, Dead Code, Architecture)
REM  Codebase: C:\Users\Administrator\motionmax
REM  Stack: React 18 + TypeScript + Vite + Supabase + TanStack Query + shadcn/ui
REM ============================================================================
REM
REM  HOW TO USE THIS FILE:
REM  - Read each finding, understand the problem, apply the fix
REM  - Issues are ordered: CRITICAL > HIGH > MEDIUM > LOW
REM  - Each fix includes the exact file, line, and code solution
REM  - Search for "FIX:" to jump between solutions
REM  - Search for "CRITICAL", "HIGH", "MEDIUM", "LOW" to filter by priority
REM
REM ============================================================================
REM
REM  SUMMARY SCORECARD
REM  -----------------
REM  CRITICAL:  11 issues  (must fix before production)
REM  HIGH:      23 issues  (fix within 1 week)
REM  MEDIUM:    19 issues  (fix within 2 weeks)
REM  LOW:       12 issues  (fix when convenient)
REM  TOTAL:     65 issues
REM
REM ============================================================================

REM ############################################################################
REM #                                                                          #
REM #                    SECTION 1: CRITICAL ISSUES (11)                       #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  CRITICAL-01: Open Redirect Vulnerability
REM  File: src\pages\Auth.tsx, line 71
REM  Agent: Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: returnUrl is read from query string and passed to navigate()
REM  without validation. Attacker can craft /auth?returnUrl=https://evil.com
REM  and redirect users after login.
REM
REM  IMPACT: Phishing attacks, credential theft via lookalike pages.
REM
REM  FIX: Replace line 71 in Auth.tsx:
REM
REM  BEFORE:
REM    const returnUrl = searchParams.get("returnUrl") || "/app";
REM
REM  AFTER:
REM    const rawReturnUrl = searchParams.get("returnUrl") || "/app";
REM    const returnUrl = rawReturnUrl.startsWith("/") && !rawReturnUrl.startsWith("//")
REM      ? rawReturnUrl
REM      : "/app";
REM
REM  COST: 0 - pure code change, no libraries needed.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-02: Credits Deducted Client-Side With No Refund Path
REM  File: src\hooks\generation\callPhase.ts, lines 12-33, 182-186
REM  Agent: Code Quality Reviewer + Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: deductCreditsUpfront() debits credits BEFORE the worker job is
REM  inserted. If workerCallPhase() fails (network, DB error), credits are
REM  lost permanently. The deducted amount is returned but NEVER used for
REM  refund. This is billing logic in a transport layer.
REM
REM  IMPACT: Users permanently lose credits on any generation failure between
REM  deduction and job queue insertion.
REM
REM  FIX (Option A - Recommended): Move credit deduction server-side.
REM  The worker already has a refund mechanism. Remove deductCreditsUpfront()
REM  from callPhase.ts entirely and let the worker deduct credits atomically
REM  when it picks up the job.
REM
REM  FIX (Option B - Quick): Add refund path in callPhase.ts:
REM
REM    // In the script phase branch (line ~182):
REM    let deductedAmount = 0;
REM    try {
REM      deductedAmount = await deductCreditsUpfront(body, supabase);
REM      const result = await workerCallPhase(body, timeoutMs);
REM      return result;
REM    } catch (err) {
REM      if (deductedAmount > 0) {
REM        await supabase.rpc("refund_credits", {
REM          p_user_id: (await supabase.auth.getSession()).data.session?.user?.id,
REM          p_amount: deductedAmount
REM        }).catch(refundErr => log.error("CRITICAL: Refund failed", refundErr));
REM      }
REM      throw err;
REM    }
REM
REM  COST: 0 - pure code change. Server-side option requires worker modification.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-03: CREDIT_PACKAGES Has Empty priceId - Stripe Checkout Breaks
REM  File: src\config\pricingPlans.ts, lines 23-25
REM  Agent: Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: All CREDIT_PACKAGES entries have priceId: "". When users click
REM  "Buy Credits", createCheckout receives empty string -> Stripe API error.
REM  The actual price IDs exist in src/config/stripeProducts.ts as CREDIT_PACKS.
REM
REM  IMPACT: Credit top-up purchases are completely broken. Zero revenue from
REM  credit pack sales.
REM
REM  FIX: In src/config/pricingPlans.ts, replace CREDIT_PACKAGES:
REM
REM    import { CREDIT_PACKS } from "@/config/stripeProducts";
REM
REM    export const CREDIT_PACKAGES = [
REM      {
REM        credits: 300,
REM        price: CREDIT_PACKS[300].amount / 100,
REM        priceId: CREDIT_PACKS[300].priceId,
REM        label: "Starter Pack"
REM      },
REM      {
REM        credits: 900,
REM        price: CREDIT_PACKS[900].amount / 100,
REM        priceId: CREDIT_PACKS[900].priceId,
REM        label: "Creator Pack"
REM      },
REM      {
REM        credits: 2500,
REM        price: CREDIT_PACKS[2500].amount / 100,
REM        priceId: CREDIT_PACKS[2500].priceId,
REM        label: "Studio Pack"
REM      }
REM    ];
REM
REM  COST: 0 - uses existing stripeProducts.ts data.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-04: Export Video Errors Silently Swallowed (7 instances)
REM  Files: src\components\workspace\GenerationResult.tsx (lines 114, 158, 165)
REM         src\components\workspace\CinematicResult.tsx (lines 212, 223)
REM         src\components\workspace\SmartFlowResult.tsx (lines 96, 136, 146)
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: Every exportVideo() call ends with .catch(() => {}). If export
REM  fails before the hook's internal error state is set (auth failure, DB
REM  insert failure), the error is completely lost. User clicks Export,
REM  spinner appears, then nothing happens.
REM
REM  IMPACT: Users cannot export videos and receive zero feedback about why.
REM
REM  FIX: In ALL 7 locations, replace .catch(() => {}) with:
REM
REM    .catch((err) => {
REM      log.error("Export failed:", err);
REM      toast.error("Export failed", {
REM        description: err?.message || "Please try again"
REM      });
REM    });
REM
REM  COST: 0 - pure code change, toast already imported in all files.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-05: Cinematic Audio Failures Silently Dropped
REM  File: src\hooks\generation\cinematicPipeline.ts, lines 121-128, 357-361
REM  Agent: Silent Failure Hunter + Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: Promise.allSettled(batch) results are NEVER inspected. If 3/12
REM  audio scenes fail (TTS API error, rate limit, quota), pipeline continues.
REM  User gets "Generation Complete!" with silent scenes. Same in resume path.
REM
REM  IMPACT: Users pay credits and receive videos with missing voiceover.
REM
REM  FIX: After each Promise.allSettled call, add:
REM
REM    const results = await Promise.allSettled(batch);
REM    const failures = results.filter(r => r.status === "rejected");
REM    if (failures.length > 0) {
REM      log.warn(`${failures.length}/${batch.length} audio scenes failed`, {
REM        errors: failures.map(f => (f as PromiseRejectedResult).reason?.message)
REM      });
REM    }
REM    if (failures.length === batch.length) {
REM      throw new Error(`All ${batch.length} audio scenes failed in batch`);
REM    }
REM
REM  COST: 0 - pure code change.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-06: Image Phase Returns Fake Success on Failure
REM  File: src\hooks\generation\standardPipeline.ts, lines 83-94
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: When image phase fails, catch returns { totalImages: N,
REM  imagesGenerated: 0 } - a fabricated "success". Pipeline continues to
REM  finalization. User sees "Generation Complete!" with zero images.
REM
REM  IMPACT: Users pay credits, wait minutes, receive image-less video.
REM
REM  FIX: Replace the catch block:
REM
REM  BEFORE:
REM    } catch (err) {
REM      log.warn("Image phase error:", err);
REM      return { totalImages: expectedSceneCount * 3, imagesGenerated: 0 };
REM    }
REM
REM  AFTER:
REM    } catch (err) {
REM      log.error("Image phase failed:", err);
REM      throw new Error("Image generation failed. Please try again.");
REM    }
REM
REM  COST: 0 - pure code change.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-07: strictNullChecks Disabled - Zero Null Safety
REM  File: tsconfig.json (root)
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: Root tsconfig.json has:
REM    "noImplicitAny": false
REM    "strictNullChecks": false
REM    "noUnusedLocals": false
REM    "noUnusedParameters": false
REM  This means TypeScript provides essentially NO type safety. null/undefined
REM  access errors will only be caught at runtime. Combined with eslint
REM  no-unused-vars: off, dead code accumulates silently.
REM
REM  IMPACT: Runtime crashes from null access. Dead code never detected.
REM  Every type annotation is decoration, not enforcement.
REM
REM  FIX: Enable strict checks incrementally:
REM
REM  Step 1 (immediate): In tsconfig.json:
REM    "strictNullChecks": true
REM
REM  Step 2 (fix ~50-100 type errors that surface):
REM    Run: npx tsc --noEmit 2>&1 | head -200
REM    Fix each null access with optional chaining or null guards.
REM
REM  Step 3 (after stabilizing):
REM    "noImplicitAny": true
REM    "noUnusedLocals": true
REM
REM  Step 4: In eslint.config.js:
REM    "@typescript-eslint/no-unused-vars": "warn"
REM
REM  COST: 0 - config change + ~2-4 hours fixing type errors.
REM  TOOL: TypeScript compiler (already installed).
REM ============================================================================

REM ============================================================================
REM  CRITICAL-08: callPhase Returns Promise<any> - Pipeline Untyped
REM  File: src\hooks\generation\callPhase.ts, lines 95, 126, 175, 236
REM         src\hooks\generation\types.ts, line 122
REM  Agent: Type Design Analyzer
REM ============================================================================
REM
REM  PROBLEM: The entire generation pipeline's core function returns
REM  Promise<any>. Every caller accesses .success, .error, .scenes,
REM  .videoUrl, .generationId without compile-time checks. A typo like
REM  result.sucess silently compiles.
REM
REM  IMPACT: Typos and missing field access cause runtime undefined errors
REM  with no TypeScript warning.
REM
REM  FIX: In src/hooks/generation/types.ts, add:
REM
REM    interface PhaseSuccessBase {
REM      success: true;
REM      costTracking?: CostTracking;
REM      phaseTime?: number;
REM    }
REM    interface ScriptResult extends PhaseSuccessBase {
REM      projectId: string;
REM      generationId: string;
REM      title: string;
REM      sceneCount: number;
REM      totalImages: number;
REM    }
REM    interface AudioResult extends PhaseSuccessBase {
REM      audioGenerated: number;
REM    }
REM    interface ImagesResult extends PhaseSuccessBase {
REM      totalImages: number;
REM      imagesGenerated: number;
REM      progress?: number;
REM      hasMore?: boolean;
REM      nextStartIndex?: number;
REM    }
REM    interface PhaseError {
REM      success: false;
REM      error: string;
REM    }
REM    export type PhaseResult =
REM      | ScriptResult | AudioResult | ImagesResult | PhaseError;
REM
REM  Then change callPhase return type from any to PhaseResult.
REM
REM  COST: 0 - pure type definitions.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-09: Logger Split - Sentry Never Receives App Errors
REM  Files: src\lib\logger.ts, src\lib\structuredLogger.ts, src\lib\sentry.ts
REM  Agent: Architecture Auditor + Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: Two parallel logging systems exist:
REM  - logger.ts (createScopedLogger) - used by ALL hooks and components
REM  - structuredLogger.ts (slog) - wired to Sentry via registerErrorSink
REM  The app logs via createScopedLogger but Sentry only receives slog calls.
REM  Result: ZERO application errors reach Sentry in production.
REM
REM  IMPACT: Production error monitoring is completely blind. Sentry dashboard
REM  shows no errors even when users experience failures.
REM
REM  FIX: Bridge createScopedLogger to Sentry. In src/lib/logger.ts:
REM
REM    import * as Sentry from "@sentry/react";
REM
REM    // In the error method of createScopedLogger:
REM    error: (...args: unknown[]) => {
REM      console.error(`[${scope}]`, ...args);
REM      if (import.meta.env.PROD) {
REM        Sentry.captureException(
REM          args[0] instanceof Error ? args[0] : new Error(String(args[0])),
REM          { tags: { scope }, extra: { args: args.slice(1) } }
REM        );
REM      }
REM    }
REM
REM  ALTERNATIVE: Remove structuredLogger.ts entirely and wire Sentry
REM  directly into logger.ts. Single logging system = no confusion.
REM
REM  COST: 0 - Sentry SDK already installed (@sentry/react 10.45.0).
REM ============================================================================

REM ============================================================================
REM  CRITICAL-10: Supabase Anon Key Hardcoded + Duplicate Project Reference
REM  Files: src\integrations\supabase\client.ts, line 11
REM          src\lib\supabaseUrl.ts, line 12
REM  Agent: Architecture Auditor + Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: The Supabase anon JWT and project URL are hardcoded in source.
REM  The project reference "ayjbvcikuwknqdrpsdmj" is duplicated in TWO files
REM  (client.ts and supabaseUrl.ts). Key cannot be rotated without code deploy.
REM
REM  IMPACT: Key rotation requires code change + deploy. Duplicate references
REM  can silently diverge during migration.
REM
REM  FIX: In src/integrations/supabase/client.ts:
REM
REM    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
REM    const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
REM    if (!SUPABASE_URL || !SUPABASE_KEY) {
REM      throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY");
REM    }
REM
REM  In src/lib/supabaseUrl.ts, import from client.ts instead of
REM  re-defining the project reference. Single source of truth.
REM
REM  COST: 0 - env vars already exist in .env, just remove hardcoded fallbacks.
REM ============================================================================

REM ============================================================================
REM  CRITICAL-11: Subscription Silently Downgrades Paying Users to Free
REM  File: src\hooks\useSubscription.ts, lines 56-96
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: fetchSubscriptionFromDB() returns FREE_STATE on ANY error. If
REM  both edge function AND DB query fail (Supabase outage), a paying
REM  Professional user is silently treated as Free. They get blocked from
REM  cinematic generation with "Upgrade required" even though they already paid.
REM
REM  IMPACT: Paying customers told to upgrade. May cancel subscription thinking
REM  their payment wasn't processed.
REM
REM  FIX: Add error state to the hook:
REM
REM    const [fetchError, setFetchError] = useState<string | null>(null);
REM
REM    // In fetchSubscriptionFromDB catch:
REM    } catch (err) {
REM      log.error("Subscription fetch failed:", err);
REM      setFetchError("Unable to verify subscription");
REM      return FREE_STATE; // still fallback, but UI can show warning
REM    }
REM
REM    // Return fetchError from the hook:
REM    return { ...state, fetchError };
REM
REM  In workspace components, show:
REM    {fetchError && <Banner variant="warning">
REM      Unable to verify your subscription. Some features may be limited.
REM    </Banner>}
REM
REM  COST: 0 - pure code change.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                      SECTION 2: HIGH ISSUES (23)                         #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  HIGH-01: toast.success() Used for Error Messages (3 instances)
REM  File: src\pages\Pricing.tsx, lines 58-59, 69, 86
REM  Agent: Code Quality Reviewer + Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: Error conditions use toast.success() with variant:"destructive".
REM  Sonner ignores variant on toast.success() - always shows GREEN toast.
REM  Users see green checkmark saying "Error: Failed to open billing portal".
REM
REM  FIX: Replace all three instances:
REM    toast.success("Error", ...) -> toast.error("Error", ...)
REM    toast.success("Sign in required", ...) -> toast.error("Sign in required", ...)
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-02: Workspace.tsx is 100% Dead Code (Never Imported)
REM  File: src\components\workspace\Workspace.tsx (entire file)
REM  Agent: Code Quality Reviewer + Dead Code Finder
REM ============================================================================
REM
REM  PROBLEM: The original monolithic Workspace component is never imported.
REM  App uses WorkspaceRouter -> Doc2Video/Storytelling/SmartFlow/Cinematic.
REM  Workspace.tsx duplicates the entire doc2video workspace with OLD patterns.
REM
REM  FIX: Delete src/components/workspace/Workspace.tsx
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-03: WorkspaceHandle Defined in 3 Separate Files
REM  Files: src\components\workspace\Doc2VideoWorkspace.tsx (line 32)
REM         src\components\workspace\SmartFlowWorkspace.tsx (line 32)
REM         src\components\workspace\Workspace.tsx (line 33)
REM  Agent: Code Quality Reviewer
REM ============================================================================
REM
REM  FIX: Create src/components/workspace/types.ts:
REM    export interface WorkspaceHandle {
REM      handleGenerate: () => void;
REM      handleNewProject: () => void;
REM      handleOpenProject: (id: string) => void;
REM    }
REM  Import from there in all workspace files.
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-04: (gen as any)?.video_url - Stale Supabase Types
REM  Files: src\components\workspace\CinematicResult.tsx (line 197)
REM         src\components\workspace\GenerationResult.tsx (line 147)
REM         src\components\workspace\SmartFlowResult.tsx (line 127)
REM  Agent: Type Design Analyzer
REM ============================================================================
REM
REM  PROBLEM: Three components cast generation objects to any to access
REM  video_url. Indicates Supabase types are stale/don't include video_url.
REM
REM  FIX: Regenerate Supabase types:
REM    npx supabase gen types typescript --project-id ayjbvcikuwknqdrpsdmj > src/integrations/supabase/types.ts
REM
REM  COST: 0 - Supabase CLI (npx supabase, free).
REM ============================================================================

REM ============================================================================
REM  HIGH-05: Scene vs CinematicScene - Duplicated Types Causing as-any Casts
REM  Files: src\hooks\generation\types.ts (Scene, lines 17-30)
REM         src\hooks\useCinematicRegeneration.ts (CinematicScene, lines 9-17)
REM  Agent: Type Design Analyzer
REM ============================================================================
REM
REM  PROBLEM: Two overlapping interfaces for the same concept. CinematicScene
REM  is a subset of Scene but defined independently. This mismatch causes
REM  as-any casts in CinematicResult.tsx line 169.
REM
REM  FIX: In useCinematicRegeneration.ts, replace CinematicScene with:
REM    import { Scene } from "@/hooks/generation/types";
REM    type CinematicScene = Pick<Scene,
REM      "number" | "voiceover" | "visualPrompt" | "videoUrl" | "audioUrl" | "imageUrl" | "duration"
REM    >;
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-06: GenerationParams Uses string Where Literal Unions Exist
REM  File: src\hooks\generation\types.ts, lines 69-92
REM  Agent: Type Design Analyzer
REM ============================================================================
REM
REM  PROBLEM: format, length, style, etc. are typed as string but have
REM  existing literal union types (VideoFormat, VideoLength, VisualStyle).
REM  Same issue in ProjectRow (lines 94-114).
REM
REM  FIX: Create src/types/domain.ts with all shared literal unions:
REM
REM    export type VideoFormat = "landscape" | "portrait" | "square";
REM    export type VideoLength = "short" | "brief" | "presentation";
REM    export type ProductId = "doc2video" | "storytelling" | "smartflow" | "cinematic";
REM    // ... VisualStyle, SpeakerVoice, Language, etc.
REM
REM  Then update GenerationParams and ProjectRow to use these types.
REM  Re-export from current locations to avoid breaking imports.
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-07: loadProject Captures Stale state.sceneCount - Polling Storm
REM  File: src\hooks\useGenerationPipeline.ts, lines 207-224
REM  Agent: Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: loadProject useCallback depends on [state.sceneCount]. Each
REM  sceneCount change recreates loadProject, which triggers useEffect in
REM  Doc2VideoWorkspace to tear down and restart setInterval. During generation
REM  this creates tens of concurrent DB polls.
REM
REM  FIX: Use a ref for sceneCount:
REM    const sceneCountRef = useRef(state.sceneCount);
REM    sceneCountRef.current = state.sceneCount;
REM    // In loadProject, read sceneCountRef.current instead of state.sceneCount
REM    // Remove state.sceneCount from useCallback deps
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-08: Checkout Failures Have No User Feedback (3 components)
REM  Files: src\components\workspace\CharacterConsistencyToggle.tsx (39-48)
REM         src\components\modals\SubscriptionSuspendedModal.tsx (28-42)
REM         src\components\modals\UpgradeRequiredModal.tsx (37-43)
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: createCheckout() and openCustomerPortal() failures only log.error.
REM  User clicks "Upgrade" or "Update Payment" - spinner appears, vanishes.
REM  No feedback whatsoever.
REM
REM  FIX: Add in each catch block:
REM    toast.error("Failed to open checkout. Please try again or contact support.");
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-09: Style Reference Upload Failures Silent (2 components)
REM  Files: src\components\workspace\SmartFlowStyleSelector.tsx (132-138)
REM         src\components\workspace\StyleSelector.tsx (136-142)
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  FIX: Add in catch block:
REM    toast.error("Failed to upload style reference. Please try a different image.");
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-10: Admin Subscriber List Fetches ALL Rows - No Server Pagination
REM  File: src\lib\adminDirectQueries.ts, lines 81-98
REM  Agent: Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: fetchSubscribersList loads ALL profiles, subscriptions, credits,
REM  generations, flags, and costs in 6 parallel queries with no .limit() or
REM  .range(). Paginates in-memory. As user base grows -> browser OOM.
REM
REM  FIX: Add server-side pagination:
REM    const { data: profiles } = await supabase
REM      .from("profiles")
REM      .select("*")
REM      .range((page - 1) * limit, page * limit - 1)
REM      .order("created_at", { ascending: false });
REM
REM  Then filter other queries by the fetched user IDs only.
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-11: useEffect Calls Stale Closures Without Dependencies (4 files)
REM  Files: src\components\workspace\Doc2VideoWorkspace.tsx (line 111)
REM         src\components\workspace\CinematicWorkspace.tsx (line 99)
REM         src\components\workspace\StorytellingWorkspace.tsx (line 90)
REM         src\components\workspace\SmartFlowWorkspace.tsx (line 80)
REM  Agent: Code Quality Reviewer
REM ============================================================================
REM
REM  PROBLEM: Mount-only useEffects call loadDraft/handleOpenProject with
REM  eslint-disable suppressed. Functions capture stale closures.
REM
REM  FIX: Read from localStorage directly in useState initializer:
REM    const [draft] = useState(() => {
REM      try { return JSON.parse(localStorage.getItem(storageKey) || "null"); }
REM      catch { return null; }
REM    });
REM  This eliminates the useEffect entirely.
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-12: Cinematic Video Retry Errors Swallowed
REM  File: src\hooks\generation\cinematicPipeline.ts, line 232
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  FIX: Replace .catch(() => {}) with:
REM    .catch((err) => log.warn("Video retry failed for scene:", err))
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-13: Image Download Failures Silently Skipped in Zip
REM  File: src\hooks\useImagesZipDownload.ts, lines 63-77
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  FIX: After zip generation, notify user:
REM    if (failedCount > 0) {
REM      toast.warning(`${failedCount} images could not be downloaded`);
REM    }
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-14: useAuth Swallows Session Restore Error
REM  File: src\hooks\useAuth.ts, lines 12-18
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: getSession().catch(() => { setLoading(false) }) - if Supabase
REM  is down, user is silently treated as logged out. No error indication.
REM
REM  FIX:
REM    .catch((err) => {
REM      log.error("Failed to restore session:", err);
REM      setLoading(false);
REM      setAuthError("Connection issue. Please refresh.");
REM    });
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-15: Attachment Upload Returns null - Failures Hidden
REM  File: src\lib\attachmentProcessor.ts, lines 86-112
REM  Agent: Silent Failure Hunter
REM ============================================================================
REM
REM  PROBLEM: Upload failures return null instead of throwing. User's source
REM  image is silently dropped. Generation proceeds without reference image.
REM  Also uses raw console.warn instead of createScopedLogger.
REM
REM  FIX: Throw on failure:
REM    throw new Error("Failed to upload attachment. Please try again.");
REM
REM  Replace console.warn with:
REM    const log = createScopedLogger("attachmentProcessor");
REM    log.warn(...);
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-16: No Code Splitting / Lazy Loading
REM  File: src\App.tsx
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: Entire app including admin dashboard, pricing, landing page,
REM  and heavy deps (recharts ~45KB, framer-motion ~100KB) ships in initial
REM  bundle. No React.lazy() on routes.
REM
REM  FIX: In App.tsx, lazy-load all routes:
REM
REM    const Admin = React.lazy(() => import("@/pages/Admin"));
REM    const Pricing = React.lazy(() => import("@/pages/Pricing"));
REM    const Landing = React.lazy(() => import("@/pages/Landing"));
REM    // ... etc for all pages
REM
REM    // Wrap in Suspense:
REM    <Suspense fallback={<PageLoader />}>
REM      <Route path="/admin" element={<Admin />} />
REM    </Suspense>
REM
REM  NOTE: The agent found lazy imports already exist but verify they are
REM  actually used in route definitions (not just imported).
REM
REM  COST: 0 - React.lazy is built-in.
REM ============================================================================

REM ============================================================================
REM  HIGH-17: Duplicate DOMPurify Packages
REM  File: package.json
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: Both dompurify (^3.3.3) and isomorphic-dompurify (^3.7.1) are
REM  installed. isomorphic-dompurify wraps dompurify for SSR. This is a
REM  client-only SPA - no SSR needed.
REM
REM  FIX:
REM    npm uninstall isomorphic-dompurify
REM
REM  Keep dompurify. If isomorphic-dompurify is imported anywhere, replace
REM  with: import DOMPurify from "dompurify";
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-18: tailwind.config.ts Referenced but Missing - shadcn CLI Broken
REM  File: components.json
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: components.json references tailwind.config.ts but file doesn't
REM  exist. Running npx shadcn add <component> will fail.
REM
REM  FIX: Verify the actual tailwind config filename and update components.json
REM  to match. If using tailwind.config.js, update the reference.
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-19: legacyCallPhase References Non-Existent Edge Functions
REM  File: src\hooks\generation\callPhase.ts, line 233
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: The legacy fallback path calls Supabase edge functions that no
REM  longer exist in the repo (moved to worker). Any unrecognized phase name
REM  silently routes to dead edge functions.
REM
REM  FIX: Add phase type guard at top of callPhase:
REM
REM    const VALID_PHASES = ["script","audio","images","video","finalize"] as const;
REM    type Phase = typeof VALID_PHASES[number];
REM    if (!VALID_PHASES.includes(body.phase as Phase)) {
REM      throw new Error(`Unknown phase: ${body.phase}`);
REM    }
REM
REM  Consider removing legacyCallPhase entirely if all phases now use worker.
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-20: Unvalidated DB-to-Domain Type Casts (2 workspace files)
REM  Files: src\components\workspace\CinematicWorkspace.tsx (259-281)
REM         src\components\workspace\Doc2VideoWorkspace.tsx (219-269)
REM  Agent: Type Design Analyzer
REM ============================================================================
REM
REM  PROBLEM: Database strings cast to domain types without validation:
REM    (project.format as VideoFormat)
REM  If DB contains "widescreen", TypeScript lies about it being valid.
REM
REM  FIX: Create validation functions (like existing normalizePlanName):
REM
REM    function toVideoFormat(s: string | null): VideoFormat {
REM      if (s === "landscape" || s === "portrait" || s === "square") return s;
REM      return "portrait"; // safe default
REM    }
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-21: Direct Supabase Client Access in ~20 Files (No Repository Layer)
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  PROBLEM: supabase client imported directly in ~20 files bypassing
REM  databaseService.ts. If schema changes, no single file to update.
REM  databaseService.ts exists but nothing uses it.
REM
REM  FIX: This is a larger refactor. Start by routing new code through
REM  databaseService.ts. Gradually migrate existing direct calls.
REM  Priority: callPhase.ts, useVideoExport.ts, useSubscription.ts.
REM
REM  COST: 0 - databaseService.ts already exists.
REM ============================================================================

REM ============================================================================
REM  HIGH-22: eslint no-unused-vars Disabled - Dead Code Accumulates
REM  File: eslint.config.js
REM  Agent: Architecture Auditor
REM ============================================================================
REM
REM  FIX: Change "@typescript-eslint/no-unused-vars": "off" to "warn"
REM
REM  COST: 0
REM ============================================================================

REM ============================================================================
REM  HIGH-23: Credit Pack Prices Defined 3x (No Single Source of Truth)
REM  Files: src\config\products.ts (CREDIT_PACK_PRICES)
REM         src\config\stripeProducts.ts (CREDIT_PACKS)
REM         src\config\pricingPlans.ts (CREDIT_PACKAGES)
REM  Agent: Code Quality Reviewer + Type Design Analyzer
REM ============================================================================
REM
REM  FIX: Keep CREDIT_PACKS in stripeProducts.ts as the single source.
REM  Derive the other two from it. See CRITICAL-03 fix.
REM
REM  COST: 0
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                     SECTION 3: MEDIUM ISSUES (19)                        #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  MEDIUM-01: Log State Arrays Typed as any[]
REM  Files: src\hooks\useAdminLogs.ts (line 10)
REM         src\hooks\useGenerationLogs.ts (line 13)
REM  Agent: Type Design Analyzer
REM ============================================================================
REM
REM  FIX: Define in src/types/domain.ts:
REM    interface SystemLogEntry {
REM      id: string;
REM      created_at: string;
REM      message: string;
REM      category?: string;
REM      event_type?: string;
REM    }
REM  Replace any[] with SystemLogEntry[].
REM ============================================================================

REM ============================================================================
REM  MEDIUM-02: QueueJob.payload Typed as any
REM  File: src\components\admin\AdminQueueMonitor.tsx (line 34)
REM  FIX: Change to Record<string, unknown> at minimum.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-03: adminDirectQuery Casts All Params to any
REM  File: src\lib\adminDirectQueries.ts (lines 380-389)
REM  FIX: Use discriminated union on action string (see Type Design report).
REM ============================================================================

REM ============================================================================
REM  MEDIUM-04: GenerationProgress.tsx Unnecessary as-any on Own State
REM  File: src\components\workspace\GenerationProgress.tsx (lines 148, 218)
REM  FIX: Remove (state as any).etaSeconds - etaSeconds already exists on type.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-05: SmartFlowResult.tsx Unnecessary format as-any Cast
REM  File: src\components\workspace\SmartFlowResult.tsx (lines 96, 136, 146)
REM  FIX: Remove as-any. VideoFormat is already the correct type.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-06: SubscriptionStatus is string | null (Should Be Union)
REM  File: src\hooks\useSubscription.ts (line 33)
REM  FIX: type SubscriptionStatus = "active"|"canceling"|"past_due"|"unpaid"|"canceled"|null;
REM ============================================================================

REM ============================================================================
REM  MEDIUM-07: VideoFormat/VideoLength Defined in 3+ Places
REM  Files: FormatSelector.tsx, types.ts, useVideoExport.ts, planLimits.ts
REM  FIX: Consolidate into src/types/domain.ts (see HIGH-06).
REM ============================================================================

REM ============================================================================
REM  MEDIUM-08: ProductId Union Defined in 3 Places
REM  Files: products.ts, types.ts, planLimits.ts
REM  FIX: Consolidate into src/types/domain.ts (see HIGH-06).
REM ============================================================================

REM ============================================================================
REM  MEDIUM-09: Unconstrained Generics on databaseService Methods
REM  File: src\lib\databaseService.ts (lines 46, 59, 74, 102)
REM  FIX: Add constraint: async query<T extends Record<string, unknown>>(...)
REM ============================================================================

REM ============================================================================
REM  MEDIUM-10: Speaker Voice Preview Failure Not Shown to User
REM  File: src\components\workspace\SpeakerSelector.tsx (lines 215-217)
REM  FIX: Add toast.error("Voice preview unavailable. Please try again.");
REM ============================================================================

REM ============================================================================
REM  MEDIUM-11: Admin Revenue Shows $0 Instead of "Unavailable" on Error
REM  File: src\lib\adminDirectQueries.ts (lines 54-55)
REM  FIX: Return { revenue: null, revenueError: true } and show "N/A" in UI.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-12: canUseCharacterConsistency Exported But Never Used
REM  File: src\hooks\useSubscription.ts (line 26)
REM  FIX: Delete the function or use it in Doc2VideoWorkspace.tsx line 162.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-13: lastIdx Computed But Never Read
REM  File: src\hooks\useCinematicRegeneration.ts (line 143)
REM  FIX: Delete: const lastIdx = updatedScenes.length - 1;
REM ============================================================================

REM ============================================================================
REM  MEDIUM-14: useWorkspaceDraft storageKey Not Memoized
REM  File: src\hooks\useWorkspaceDraft.ts (line 33)
REM  FIX: const storageKey = useMemo(() => `${DRAFT_PREFIX}${mode}`, [mode]);
REM ============================================================================

REM ============================================================================
REM  MEDIUM-15: Auth Submit Button Not Disabled During Lockout
REM  File: src\pages\Auth.tsx (lines 90-96)
REM  FIX: Add disabled={isLoading || Date.now() < lockedUntil} to submit button.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-16: Admin Stats Edge Function Sequential After Promise.all
REM  File: src\lib\adminDirectQueries.ts (lines 47-55)
REM  FIX: Include edge function call in the Promise.all array.
REM ============================================================================

REM ============================================================================
REM  MEDIUM-17: Cinematic Image Retry Errors Unlogged
REM  File: src\hooks\generation\cinematicPipeline.ts (lines 303-304)
REM  FIX: Add log.warn(`Image retry for scene ${idx} failed:`, err);
REM ============================================================================

REM ============================================================================
REM  MEDIUM-18: Subscription Refresh Retry Unlogged
REM  File: src\hooks\useSubscription.ts (lines 168-169)
REM  FIX: Add log.warn("Subscription edge function retry failed:", err);
REM ============================================================================

REM ============================================================================
REM  MEDIUM-19: Malformed JSON Defaults to Empty Object in Edge Function
REM  File: supabase\functions\generate-cinematic\index.ts (line 1410)
REM  FIX: Parse explicitly and return 400 "Invalid JSON request body" on failure.
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                      SECTION 4: LOW ISSUES (12)                          #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  LOW-01: (window as any) for Google Analytics
REM  Files: CookieConsent.tsx, useAnalytics.ts
REM  FIX: Add to src/types/window.d.ts:
REM    declare global { interface Window { gtag?: (...args: unknown[]) => void; } }
REM ============================================================================

REM ============================================================================
REM  LOW-02: catch (e: any) Instead of catch (e: unknown)
REM  File: src\hooks\export\downloadHelpers.ts (lines 189, 215, 242)
REM  FIX: Use catch (e: unknown) + extractErrorMessage(e) from appErrors.ts.
REM ============================================================================

REM ============================================================================
REM  LOW-03: normalizeScenes Uses any in Map Callback
REM  File: src\hooks\generation\types.ts (line 150)
REM  FIX: Define local interface for raw scene shape.
REM ============================================================================

REM ============================================================================
REM  LOW-04: PLAN_LIMITS Type Widened by Record<string>
REM  File: src\lib\planLimits.ts (line 39)
REM  FIX: Remove & Record<string, PlanLimits> widening.
REM ============================================================================

REM ============================================================================
REM  LOW-05: SCENE_COUNTS Uses Record<string, number>
REM  File: src\hooks\generation\types.ts (line 128)
REM  FIX: Change to Record<VideoLength, number>.
REM ============================================================================

REM ============================================================================
REM  LOW-06: authErrors.ts is Unnecessary Re-export Shim
REM  File: src\lib\authErrors.ts
REM  FIX: Update all importers to use @/lib/errorMessages directly. Delete file.
REM ============================================================================

REM ============================================================================
REM  LOW-07: ThemeProvider.tsx is Pass-through Wrapper
REM  File: src\components\ThemeProvider.tsx
REM  FIX: Import NextThemesProvider directly where used. Delete wrapper.
REM ============================================================================

REM ============================================================================
REM  LOW-08: NavLink.tsx Defined But Never Imported
REM  File: src\components\NavLink.tsx
REM  FIX: Delete file.
REM ============================================================================

REM ============================================================================
REM  LOW-09: videoExportDebug.ts Legacy "audiomax" Keys
REM  File: src\lib\videoExportDebug.ts (lines 11-12)
REM  FIX: Remove legacy migration block after confirming no active users
REM  have old localStorage keys.
REM ============================================================================

REM ============================================================================
REM  LOW-10: CreateWorkspace.tsx workspaceRef Unused
REM  File: src\pages\CreateWorkspace.tsx (lines 3, 7-8)
REM  FIX: Remove useRef and WorkspaceHandle import.
REM ============================================================================

REM ============================================================================
REM  LOW-11: story-weaver-audit.cmd Old Branding Artifact
REM  File: story-weaver-audit.cmd (root)
REM  FIX: Delete or rename to motionmax-audit.cmd.
REM ============================================================================

REM ============================================================================
REM  LOW-12: ExportState Lacks Step Discrimination
REM  File: src\hooks\export\types.ts (lines 30-38)
REM  FIX: Use discriminated union on status field (see Type Design report).
REM ============================================================================


REM ############################################################################
REM #                                                                          #
REM #                  SECTION 5: DEAD CODE TO REMOVE                          #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  DEAD FILES (13 files to delete):
REM ============================================================================
REM
REM  Workspace Components (8 files - never imported):
REM    src\components\workspace\Workspace.tsx
REM    src\components\workspace\CaptionPreviewAnimation.tsx
REM    src\components\workspace\CharacterPreview.tsx
REM    src\components\workspace\GenerationProgress.tsx
REM    src\components\workspace\InclinationSelector.tsx
REM    src\components\workspace\ResultActionBar.tsx
REM    src\components\workspace\SourceAttachments.tsx
REM    src\components\workspace\StoryIdeaInput.tsx
REM    src\components\workspace\TemplateSelector.tsx
REM
REM  UI Components (4 files - never imported):
REM    src\components\ui\hover-card.tsx
REM    src\components\ui\radio-group.tsx
REM    src\components\ui\resizable.tsx
REM    src\components\ui\toggle-group.tsx
REM
REM  Utilities (2 files - never imported):
REM    src\components\NavLink.tsx
REM    src\lib\cdnUrl.ts
REM
REM  NOTE: src\lib\databaseService.ts is unused but represents the RIGHT
REM  abstraction. Consider using it (HIGH-21) rather than deleting it.

REM ============================================================================
REM  UNUSED NPM DEPENDENCIES (7 packages to uninstall):
REM ============================================================================
REM
REM    npm uninstall dompurify input-otp isomorphic-dompurify mp4-muxer react-day-picker react-hook-form vaul
REM
REM  NOTE: Keep dompurify OR isomorphic-dompurify, not both.
REM  Verify mp4-muxer is truly unused if client-side muxing was removed.
REM  Verify vaul - the shadcn drawer.tsx may reference it internally.


REM ############################################################################
REM #                                                                          #
REM #             SECTION 6: RECOMMENDED EXECUTION ORDER                       #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  PHASE 1 - IMMEDIATE (Day 1) - Security + Revenue Blockers
REM  Estimated: 2-3 hours
REM ============================================================================
REM
REM  1. CRITICAL-01: Fix open redirect (5 min)
REM  2. CRITICAL-03: Fix empty priceId in CREDIT_PACKAGES (15 min)
REM  3. CRITICAL-10: Remove hardcoded Supabase key (10 min)
REM  4. HIGH-01: Fix toast.success used for errors (5 min)
REM  5. HIGH-08: Add toast.error to checkout failures (10 min)
REM  6. HIGH-09: Add toast.error to upload failures (5 min)
REM
REM  Total cost: $0

REM ============================================================================
REM  PHASE 2 - URGENT (Days 2-3) - Error Handling + Data Integrity
REM  Estimated: 4-6 hours
REM ============================================================================
REM
REM  1. CRITICAL-02: Add credit refund path on failure (1 hr)
REM  2. CRITICAL-04: Fix .catch(() => {}) on exports (30 min)
REM  3. CRITICAL-05: Inspect Promise.allSettled results (30 min)
REM  4. CRITICAL-06: Fix fake success on image failure (15 min)
REM  5. CRITICAL-09: Bridge logger to Sentry (1 hr)
REM  6. CRITICAL-11: Add subscription fetchError state (1 hr)
REM  7. HIGH-14: Fix session restore error handling (15 min)
REM  8. HIGH-15: Fix attachment upload error handling (15 min)
REM
REM  Total cost: $0

REM ============================================================================
REM  PHASE 3 - IMPORTANT (Days 4-5) - Type Safety + Dead Code
REM  Estimated: 6-8 hours
REM ============================================================================
REM
REM  1. CRITICAL-07: Enable strictNullChecks + fix errors (3-4 hr)
REM  2. CRITICAL-08: Type callPhase return value (1 hr)
REM  3. HIGH-06: Create shared domain types module (1 hr)
REM  4. HIGH-02: Delete dead Workspace.tsx (5 min)
REM  5. HIGH-03: Consolidate WorkspaceHandle interface (15 min)
REM  6. HIGH-05: Unify Scene/CinematicScene types (30 min)
REM  7. Delete 13 dead files (10 min)
REM  8. Uninstall 7 unused npm packages (5 min)
REM
REM  Total cost: $0

REM ============================================================================
REM  PHASE 4 - OPTIMIZATION (Week 2) - Performance + Architecture
REM  Estimated: 4-6 hours
REM ============================================================================
REM
REM  1. HIGH-07: Fix loadProject stale closure polling storm (30 min)
REM  2. HIGH-10: Add server-side admin pagination (1-2 hr)
REM  3. HIGH-16: Verify/add lazy loading on routes (1 hr)
REM  4. HIGH-19: Remove legacyCallPhase or add phase guard (30 min)
REM  5. HIGH-22: Enable eslint no-unused-vars (15 min)
REM  6. HIGH-04: Regenerate Supabase types (15 min)
REM  7. All MEDIUM issues (2-3 hr)
REM
REM  Total cost: $0


REM ############################################################################
REM #                                                                          #
REM #             SECTION 7: TOOLS & LIBRARIES USED/RECOMMENDED                #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  ALL FIXES USE EXISTING TOOLS - NO NEW PURCHASES REQUIRED:
REM
REM  - TypeScript (already installed) - for strictNullChecks, type fixes
REM  - ESLint (already installed) - for unused var detection
REM  - Sentry SDK (already installed, @sentry/react 10.45.0) - for error bridge
REM  - Supabase CLI (npx supabase, free) - for type regeneration
REM  - Sonner (already installed) - toast.error already available
REM  - React (already installed) - React.lazy, useMemo, useRef
REM
REM  NO new dependencies needed. Every fix uses what's already in package.json.
REM ============================================================================

REM ############################################################################
REM #                                                                          #
REM #                      SECTION 8: WHAT'S WORKING WELL                      #
REM #                                                                          #
REM ############################################################################

REM ============================================================================
REM  POSITIVE FINDINGS (do NOT change these):
REM
REM  1. Error classification system (appErrors.ts) - well-designed
REM  2. Error message mapping (errorMessages.ts) - thorough, user-friendly
REM  3. Error boundaries exist (GlobalErrorBoundary, WorkspaceErrorBoundary)
REM  4. Worker credit refunds on job failure - correct implementation
REM  5. Epoch-based stale prevention in useGenerationPipeline - smart pattern
REM  6. React Query cache with onError hooks - properly configured
REM  7. Worker orphaned job recovery - well-implemented
REM  8. Supabase RLS policies - security properly layered
REM  9. Security headers in vercel.json - comprehensive
REM  10. PWA configuration - proper manifest, service worker, caching
REM  11. Code organization - clear separation by domain
REM  12. shadcn/ui + Radix primitives - accessible component foundation
REM ============================================================================

REM ############################################################################
REM #                                                                          #
REM #                           END OF REPORT                                  #
REM #                                                                          #
REM ############################################################################

echo.
echo  =====================================================
echo   MOTIONMAX PRODUCTION AUDIT REPORT
echo  =====================================================
echo.
echo   CRITICAL:  11 issues
echo   HIGH:      23 issues
echo   MEDIUM:    19 issues
echo   LOW:       12 issues
echo   TOTAL:     65 issues
echo.
echo   ALL FIXES: $0 cost (use existing tools/libraries)
echo   TIMELINE:  ~2 weeks for all fixes
echo.
echo   Phase 1 (Day 1):    Security + Revenue blockers
echo   Phase 2 (Days 2-3): Error handling + Data integrity
echo   Phase 3 (Days 4-5): Type safety + Dead code cleanup
echo   Phase 4 (Week 2):   Performance + Architecture
echo.
echo   Open this file in a text editor to read the full report.
echo  =====================================================
echo.
pause
