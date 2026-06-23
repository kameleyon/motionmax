co# MotionMax — Native iOS & Android Rewrite Plan

**Document owner:** Jo (kameleyon)
**Last updated:** 2026-06-23
**Revision note:** This revision reconciled the plan with the current codebase — corrected plan tiers (`free | creator | studio`), routes, and the editor shell (`EditorFrame`, `AppShell` retired); fixed the watermark/disclosure policy to match the legal tier-split burn in code; broadened scope to the now-GA product pillars (3 project modes + intake/creation flow, Voice Lab, AutoPost Lab); and flagged alignment with the new API-as-product roadmap.
**Status:** Approved direction, awaiting kickoff — **but NOT production-ready as written.** A 7-dimension production-readiness assessment graded this **NOT-READY** (see [`NATIVE_MOBILE_PRODUCTION_READINESS.md`](NATIVE_MOBILE_PRODUCTION_READINESS.md)). Before kickoff, reconcile four load-bearing decisions: (1) make **remote render the v1 baseline** — local render is structurally infeasible for cinematic/master-audio/graded/captioned projects; (2) put **all job-creation + credit writes behind a server-enforced gateway** (the §13 direct-INSERT path is a payment-forge surface) resolved before phase 4, not phase 11; (3) consider **companion-first scope** (create/monitor/share, edit on web) for v1; (4) add the missing store-survival work — UGC moderation, in-app account deletion, push, observability, privacy declarations, BIPA consent row.
**Audience:** Future Jo, future AI assistants, any engineer picking this up cold.

This document is the single source of truth for moving MotionMax from web-only to fully native iOS (Swift/SwiftUI) and Android (Kotlin/Jetpack Compose) clients. If the window closes mid-build and someone reopens this in three months, they should be able to read this top-to-bottom and know **exactly where we are, what's been done, what's left, what to decide, and how to execute** — with no ambiguity.

---

## 1. Current state of MotionMax (April 2026)

### 1.1 What exists today
MotionMax is a production web application. The codebase lives at `C:\Users\Administrator\motionmax` with the following high-level structure:

- **`src/`** — React 18 + TypeScript + Vite client. Routes mounted in `src/App.tsx`.
  - `/app` & `/app/legacy` → **redirect to `/dashboard-new`** (the legacy dashboards are retired; both paths now bounce, App.tsx:171-172).
  - `/dashboard-new` → the main dashboard (current home after login).
  - `/app/create/new` → project creation / intake flow (a user cannot reach the editor without first creating a project here).
  - `/app/editor/:projectId` → the editor (App.tsx:295). **Not `/editor`** — the editor is project-scoped.
  - `/voice-lab` → Voice Lab (Fish-Audio voice cloning, App.tsx:193).
  - `/lab/autopost` → AutoPost Lab (recurring scheduled generation + publishing, now GA, App.tsx:253).
  - `/auth` → Supabase auth (Google OAuth + email/password; GitHub button removed in `c85df36`).
  - `/usage` → plan + credit dashboard. Reads canonical `PLAN_LIMITS` from `src/lib/planLimits.ts`. Plan tiers: `free | creator | studio` only (`src/lib/planLimits.ts:11`). **Enterprise was dropped**; legacy `enterprise` rows fall through to `studio` (`planLimits.ts:38 case "enterprise": return "studio";`), normalized via `normalizePlanName`.
  - Editor components in `src/components/editor/` — `Stage.tsx` (preview canvas), `Inspector.tsx` (motion picker), `EditorTopBar.tsx`, `useExport.ts` (export flow with DB rehydration). The legacy `AppShell` was **retired 2026-05-04**; the current editor shell component is `src/components/editor/EditorFrame.tsx`.
- **`marketing/`** — Astro landing site. Critical fix in `73ecb7c`: inline scripts moved to `marketing/src/scripts/landing.ts` because Vercel CSP `script-src 'self'` was silently killing all interactive buttons (hamburger, Watch Demo). External hoisted modules are CSP-compliant.
- **`worker/`** — Node FFmpeg pipeline. `worker/src/handlers/export/` runs scene encoding, concat, mux. Hardened in `38d26ae` with three-layer media validation: size floor in `fetchToDisk`, per-kind floor in `streamToFile` (`assertSaneSize`), and probe-with-retry in `sceneEncoder.muxVideoAudio`.
- **Supabase** — project ID `ayjbvcikuwknqdrpsdmj`. Tables: `profiles`, `video_generation_jobs` (with partial unique index `uq_video_jobs_project_task_active` enforcing dedupe), Stripe-driven `subscriptions`, etc. Realtime via `postgres_changes`. Auth uses Google OAuth — consent screen now branded as "motionmax" after Search Console domain verification.
- **Vercel** — auto-deploys both `motionmax.io` (marketing, Astro) and `app.motionmax.io` (React app) on push to `main`. CSP defined in `vercel.json` is strict; never use inline `<script>` blocks.
- **Stripe** — billing source of truth. `is_manual_subscription` flag in `profiles` allows admin-granted plans (Jo's account is `studio` via this).

### 1.2 What works on web today
- **Three project modes** (`src/lib/projectUtils.ts`): `doc2video` ("Explainer"), `smartflow` ("Smart Flow"), `cinematic` ("Cinematic"). Each is a distinct generation pipeline, not just a preset.
- **Intake / creation flow** (`/app/create/new`) — the front door to every project. The editor is unreachable without it; a native client that ships only the editor has no way in.
- Full editor (scene tray, motion presets, timeline, preview, export).
- **Voice Lab + Fish-Audio voice cloning** (`src/hooks/useVoiceCloning.ts`, `src/pages/VoiceLab.tsx`) — record/upload a voice, clone it, narrate with it. Carries BIPA/CUBI biometric-consent flows.
- **AutoPost Lab** (`src/pages/lab/autopost/*`) — recurring scheduled generation + channel publishing, with its own credit math and plan gate (`planLimits.ts` `AUTOPOST_ELIGIBLE_PLANS`).
- **Attachments / sources ingestion** — `doc2video` ingests PDFs and URLs (`src/lib/attachmentProcessor.ts`) as source material.
- **Master-audio re-track** — at export, `worker/src/handlers/handleMasterAudio.ts` / `replaceMasterAudio.ts` re-tracks continuous narration over the whole video (not just per-scene audio).
- Realtime job updates via Supabase channel.
- Stripe Checkout + Customer Portal.
- Google OAuth with branded consent screen.
- 4K export, FFmpeg-based scene encoding, retry-on-truncated-download.
- Plan tier gating, credits, usage dashboard.

### 1.3 What's rough on web (fix or accept before native)
- iOS Safari touch targets — multiple rounds of WCAG 2.5.5 (44×44) cleanups in `EditorTopBar`, `Hero`, `landing.ts`. Mostly resolved.
- "Save to camera roll" UX after export Download — web `<a download>` is the bottleneck. Native fixes this entirely (`PHPhotoLibrary`).
- Background export progress — web cannot survive tab close. Native gets `BGProcessingTask` (iOS) / `WorkManager` (Android).

### 1.4 Native client status
**Zero.** No `ios/` directory, no `android/` directory, no Xcode project, no Gradle project, no Swift code, no Kotlin code. This document describes how that changes.

---

## 2. Why native is the optimized path (decision rationale)

We considered three paths and chose native. The reasoning needs to be preserved so we don't relitigate it under deadline pressure.

| Path | Pros | Cons | Verdict |
|---|---|---|---|
| **PWA / mobile web hardening** | 1–2 weeks. Reuses 100% of code. | No background export. No camera roll save. Cannot ship in App Store / Play Store. Editor scrubbing capped at ~30fps on iOS Safari. | Reject as endpoint. Acceptable as bridge only. |
| **React Native / Capacitor wrapper** | 4–6 weeks. Reuses ~70% of React. | Editor timeline stutters at 30–45fps. Bridge overhead on Metal-bound work (motion preview, scrubbing). Two render systems to debug (web + native shell). Apple has historically scrutinized hybrid editors more harshly. | Reject. The editor *is* the product; cannot compromise its frame rate. |
| **Native rewrite (Swift + Kotlin)** | Best UX. 120Hz timeline. AVFoundation/Metal compositing. Local export option (no cloud round-trip for short renders). Background tasks. Camera roll save. App Store premium category. | 3–6 months per platform. Two codebases. Higher upfront engineering cost. | **Chosen.** |

The deciding factor: MotionMax sells motion. A motion product that scrubs at 30fps on iPhone is a broken promise. AVPlayerLayer + Metal is the only stack that delivers ProMotion 120Hz consistently.

---

## 3. Billing strategy: Stripe everywhere (no StoreKit)

This is the most important architectural decision in the document and the most commonly misunderstood.

### 3.1 The rule, as of April 2026
Apple's anti-steering settlement (US, 2024) and the EU Digital Markets Act (2024) **legalized Stripe-on-iOS** in two distinct modes:

1. **External Purchase Link entitlement** (US, EU, JP, KR, ~30 regions). App can deep-link to Stripe Checkout via `SFSafariViewController`. Apple commission is 12–27% on iOS-originated purchases for 7 days post-redirect; **0% on web-originated purchases the user later honors in-app**.
2. **EU DMA alternative payment processor** (iOS 17.4+, EU only). Full in-app Stripe checkout, no redirect, no Apple commission.

We use **Stripe as the only billing system on every platform.** No StoreKit. No receipts. No reconciliation logic. Subscription state lives in Supabase; the iOS and Android apps are *readers* of `profiles.plan_name` and `profiles.credits_balance`, never writers of payment state.

### 3.2 The optimization that prints money
**Default new mobile users to "Sign up on motionmax.com" via Universal Link, not in-app checkout.** Apple's External Purchase commission only applies to purchases *initiated from the iOS app*. A user who signs up on web (even on their iPhone's Safari) and then logs into the iOS app pays Apple **$0**. Figma, Linear, Notion, Spotify, and Netflix all use this pattern.

In-app upgrade flow exists for users who insist, with Apple's required disclosure sheet, but it is the secondary path.

### 3.3 What this kills from the build plan
- No StoreKit 2 product configuration.
- No App Store Connect subscription group setup.
- No receipt validation edge function.
- No reconciliation between StoreKit transaction IDs and Supabase customer IDs.
- No tax handling for App Store payments (Stripe Tax already covers our 50 states + EU VAT).

Estimated effort saved vs. StoreKit path: **~10 days of engineering + ongoing reconciliation maintenance forever.**

---

## 4. Architecture

### 4.1 What stays unchanged
The entire backend. Worker, edge functions, RLS policies, `video_generation_jobs` schema, Stripe webhooks, Supabase auth, Google OAuth consent screen — all reused as-is. Native clients consume the same HTTPS + Postgres realtime API the web app already uses.

### 4.2 iOS package layout

```
ios/
├── MotionMax.xcodeproj
├── App/
│   └── MotionMaxApp.swift                    # @main entry, dependency wiring
├── Packages/                                  # Swift Package Manager local packages
│   ├── MMCore/                                # Pure Swift types, no I/O
│   │   ├── PlanTier.swift                     # 1:1 with src/lib/planLimits.ts — free|creator|studio (enterprise→studio fallthrough)
│   │   ├── PlanLimits.swift                   # Static table, Codable
│   │   ├── Project.swift, Scene.swift
│   │   ├── ProjectMode.swift                  # doc2video | smartflow | cinematic (src/lib/projectUtils.ts)
│   │   ├── MotionPreset.swift                 # Mirrors Inspector.tsx presets
│   │   └── VideoJob.swift                     # video_generation_jobs row shape
│   ├── MMNetworking/                          # supabase-swift wrapper
│   │   ├── SupabaseClient.swift
│   │   ├── ProjectsAPI.swift, JobsAPI.swift
│   │   └── StripeAPI.swift                    # calls existing create-checkout-session edge fn
│   ├── MMRealtime/                            # postgres_changes → AsyncSequence<JobUpdate>
│   ├── MMAuth/                                # ASWebAuthenticationSession + Sign in with Apple
│   ├── MMIntake/                              # project creation — the front door, REQUIRED before editor
│   │   ├── ModePickerView.swift              # doc2video / smartflow / cinematic chooser
│   │   ├── CreateProjectView.swift           # mirrors /app/create/new intake flow
│   │   └── AttachmentPicker.swift            # PDF/URL ingest (file picker + Share Extension), mirrors attachmentProcessor.ts
│   ├── MMVoice/                               # Voice Lab — Fish-Audio cloning
│   │   ├── VoiceLabView.swift                # mirrors src/pages/VoiceLab.tsx
│   │   ├── VoiceRecorder.swift               # mic capture (AVAudioSession permission)
│   │   ├── BiometricConsentView.swift        # BIPA/CUBI consent gate before any capture (mirrors useVoiceCloning.ts)
│   │   └── VoiceCloneAPI.swift               # clone-voice-fish edge fn
│   ├── MMAutopost/                            # AutoPost Lab — scheduled generation + publishing
│   │   ├── SchedulesView.swift               # recurring schedule list/editor
│   │   ├── RunHistoryView.swift              # past runs + credit math
│   │   └── ChannelConnectView.swift          # publishing channel OAuth/connect
│   ├── MMEditor/                              # SwiftUI editor
│   │   ├── EditorView.swift                   # mirrors EditorFrame.tsx (the current shell; AppShell is retired)
│   │   ├── StageView.swift                    # AVPlayerLayer-backed canvas, Metal motion overlay (Stage.tsx)
│   │   ├── InspectorView.swift                # motion picker, preset chips (Inspector.tsx)
│   │   ├── TimelineView.swift                 # scene tray, drag-resize, scrubber (Timeline.tsx)
│   │   ├── ScenesColumnView.swift             # scene list/management (ScenesColumn.tsx)
│   │   ├── SceneRegen.swift                   # per-scene regeneration (useSceneRegen.ts, useActiveJobs.ts)
│   │   ├── BulkOpSheet.swift                  # bulk scene ops (BulkOpModal.tsx)
│   │   └── TopBar.swift                       # (EditorTopBar.tsx)
│   ├── MMRender/                              # local + remote export
│   │   ├── LocalRenderer.swift                # AVMutableComposition + Core Image filters
│   │   ├── RemoteRenderer.swift               # enqueues video_generation_jobs row, polls realtime
│   │   └── ExportRouter.swift                 # local for ≤60s/1080p, remote for 4K/longer
│   ├── MMBilling/                             # Stripe-only
│   │   ├── StripeCheckoutSheet.swift          # SFSafariViewController wrapper
│   │   ├── CustomerPortal.swift
│   │   ├── ExternalLinkDisclosure.swift       # Apple's required pre-redirect sheet
│   │   └── SubscriptionState.swift            # reads plan_name from Supabase
│   └── MMShare/                               # PhotoKit save, share sheet, deep links
└── Tests/
    └── (XCTest targets per package)
```

### 4.3 Android package layout (mirrors iOS)

```
android/
├── settings.gradle.kts
├── app/                                       # :app module, MainActivity, navigation graph
└── core/
    ├── core-model/                            # PlanTier (free|creator|studio), ProjectMode, Project, Scene, VideoJob (Kotlin data classes)
    ├── core-network/                          # supabase-kt + Ktor
    ├── core-realtime/
    ├── core-auth/                             # Custom Tabs + Credential Manager (Sign in with Google)
    ├── core-intake/                           # project creation: mode picker (doc2video/smartflow/cinematic) + attachment ingest (SAF/Share)
    ├── core-voice/                            # Voice Lab — Fish cloning, mic capture + BIPA/CUBI consent gate
    ├── core-autopost/                         # AutoPost Lab — schedules, run history, channel connect
    ├── core-editor/                           # Jetpack Compose editor (Timeline, ScenesColumn, scene regen, bulk ops)
    ├── core-render/                           # Media3 (ExoPlayer + Transformer) + RenderScript/Vulkan
    ├── core-billing/                          # Custom Tabs → Stripe Checkout
    └── core-share/                            # MediaStore, ShareSheet
```

Same separation, same package boundaries (`core-intake`, `core-voice`, `core-autopost` mirror iOS `MMIntake`/`MMVoice`/`MMAutopost`). When iOS and Android diverge, it's only inside `core-editor` (SwiftUI vs Compose) and `core-render` (AVFoundation vs Media3).

### 4.4 Why this layout
- **Data models are 1:1 with the TypeScript types.** When `PlanTier` changes in `src/lib/planLimits.ts`, it changes in `MMCore/PlanTier.swift` and `core-model/PlanTier.kt` in the same PR. We never let the platforms drift.
- **Networking is isolated.** No Supabase calls inside `MMEditor` — the editor takes a `ProjectsAPI` protocol and is testable with a mock.
- **Render is router-based.** `ExportRouter` decides local vs remote based on duration + resolution + plan tier. Local renders are free (no worker compute cost); remote handles the hard cases.

---

## 5. Build sequence

Fourteen phases, ordered by dependency. Each phase is a self-contained PR with its own tests. Agents can be dispatched in parallel where noted. Note the **intake/creation flow, Voice Lab, and AutoPost are real product pillars** that gate or sit alongside the editor — they come before (or in parallel with) editor work, not after. A native client that ships only the editor has no way to create a project and is unshippable.

| # | Phase | Depends on | Parallelizable? | Output |
|---|---|---|---|---|
| 1 | **Scaffold** | — | No | Xcode project, SPM packages, signing stub, GitHub Actions CI workflow with `xcodebuild`. Same for Android with Gradle + AGP 8 + GitHub Actions. |
| 2 | **Data models** | 1 | Yes (parallel with 3) | Port `PlanTier` (`free\|creator\|studio`, enterprise→studio fallthrough), `PLAN_LIMITS`, `ProjectMode` (doc2video/smartflow/cinematic), `MotionPreset`, `Scene`, `Project`, `VideoJob` from TS to Swift Codable + Kotlin data classes. Snapshot tests verify round-trip with real Supabase JSON. |
| 3 | **Networking + Auth** | 1 | Yes (parallel with 2) | supabase-swift / supabase-kt session manager. OAuth via ASWebAuthenticationSession (iOS) / Custom Tabs (Android). Sign in with Apple on iOS (Apple requires it if Google OAuth is offered). |
| 4 | **Intake / creation flow** | 2, 3 | Yes (parallel with 5) | `MMIntake` / `core-intake`. Three-mode project chooser (doc2video/smartflow/cinematic), the `/app/create/new` creation flow, and attachment/source ingestion — PDF/URL via file picker + Share Extension (iOS) / SAF + Share intent (Android), mirroring `attachmentProcessor.ts`. **The editor is unreachable without this.** |
| 5 | **Voice Lab + biometric consent** | 2, 3 | Yes (parallel with 4) | `MMVoice` / `core-voice`. Fish-Audio voice cloning (mirrors `useVoiceCloning.ts` / `VoiceLab.tsx`). Mic-permission capture UX **must replicate the BIPA/CUBI biometric-consent gate** before any recording is captured or uploaded. |
| 6 | **AutoPost** | 2, 3 | Yes (parallel with 4, 5) | `MMAutopost` / `core-autopost`. Recurring schedules, run history with its own credit math, channel-connect/publishing. Plan-gated via `AUTOPOST_ELIGIBLE_PLANS`. |
| 7 | **Editor shell** | 4 | No | SwiftUI/Compose shell mirroring `EditorFrame.tsx` (current shell; `AppShell` retired 2026-05-04) — sidebar, top bar, inspector pane, stage area. Empty placeholder views. Entered from the intake flow (phase 4) with a `projectId`. |
| 8 | **Stage + playback** | 7 | No | AVPlayerLayer (iOS) / PlayerView (Android Media3) backed canvas. Scrubber, timeline, scene thumbnails via AVAssetImageGenerator / MediaMetadataRetriever. Verify 120Hz on ProMotion devices, 90Hz on Pixel 8 Pro. |
| 9 | **Editor components** | 8 | No | Port the **full current editor component set**, not just the inspector: motion picker + preset chips (`Inspector.tsx`), timeline/scrubber (`Timeline.tsx`), scene list (`ScenesColumn.tsx`), per-scene regeneration (`useSceneRegen.ts` / `useActiveJobs.ts`), bulk ops (`BulkOpModal.tsx`), share/confirm modals (`ShareModal.tsx`, `ConfirmModal.tsx`), and the "Apply new motion to every scene?" confirm dialog. |
| 10 | **Local render** | 8, 9 | No | **Hardest phase.** AVMutableComposition + Core Image motion filters + AVAssetExportSession on iOS. Media3 Transformer with custom GL effects on Android. Parity must include the **master-audio re-track** (`handleMasterAudio.ts` / `replaceMasterAudio.ts`) — continuous narration re-tracked over the whole video at export, not just per-scene encode. Validate parity with worker output on a corpus of 20 reference projects. |
| 11 | **Remote render fallback** | 10 | No | Insert row into `video_generation_jobs`, subscribe to realtime, BGProcessingTask (iOS) / WorkManager (Android) for resume after backgrounding. |
| 12 | **Save & share** | 10 or 11 | Yes (parallel with 13) | PhotoKit save (`PHPhotoLibrary.shared().performChanges`), MediaStore on Android. Share sheet, Universal Links / App Links. |
| 13 | **Stripe billing** | 3 | Yes (parallel with 12) | SFSafariViewController / Custom Tabs to existing `create-checkout-session` edge function. Apple External Purchase disclosure sheet. Customer portal deep link. **3 days, not 1.5 weeks** because no StoreKit. |
| 14 | **Compliance + submission** | 1–13 | No | `PrivacyInfo.xcprivacy` on iOS, Data Safety form on Play Console, AI-generated content disclosure copy in both metadata, biometric-data disclosure for Voice Lab, ATT prompt if we add any analytics SDK that warrants it. TestFlight build + Internal Testing track. |

### 5.1 Local-render parity test (phase 10 acceptance)
Build a corpus of 20 reference projects spanning short/long/4K/1080p/various motion presets and **all three project modes** (doc2video/smartflow/cinematic), including projects that exercise the master-audio re-track. Render each three ways:
1. Web worker FFmpeg (current production).
2. iOS local renderer.
3. Android local renderer.

Compute SSIM frame-by-frame. Acceptance: **mean SSIM ≥ 0.97 across the corpus**, with no scene below 0.92. Anything below routes to remote renderer instead of local.

---

## 6. Timeline

Single engineer (Jo) + AI agents working in parallel where possible. Realistic with normal review cycles, not aspirational.

### 6.1 iOS first track

| Weeks | Phase(s) | Milestone |
|---|---|---|
| 1 | 1, 2, 3 | Buildable Xcode project, auth works, data models verified |
| 2–3 | 4, 5, 6 | Intake/creation flow, Voice Lab + consent, AutoPost functional in Simulator |
| 4–5 | 7, 8, 9 | Editor shell + stage playback + full editor component set in Simulator |
| 6–8 | 10 | Local renderer (incl. master-audio re-track) hits SSIM ≥0.97 on corpus |
| 9 | 11, 12, 13 | Remote fallback, camera roll save, Stripe checkout |
| 10 | 14 | TestFlight Internal Testing build live |
| 11–13 | Beta + iteration | TestFlight External (up to 10k testers), bug fixes |
| 14 | App Store submission | Review typically 24–72h |

**End of week 14: iOS production live.** Aggressive but real if Phase 10 (local render) doesn't slip. The added intake/Voice/AutoPost pillars push the earlier 12-week estimate out by ~2 weeks.

### 6.2 Android second track
Starts at iOS week 4 (after the intake + editor shell patterns are proven). Mirrors iOS phases, runs in parallel.

| Weeks (relative to start) | Phase(s) |
|---|---|
| 4–5 | Android phases 1–3 |
| 6–8 | Android phases 4–6 (intake, voice, autopost) |
| 9–11 | Android phases 7–9 (editor) |
| 12–14 | Android phase 10 (local render) |
| 15 | Android phases 11–13 |
| 16–17 | Android phase 14 + Internal Testing |
| 18 | Open Testing + production |

**End of week 18: Android production live.**

### 6.3 Buffer
Add 25% to both tracks for unforeseen platform surprises (Apple review feedback, Android OEM-specific Media3 bugs, Vulkan driver issues on older Adreno GPUs). Conservative public commitment: **iOS in 4 months, Android in 5 months**. Internal stretch: 14 + 18 weeks.

---

## 7. Costs

### 7.1 Hard costs (must be paid before App Store / Play Store submission)
- **Apple Developer Program** — $99/year USD. Required for TestFlight, App Store submission, push notifications on device, Sign in with Apple on device, External Purchase Link entitlement, Universal Links associated domains.
- **Google Play Developer Console** — $25 one-time. Required for Play Store submission, Internal/Closed/Open Testing tracks.

### 7.2 Soft costs
- **Code signing certificates** — included in Apple Developer Program.
- **Stripe** — already paid; no platform-specific cost.
- **App icons + screenshots + marketing assets** — design work. Estimate 1 week of design or ~$1,500 contracted.
- **Localization** — punt to v2 unless EU is launch market. English-only ships fine.

### 7.3 What can be done **without paying anything**
This is critical and the reason work starts now, not after the $99 clears:

With a **free Apple ID** signed into Xcode (Settings → Accounts → Add Apple ID), Personal Team provisioning lets us:
- Create the Xcode project + every SPM package.
- Build and run in iOS Simulator (every iPhone, every iPad, every iOS version).
- Sideload to **Jo's own physical iPhone** via USB (7-day cert, re-sign weekly — fine for development).
- Iterate the editor, AVFoundation render, Supabase auth, Stripe Checkout webview, motion previews — **everything**.

What's blocked without $99:
- TestFlight (sharing builds with people other than Jo).
- App Store submission.
- Push notifications on device (work in Simulator).
- Sign in with Apple on device (works in Simulator).
- External Purchase Link entitlement filing.
- Universal Links on device (associated domains entitlement).

Android has no equivalent gate — you can install signed APKs to any device for free. The $25 only matters at Play Store submission time.

### 7.4 Recommended payment timing
- **Buy Apple Developer Program at week 8** (before phase 14, compliance + submission). Apple approves in 24–48h, sometimes same-day.
- **Buy Google Play Console at Android week 13.**

This means the first 8 weeks of iOS work cost $0 in platform fees.

---

## 8. Decisions Jo must make before kickoff

These are the four items blocking Phase 1. Without them I cannot dispatch agents.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | **Bundle ID (iOS) / Application ID (Android)** | `com.motionmax.ios` and `com.motionmax.android` | Reverse domain of motionmax.io. Locked at App Store submission, freely changeable until then. |
| 2 | **iPhone-only or universal (iPad)?** | Universal | iPad Pro is the obvious creator-tool market. Adds ~2 weeks to phase 4 (split-view layout) but unlocks Apple Pencil scrub gestures, larger preview canvas, better multitasking. |
| 3 | **Minimum iOS version** | iOS 17.0 | Covers ~92% of active devices. Lets us use Observable, SwiftData, AVPlayerViewController improvements, Sensitive Content Analysis API. iOS 18 is cleaner code but cuts to ~70%. |
| 4 | **Minimum Android version** | Android 11 (API 30) | Covers ~93% of active devices. Required for scoped storage cleanly, Media3 Transformer, predictive back gesture (API 33+ but graceful degrade). |

Defaults if Jo doesn't override: bundle IDs above, **universal**, **iOS 17**, **Android 11**.

---

## 9. Risks and mitigations

### 9.1 Phase 10 (local renderer parity) is the load-bearing risk
If SSIM falls below 0.97 across the corpus — including parity on the master-audio re-track — and we can't bridge the gap in the time budget, fall back to remote-only renderer. This adds ~$0.02 per export in worker compute but unblocks shipping. Decision point: **end of week 7**. If parity isn't on track, switch to remote-only and reclaim 1–2 weeks for polish.

### 9.2 Apple review rejecting External Purchase entitlement
Apple has approved this for video editing apps (Descript, CapCut, Adobe Premiere Rush). Low risk. If rejected: fall back to "no in-app upgrade flow at all," route 100% of purchases through web Universal Link. Costs us conversion on a small slice of users; doesn't block ship.

### 9.3 Sign in with Apple
Apple **requires** Sign in with Apple if Google OAuth is offered in-app. This is non-negotiable App Store guideline 4.8. Phase 3 must include it on iOS. Backend already supports it (Supabase has Sign in with Apple as a first-class provider).

### 9.4 Synthetic media disclosure
Both stores now require explicit AI-generated content labeling in metadata + in-app. Phase 14 includes:
- App Store Connect → Age Rating → AI-Generated Content: declared.
- Play Console → Data Safety → Generative AI: declared.
- In-app provenance must match the **web policy exactly** — this is a **legal tier-split burn, not a user toggle** (`worker/src/handlers/exportVideo.ts:492-499`):
  - **Free tier:** a visible `drawtext` AI-disclosure is **burned into** the exported video.
  - **Paid tiers (creator/studio):** **no visible burn**; the disclosure is carried by a PublicShare disclosure badge plus XMP machine-readable provenance.
  - **XMP provenance is written for BOTH tiers regardless** of plan.
  - The native client must NOT expose this as an on/off switch — it is enforced server-side at export by tier. Native just renders whatever the export pipeline produces (or, for local render, must reproduce the same tier-split burn + XMP).

### 9.5 The timeline assumes one engineer + agents
If Jo's availability drops to part-time, double the timeline. If a second engineer joins, iOS and Android can run truly parallel from week 1, cutting total time to ~16 weeks for both.

---

## 10. What stops if the window closes today

If this conversation ends and Jo picks it up in three months, the resumption checklist is:

1. **Read this document top to bottom.** Nothing in it has decayed except the "April 2026" rule citations — re-verify Apple's current External Purchase Link rules at developer.apple.com before phase 10.
2. **Check git for any `ios/` or `android/` directories.** As of writing: none. If they exist, an earlier session started — read commit history before continuing.
3. **Confirm Jo still wants native vs PWA bridge.** The decision rationale in §2 stands unless web-tech stack has dramatically improved (unlikely).
4. **Confirm Stripe billing direction.** Apple's anti-steering rules could shift again. Verify §3.1 still describes current law.
5. **Verify the four §8 decisions** are still Jo's preferences.
6. **Dispatch Phase 1 agents** as described in §5. Phase 1 is fully self-contained; an AI assistant can execute it without further input from Jo if §8 defaults are accepted.

### 10.1 Files and references this document depends on (do not delete)
- `src/lib/planLimits.ts` — canonical plan tier source (`free|creator|studio`, enterprise→studio). Native models port from this.
- `src/lib/projectUtils.ts` — the three project modes (doc2video/smartflow/cinematic).
- `src/components/editor/EditorFrame.tsx` — **current editor shell** to mirror (`AppShell` is retired).
- `src/components/editor/Inspector.tsx` — motion preset list to mirror.
- `src/components/editor/Stage.tsx` — preview canvas behavior to mirror.
- `src/components/editor/Timeline.tsx` — timeline/scrubber behavior to mirror.
- `src/components/editor/useSceneRegen.ts` — per-scene regeneration logic to mirror.
- `src/components/editor/useExport.ts` — export state machine to mirror.
- `src/hooks/useVoiceCloning.ts`, `src/pages/VoiceLab.tsx` — Voice Lab + BIPA/CUBI consent to mirror.
- `src/lib/attachmentProcessor.ts` — PDF/URL source ingestion to mirror.
- `worker/src/handlers/export/sceneEncoder.ts` — render output to match in local renderer.
- `worker/src/handlers/handleMasterAudio.ts`, `worker/src/handlers/replaceMasterAudio.ts` — master-audio re-track to match in local renderer.
- `worker/src/handlers/exportVideo.ts` — Art.50 / AI-disclosure tier-split burn logic lives **here** (lines 492-499), **not** under `export/`. The watermark policy in §9.4 derives from this file.
- `marketing/src/scripts/landing.ts` — example of CSP-compliant external script (reminder of why inline-anything is forbidden).
- `vercel.json` — CSP definition, must remain strict.
- `supabase/migrations/` — schema source of truth. Native data models derive from here.

### 10.2 Conversation context that matters but isn't in code
- Jo signs into Supabase as `arcanadraconi@gmail.com`. GitHub identity is `kameleyon`. Email on file is `josinsidevoice@gmail.com`.
- Studio plan is granted via `is_manual_subscription=true` on `profiles`. Treat this as a real subscription for entitlement checks.
- The marketing landing button bug (3 rounds of failed iOS touch-action fixes) was actually a **CSP bug, not an iOS bug.** Lesson: when something fails identically across all browsers but only manifests as "iOS doesn't work," check CSP and console errors before more touch-target tuning.
- The Usage page "Free instead of Studio" bug was a **missing key in a local lookup table.** Lesson: never duplicate `PLAN_LIMITS`; always import the canonical one.

---

## 11. Success criteria

Native rewrite is "done" when all of the following are true:

1. iOS app live in App Store, Android app live in Play Store.
2. Editor scrubs at native refresh rate on flagship devices (120Hz iPhone, 90/120Hz Pixel/Samsung).
3. Local renderer parity (SSIM ≥0.97) on the 20-project corpus.
4. Remote renderer fallback works for 4K/long-form with progress visible after backgrounding.
5. Stripe Checkout works in-app via SFSafariViewController / Custom Tabs.
6. Existing web subscribers see correct plan + credits when logging into native app.
7. Export saves to camera roll / gallery in one tap, with share sheet.
8. Crash-free rate ≥99.5% over 7-day rolling window in production.
9. App Store rating ≥4.5 over first 100 reviews (vanity but real signal).
10. AI content disclosure compliant with both stores' current rules.

Anything below these bars is not "done"; it's "released early."

---

## 12. Appendix: command reference

### 12.1 Phase 1 kickoff (when Jo gives go)
```
# iOS scaffold
mkdir ios && cd ios
xcodegen generate    # if using XcodeGen, otherwise manual via Xcode

# Android scaffold
mkdir android && cd android
# Use Android Studio "New Project" → Empty Activity, Kotlin, Min SDK 30
# Then split into Gradle modules per §4.3
```

### 12.2 Verify free Apple ID provisioning works
```
# In Xcode:
# 1. Settings → Accounts → Add Apple ID (use Jo's existing Apple ID, no $99 needed)
# 2. Open MotionMax.xcodeproj → Signing & Capabilities → Team → select Personal Team
# 3. Connect iPhone via USB → Trust this computer → select device as run target
# 4. Cmd+R → app installs (will be blocked from launch until user goes to
#    Settings → General → VPN & Device Management → trust developer cert)
```

### 12.3 Useful supabase-swift snippet (for Phase 3)
```swift
import Supabase

let client = SupabaseClient(
    supabaseURL: URL(string: "https://ayjbvcikuwknqdrpsdmj.supabase.co")!,
    supabaseKey: ProcessInfo.processInfo.environment["SUPABASE_ANON_KEY"]!
)

// OAuth Google
try await client.auth.signInWithOAuth(provider: .google)

// Realtime job updates
let channel = client.realtimeV2.channel("video_jobs:user=\(userId)")
let updates = channel.postgresChange(UpdateAction.self, table: "video_generation_jobs")
await channel.subscribe()
for await update in updates { ... }
```

### 12.4 Useful supabase-kt snippet (for Phase 3)
```kotlin
val supabase = createSupabaseClient(
    supabaseUrl = "https://ayjbvcikuwknqdrpsdmj.supabase.co",
    supabaseKey = BuildConfig.SUPABASE_ANON_KEY,
) {
    install(Auth)
    install(Postgrest)
    install(Realtime)
}

supabase.auth.signInWith(Google)

val channel = supabase.realtime.channel("video_jobs:user=$userId")
val updates = channel.postgresChangeFlow<PostgresAction.Update>("public") {
    table = "video_generation_jobs"
}
channel.subscribe()
updates.collect { ... }
```

---

## 13. API alignment — open architectural decision

A separate **API-as-product roadmap** now exists at `MOTIONMAX_API_ROADMAP.md` (dated 2026-06-23), and it is in direct tension with how this plan wires the native clients. This must be reconciled before Phase 11 (remote render) locks in.

**The tension, stated plainly:**
- **This plan** (see §4.1, §4.2 `RemoteRenderer.swift`, §5 phase 11, the §12.3/§12.4 snippets) hard-codes the native clients to do **exactly what web does today**: a direct browser/client `INSERT` into `video_generation_jobs` plus a Supabase `postgres_changes` realtime subscription. Mobile is a second and third writer against the same raw table.
- **`MOTIONMAX_API_ROADMAP.md`** explicitly plans to **replace** that direct-INSERT model with a versioned **`/api/v1` gateway** fronted by API keys, idempotency keys, and a public, stable job-state enum — decoupling clients from the raw `video_generation_jobs` schema. It estimates **~5–6 months to GA**.

If native ships against the direct-INSERT model and the gateway then lands, the mobile clients are immediately legacy on day one and need a second integration pass. If native waits for the gateway, the mobile timeline is gated on an API track that is itself months out.

**The decision Jo must make (do not pre-resolve — this is a §8-style open item):**

| Option | What it means | Cost / risk |
|---|---|---|
| **A — Ship native on direct INSERT now** | Mobile mirrors web's raw-table writes; migrate to `/api/v1` later as a fast-follow. | Fastest to market. Incurs a guaranteed re-integration pass + a window where mobile and the gateway disagree about job-state semantics. |
| **B — Gate native remote-render on `/api/v1` GA** | Native consumes the versioned gateway from day one; local render (phases 4–10) proceeds in parallel, remote render (phase 11) waits. | No rework, clean public contract, biometric/voice and AutoPost endpoints get a real API surface. Slips remote-render ~5–6 months. |
| **C — Abstract the boundary now, swap implementation later** | `RemoteRenderer` / `core-render` talk to an internal `JobsGateway` protocol; phase-11 impl is direct-INSERT, swapped to `/api/v1` when it GAs without touching call sites. | Small upfront design cost in phase 11; isolates the churn to one file per platform. Likely the pragmatic middle. |

Whoever resumes this work must read `MOTIONMAX_API_ROADMAP.md` alongside this document and sequence the native remote-render phase against the API track's GA date. **This is unresolved by design.** Note also that the roadmap's API surface should eventually cover the Voice Lab (clone/consent) and AutoPost (schedules/publish) endpoints, not just job creation — so options B/C also shape `MMVoice`/`MMAutopost`, not only `MMRender`.

---

**End of document.** If you're an AI assistant resuming this work, your first action should be `Read` on this file in full, then `git status` to confirm whether `ios/` or `android/` already exist, then check §8 **and the §13 API-alignment decision** with Jo, then dispatch Phase 1 agents per §5. Do not start Phase 10 (local render) without the §5.1 corpus in place. Do not implement StoreKit. Do not use inline scripts anywhere — everything CSP-strict.
