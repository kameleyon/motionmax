# MotionMax — Mobile (Expo / React Native) iOS & Android Plan

**Document owner:** Jo (kameleyon)
**Last updated:** 2026-07-15
**Revision note:** This plan was **converted from the original native Swift (SwiftUI) + Kotlin (Compose) direction to Expo SDK 52+ / React Native (New Architecture — Fabric + JSI)**. One codebase for iOS + Android that reuses the existing web React/TypeScript logic (`planLimits`, `projectUtils`, types, Supabase clients) via a shared package. The earlier native product analysis (current state, billing law, compliance, API tension) is preserved and carried forward here; only the **client technology** changed — from two native codebases to **one Expo codebase**. Reconciled with the readiness assessment's load-bearing calls, most importantly **remote render as the v1 baseline** and **companion-first scope for v1** (both of which Expo favors naturally).
**Status:** Approved direction. The frame-rate objection that originally killed React Native is **addressed directly in §2** — read that before dispatching anything. Production-readiness gaps (UGC moderation, in-app account deletion, push, observability, privacy declarations, BIPA consent) are folded into Phase 13, not deferred.
**Audience:** Future Jo, future AI assistants, any engineer picking this up cold.

This document is the single source of truth for shipping MotionMax to iOS + Android with **one Expo codebase**. If the window closes mid-build and someone reopens this in three months, they should be able to read it top-to-bottom and know **exactly where we are, what's done, what's left, what to decide, and how to execute** — with no ambiguity.

---

## 1. Current state of MotionMax

The backend and web app are identical regardless of client tech; the web `src/` is the code we **reuse**, not throw away.

- **`src/`** — React 18 + TypeScript + Vite web client.
  - Routes: `/dashboard-new` (home), `/app/create/new` (intake — the front door), `/app/editor/:projectId` (editor), `/voice-lab`, `/lab/autopost`, `/auth`, `/usage`.
  - Canonical logic that ports 1:1 to mobile: `src/lib/planLimits.ts` (tiers `free | creator | studio`; `enterprise → studio` fallthrough via `normalizePlanName`), `src/lib/projectUtils.ts` (modes `doc2video | smartflow | cinematic`), `src/lib/attachmentProcessor.ts`, `src/integrations/supabase/*`, the editor hooks (`useSceneRegen.ts`, `useExport.ts`, `useEditorState.ts`). The editor shell is `src/components/editor/EditorFrame.tsx` (`AppShell` retired 2026-05-04).
- **`worker/`** — Node FFmpeg pipeline. Owns rendering. Mobile does **not** reimplement it (§2, §4.4).
- **Supabase** — project `ayjbvcikuwknqdrpsdmj`. Auth (Google OAuth + email/password + Sign in with Apple provider), `video_generation_jobs` (partial unique dedupe index), Stripe-driven `subscriptions`, realtime via `postgres_changes`.
- **Vercel** — deploys `motionmax.io` (Astro) + `app.motionmax.io` (React) on push to `main`. Strict CSP; never inline `<script>`.
- **Stripe** — billing source of truth. `is_manual_subscription` grants (Jo = `studio`).

**What works on web today:** three project modes (doc2video/smartflow/cinematic), intake/creation flow, full editor, Voice Lab + Fish-Audio cloning (with BIPA/CUBI consent), AutoPost Lab (scheduled generation + publishing), PDF/URL attachment ingest, master-audio re-track at export, realtime job updates, Stripe Checkout + Portal, Google OAuth, 4K FFmpeg export, plan/credit gating.

**Mobile client status: zero.** No `apps/mobile/`, no Expo project. This document changes that.

---

## 2. Why Expo (and why the earlier "reject React Native" call is revisited)

The earlier native direction rejected React Native/Capacitor with: *"Editor timeline stutters at 30–45fps. Bridge overhead on Metal-bound work. Two render systems to debug."* That was **correct for the RN of ~2022**. Three things changed the calculus:

1. **RN New Architecture (Fabric + JSI + TurboModules) is default in Expo SDK 52+.** The old async "bridge" — the actual source of the Metal-bound stutter — is gone; JSI is synchronous C++ interop.
2. **`react-native-reanimated` v3 + `react-native-gesture-handler` run animations/gestures on the UI thread**, not JS — scrubbing/timeline drag no longer round-trips through JS per frame.
3. **`@shopify/react-native-skia`** gives a GPU canvas (same Skia that backs Chrome/Flutter) for the motion overlay, and **`expo-video`** gives native `AVPlayer`/`ExoPlayer` playback. Preview is native video + Skia overlay, not a JS-drawn canvas.

**The honest caveat stands:** a fully-featured, frame-perfect 120Hz pro-timeline editor is still *harder* in RN than pure SwiftUI/Metal. So this plan makes the scope choice the readiness assessment already recommended:

> **v1 is companion-first.** Mobile ships the **full creation funnel** — intake/creation, Voice Lab, AutoPost, monitor/preview, save/share, billing — with a **lightweight editor** (reorder scenes, swap motion preset, regenerate a scene, edit text/voiceover). **Heavy timeline scrubbing/trimming stays on web for v1** (deep-linked from the app). This flips the original's biggest risk (on-device local-render parity) into a non-issue and is honest about where RN is weakest.

### Path comparison

| Path | Pros | Cons | Verdict |
|---|---|---|---|
| PWA hardening | 1–2 wks, 100% reuse | No store presence, no camera roll, no push, no background | Bridge only |
| **Expo / React Native** | **One codebase iOS+Android. ~70–85% logic reuse from web. Store-shippable. EAS build/submit + OTA updates. Reanimated/Skia close the fps gap for a companion-scope editor.** | Full 120Hz pro-timeline still web-best. On-device FFmpeg render is fragile in RN (§9). Some native config-plugin work. | **Chosen** |
| Native Swift + Kotlin | Best possible 120Hz editor + local render | Two codebases, 4–6 mo/platform, most expensive | Deferred — revisit only if a pro on-device editor becomes the differentiator |

**Deciding factor:** MotionMax's mobile job-to-be-done is *create, monitor, publish, share on the go* — not *replace a desktop NLE*. Expo delivers that funnel across both platforms in one codebase, months faster, reusing code we already wrote.

---

## 3. Billing: Stripe everywhere, no StoreKit

The legal analysis is unchanged: **Stripe on every platform, no StoreKit, no receipts, no reconciliation.** Supabase is the source of truth; the app is a *reader* of `subscriptions` / `credits_balance`, never a writer of payment state. Re-verify Apple's External Purchase Link rules at kickoff (US anti-steering + EU DMA legalized Stripe-on-iOS).

**Expo mechanics:**
- **Checkout / Customer Portal:** `expo-web-browser` → `WebBrowser.openBrowserAsync(url)` (or `openAuthSessionAsync` for return-URL capture) opens the existing `create-checkout` / `customer-portal` edge functions in the system browser (SFSafariViewController / Custom Tabs under the hood). No native billing code.
- **Money-printing default:** default new users to **"Sign up on motionmax.io"** via a Universal/App Link. Web-originated purchases = **$0 Apple commission** (the Figma/Linear/Notion/Spotify/Netflix pattern). In-app upgrade is the secondary path, behind Apple's required External Purchase disclosure sheet (a plain RN modal rendered before opening the browser).
- **Kills ~10 days** of StoreKit config + a receipt-validation edge function + forever-reconciliation.

---

## 4. Architecture

### 4.1 What stays unchanged
The entire backend: worker, edge functions, RLS, `video_generation_jobs`, Stripe webhooks, Supabase auth, Google/Apple OAuth. Mobile consumes the same HTTPS + Postgres-realtime API the web app uses. **Rendering stays server-side** (§4.4).

### 4.2 Monorepo layout (single Expo app + shared code)

```
/                                   # existing repo root
├── src/                            # existing web app (unchanged)
├── worker/                         # existing render worker (unchanged)
├── packages/
│   └── shared/                     # NEW — code shared by web + mobile (extracted, not duplicated)
│       ├── planLimits.ts           # single source of truth; web re-imports from here
│       ├── projectUtils.ts         # doc2video | smartflow | cinematic
│       ├── types/                  # Project, Scene, VideoJob, PlanTier — 1:1 with Supabase rows
│       ├── api/                    # projects, jobs, stripe, voice, autopost API fns (Supabase calls)
│       └── realtime/               # postgres_changes → typed subscription helper
└── apps/
    └── mobile/                     # NEW — Expo app
        ├── app.config.ts           # Expo config (bundle IDs, plugins, entitlements)
        ├── eas.json                # EAS Build/Submit profiles (dev, preview, production)
        ├── app/                    # expo-router file-based routes (mirror web routes)
        │   ├── (auth)/sign-in.tsx
        │   ├── (tabs)/index.tsx            # dashboard
        │   ├── create/index.tsx            # intake — mode picker (front door)
        │   ├── create/new.tsx              # /app/create/new flow
        │   ├── editor/[projectId].tsx      # lightweight editor (companion scope)
        │   ├── voice-lab/index.tsx
        │   ├── autopost/index.tsx
        │   └── usage.tsx
        ├── features/
        │   ├── intake/             # mode chooser + create flow + attachment picker (expo-document-picker, Share Extension via config plugin)
        │   ├── voice/              # Voice Lab: expo-audio capture + BIPA/CUBI consent gate (mirrors useVoiceCloning.ts)
        │   ├── autopost/           # schedules, run history, channel connect
        │   ├── editor/             # StagePlayer (expo-video), SceneTray (Reanimated), motion picker, regen, bulk ops
        │   ├── render/             # RemoteRender (enqueue + realtime), JobsGateway boundary (§13)
        │   ├── billing/            # expo-web-browser checkout + External Purchase disclosure sheet
        │   └── share/              # expo-media-library save + Share sheet + deep links
        └── modules/                # optional native modules / config plugins (only if local render is later pursued — §9)
```

### 4.3 Key Expo/RN dependencies

| Concern | Package |
|---|---|
| Routing | `expo-router` (file-based, mirrors web routes) |
| Auth (OAuth) | `expo-auth-session` + `expo-web-browser`; **Sign in with Apple** via `expo-apple-authentication` (required if Google OAuth is offered — Apple guideline 4.8) |
| Supabase | `@supabase/supabase-js` (RN with `AsyncStorage` + `react-native-url-polyfill`) |
| Realtime | supabase-js realtime (`postgres_changes`) — same as web |
| Video playback | `expo-video` (native AVPlayer / ExoPlayer) |
| Motion overlay / canvas | `@shopify/react-native-skia` |
| Gestures / timeline | `react-native-gesture-handler` + `react-native-reanimated` (UI-thread) |
| Audio capture (Voice Lab) | `expo-audio` (mic permission + record) |
| Attachments | `expo-document-picker`, `expo-file-system`; Share-to-app via config plugin (iOS Share Extension / Android Share intent) |
| Save to gallery | `expo-media-library` |
| Push | `expo-notifications` |
| Background job resume | `expo-task-manager` + `expo-background-task` (best-effort; realtime + foreground poll is the reliable path) |
| Billing | `expo-web-browser` (no StoreKit) |
| Build / submit | **EAS Build + EAS Submit** |
| OTA updates | `expo-updates` (ship JS fixes without store review) |

### 4.4 Rendering: remote-first (the big divergence from an on-device native build)
The earlier native direction tried **on-device local render** (AVFoundation / Media3) with an SSIM≥0.97 parity gate — its hardest, highest-risk work. **In Expo we do NOT do that for v1:**
- `ffmpeg-kit-react-native`, the obvious RN FFmpeg binding, was **retired/archived by its maintainer in early 2025** — building v1's render path on an abandoned dependency is a liability.
- Reproducing the worker's exact pipeline (scene encode, concat, mux, **master-audio re-track**, graded/captioned output, the **tier-split AI-disclosure burn + XMP**) on-device in RN is months of fragile native work for marginal benefit.

**So: all render is remote.** Mobile enqueues a `video_generation_jobs` row (via the `JobsGateway` boundary — §13), subscribes to realtime for progress, and downloads the finished MP4. This matches the readiness call to *"make remote render the v1 baseline."* Local render can return later as an optional Expo **native module**, isolated behind the same `JobsGateway` so call sites never change.

---

## 5. Build sequence

Thirteen phases. One codebase → both platforms fall out of most phases together (divergence only at native config: entitlements, Share Extension, store metadata).

| # | Phase | Depends on | Output |
|---|---|---|---|
| 1 | **Scaffold** | — | `apps/mobile` Expo app (SDK 52+, New Architecture on), `expo-router`, `eas.json` (dev/preview/prod), EAS project, GitHub Actions running `eas build --profile preview` on PRs. Extract `packages/shared` and re-point the web app's imports (no logic change). |
| 2 | **Shared models + API** | 1 | Move `planLimits`, `projectUtils`, types, Supabase API/realtime helpers into `packages/shared`. Web + mobile both import from shared. **One source of truth, no drift.** Snapshot tests round-trip real Supabase JSON. |
| 3 | **Auth** | 1 | Supabase session in RN (AsyncStorage). Google OAuth via `expo-auth-session`/`expo-web-browser`. **Sign in with Apple** via `expo-apple-authentication`. Deep-link return handling. |
| 4 | **Intake / creation flow** | 2, 3 | Mode picker (doc2video/smartflow/cinematic), the `/app/create/new` flow, attachment ingest (`expo-document-picker` + Share Extension/intent), mirroring `attachmentProcessor.ts`. **The editor is unreachable without this.** |
| 5 | **Voice Lab + biometric consent** | 2, 3 | `expo-audio` mic capture; **BIPA/CUBI consent gate before any capture/upload** (mirrors `useVoiceCloning.ts`); `clone-voice-fish` edge fn. |
| 6 | **AutoPost** | 2, 3 | Recurring schedules, run history + credit math, channel connect/publish. Plan-gated via `AUTOPOST_ELIGIBLE_PLANS`. |
| 7 | **Dashboard + navigation shell** | 3 | Tab/stack navigation, dashboard, project list, deep links into intake/editor/usage. |
| 8 | **Preview / playback** | 7 | `expo-video` player + Skia motion overlay + Reanimated scrubber. Validate on ProMotion (120Hz) iPhone and 90/120Hz Android; 60fps floor, native refresh where the device allows. |
| 9 | **Lightweight editor (companion scope)** | 8 | Scene reorder (Reanimated drag), motion-preset swap (`Inspector.tsx` presets), per-scene regenerate (`useSceneRegen.ts`), text/voiceover edit, bulk "apply motion to all" confirm. **Deep-link to web editor** for heavy timeline trim/scrub. |
| 10 | **Remote render + job monitoring** | 4, 9 | Enqueue via `JobsGateway`, realtime progress, `expo-notifications` on completion, `expo-background-task` best-effort resume, download finished MP4. |
| 11 | **Save & share** | 10 | `expo-media-library` one-tap save to camera roll/gallery; Share sheet; Universal Links / App Links. |
| 12 | **Stripe billing** | 3 | `expo-web-browser` → existing `create-checkout` / `customer-portal`. External Purchase disclosure sheet. **~2–3 days, no StoreKit.** |
| 13 | **Compliance + submission** | 1–12 | `app.config.ts` privacy manifests + Play Data Safety, AI-generated-content + biometric disclosures, UGC moderation + report/block + **in-app account deletion**, `expo-notifications` push cert, EAS Submit → TestFlight + Play Internal. |

**Parallelizable:** 4/5/6 together; 8→9 sequential; 11/12 together. Phases 4–6 (funnel pillars) come **before** the editor — a mobile app that can't create a project is unshippable.

---

## 6. Timeline

One engineer (Jo) + AI agents. **Single codebase means iOS and Android land together**, not on two staggered tracks — the biggest time win over the native path (which was 14 + 18 weeks).

| Weeks | Phase(s) | Milestone |
|---|---|---|
| 1 | 1, 2, 3 | Expo app builds to a dev client on device; auth + Sign in with Apple work; shared package extracted |
| 2–3 | 4, 5, 6 | Intake, Voice Lab + consent, AutoPost working on both platforms |
| 4 | 7, 8 | Dashboard + preview/playback smooth on device |
| 5 | 9 | Lightweight editor (reorder/preset/regen) + deep-link-to-web for heavy edits |
| 6 | 10, 11 | Remote render + progress + push + save-to-gallery + share |
| 7 | 12, 13 | Stripe checkout; compliance; UGC moderation + account deletion; EAS Submit |
| 8 | Beta | TestFlight External + Play Closed Testing; bug fixes |
| 9–10 | Submission | App Store + Play review (iOS 24–72h, Play a few days), production live |

**Both stores live in ~10 weeks** with companion scope. Add the standard 25% buffer → **conservative public commitment: ~3 months for both platforms**. A true on-device pro editor / local export, if later demanded, is a **separate native-module track**, not a blocker for this v1.

---

## 7. Costs

### 7.1 Hard costs (before store submission)
- **Apple Developer Program** — $99/yr. Required for TestFlight, App Store, push, Sign in with Apple on device, External Purchase entitlement, Universal Links, and installing EAS builds on non-simulator devices via ad-hoc/TestFlight.
- **Google Play Developer** — $25 one-time.

### 7.2 EAS (Expo Application Services)
- **Free tier:** limited monthly build minutes on shared runners — enough to start and to run occasional production builds.
- **Paid (optional):** ~$99/mo Production plan for concurrent + priority builds. Not required to ship; buy only if queue times hurt. Self-hosted runners can stay free.

### 7.3 Soft costs
- App icons + screenshots + store assets — ~1 wk design or ~$1,500 contracted (both platforms from one set).
- Localization — English-only ships fine; punt to v2.

### 7.4 What's free
- **Expo Go / dev client in Simulator/Emulator** — build and iterate the *entire* app (auth, Supabase, Stripe webview, Skia/Reanimated preview, Voice Lab) with **no paid account**.
- **Android:** sideload signed APKs to any device for free; $25 only at Play submission.
- **iOS:** a **free Apple ID** + a dev build runs on Jo's own device (7-day cert). $99 only for TestFlight/submission/push-on-device.

### 7.5 Recommended timing
Apple Developer at **week 6** (before compliance/submission); Google Play at **week 7**. First ~6 weeks cost **$0** in platform fees.

---

## 8. Decisions before kickoff

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | **Bundle ID / Application ID** | `io.motionmax.app` (or `com.motionmax.app`) — one ID, both platforms | Reverse-domain of motionmax.io. Locked at submission. |
| 2 | **Companion scope for v1?** | **Yes** — full creation funnel + lightweight editor; heavy timeline on web | Sidesteps RN's weakest area; ships months sooner. Revisit pro-editor as v2. |
| 3 | **iPad / tablet layout** | Support responsively, no bespoke split-view for v1 | Expo scales layouts; a tuned iPad editor can wait. |
| 4 | **Min OS** | iOS 15+ / Android 8 (API 26) — Expo SDK 52 baseline | Broad coverage; Expo handles the floor. |
| 5 | **OTA updates policy** | Use `expo-updates` for JS-only fixes | Ship bug fixes without a store review cycle (respect store rules — no review-dodging behavior changes). |

Defaults if not overridden: `io.motionmax.app`, **companion scope = yes**, responsive (no bespoke iPad), iOS 15 / Android 8, OTA on.

---

## 9. Risks and mitigations

1. **Editor smoothness (the original objection).** Mitigation: companion scope + Reanimated (UI-thread) + Skia (GPU) + `expo-video` (native). If the lightweight editor still feels janky on low-end Android, degrade gracefully (fewer live overlays) and lean on deep-link-to-web. **This is why v1 is companion-first.**
2. **On-device local render unavailable/fragile** (`ffmpeg-kit-react-native` archived 2025). Mitigation: **remote-render-only v1** (§4.4). Local render becomes an optional native-module track later, behind `JobsGateway`.
3. **New Architecture / library compatibility.** Some RN libs lag Fabric. Mitigation: pin to Expo SDK's vetted set; prefer Expo-maintained modules; match Skia/Reanimated/gesture-handler versions to the SDK.
4. **Apple review — External Purchase entitlement.** Low risk (approved for CapCut/Premiere Rush/Descript). Fallback = 100% web Universal-Link purchases.
5. **Sign in with Apple is mandatory** if Google OAuth is in-app (guideline 4.8). `expo-apple-authentication` in Phase 3. Non-negotiable.
6. **Synthetic-media + tier-split disclosure.** The AI-disclosure burn is a **legal tier-split enforced server-side at export** (`worker/src/handlers/exportVideo.ts:492-499`) — free tier gets a burned `drawtext`, paid tiers get a PublicShare badge + XMP, **XMP written for both**. Because render is remote here, the client displays what the pipeline produces — **the client must NOT expose a disclosure on/off toggle.**
7. **Store-survival gaps** (from readiness assessment): UGC moderation, report/block, **in-app account deletion**, push, observability, privacy declarations, BIPA consent row — all in Phase 13, not deferred.

---

## 10. Compliance + submission (Phase 13)
- **Privacy:** `app.config.ts` → iOS privacy manifests (`PrivacyInfo.xcprivacy` generated by Expo) + Play Console Data Safety.
- **AI content:** App Store Age Rating → AI-Generated Content declared; Play → Generative AI declared; in-app provenance matches web policy exactly (§9.6).
- **Biometric:** Voice Lab biometric-data disclosure (BIPA/CUBI) in both stores + consent gate in-app.
- **Store survival:** UGC moderation + report/block, in-app account deletion, push via `expo-notifications`.
- **Submit:** `eas submit -p ios` / `eas submit -p android` → TestFlight + Play Internal, then External/Closed → production.

---

## 11. Success criteria
1. One Expo codebase live in **both** App Store and Play Store.
2. Full creation funnel on mobile: intake (3 modes), Voice Lab (+consent), AutoPost, remote render with visible progress, save-to-gallery, share.
3. Lightweight editor (reorder/preset/regen/text) smooth at ≥60fps on flagships; deep-link-to-web for heavy edits.
4. Existing web subscribers see correct plan + credits (read from Supabase; no StoreKit).
5. Stripe Checkout in-app via `expo-web-browser`; web-originated purchases incur $0 Apple commission.
6. Push on job completion; best-effort background resume; realtime progress in foreground.
7. Crash-free ≥99.5% (7-day rolling); AI + biometric disclosures compliant; in-app account deletion present.
8. OTA channel (`expo-updates`) wired for JS-only hotfixes.

Anything below these bars is "released early," not "done."

---

## 12. Command reference

```bash
# Phase 1 — scaffold (from repo root)
npx create-expo-app apps/mobile --template            # expo-router template
cd apps/mobile
npx expo install expo-router expo-video expo-web-browser expo-auth-session \
  expo-apple-authentication expo-audio expo-media-library expo-document-picker \
  expo-notifications expo-updates @shopify/react-native-skia \
  react-native-reanimated react-native-gesture-handler \
  @supabase/supabase-js react-native-url-polyfill @react-native-async-storage/async-storage
eas init                                              # create EAS project
eas build:configure                                   # writes eas.json

# Dev build on a device (free Apple ID / any Android)
eas build --profile development --platform ios        # or android; install the dev client
npx expo start --dev-client

# Preview build for testers (needs Apple Developer for TestFlight)
eas build --profile preview --platform all

# Submit
eas submit -p ios      # to TestFlight / App Store
eas submit -p android  # to Play Internal Testing

# OTA JS-only update (no store review)
eas update --branch production --message "hotfix"
```

```ts
// Supabase in RN (Phase 3) — apps/mobile
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  'https://ayjbvcikuwknqdrpsdmj.supabase.co',
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } },
);

// Realtime job updates (same postgres_changes as web)
const channel = supabase
  .channel(`video_jobs:${userId}`)
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'video_generation_jobs', filter: `user_id=eq.${userId}` },
    (payload) => { /* update UI */ })
  .subscribe();
```

```ts
// Stripe checkout without StoreKit (Phase 12)
import * as WebBrowser from 'expo-web-browser';
// 1) render Apple's External Purchase disclosure sheet (a normal RN modal)
// 2) then:
await WebBrowser.openBrowserAsync(checkoutUrlFromCreateCheckoutEdgeFn);
```

---

## 13. API alignment — open architectural decision

Does mobile write **directly** to `video_generation_jobs` (like web today), or go through the planned versioned **`/api/v1` gateway** (`MOTIONMAX_API_ROADMAP.md`)? The tension is unchanged by using Expo.

**This plan bakes in the pragmatic middle (Option C) by default:** all render/job code goes through a single **`JobsGateway`** interface in `packages/shared/api` (consumed by `apps/mobile/features/render`). Phase 10 implements it as direct-INSERT (matching web); when `/api/v1` GAs, we swap the implementation **in one file** — call sites (RemoteRender, monitoring, Voice, AutoPost) never change. This isolates the churn and keeps mobile from being "legacy on day one" without gating the mobile timeline on the API track's GA date.

Security caveat (from the readiness assessment), independent of client tech: **job-creation + credit writes must sit behind a server-enforced gateway** before real traffic — a direct client-side INSERT that also moves credits is a payment-forge surface. In this plan that hardening is a property of the `JobsGateway` implementation (server-validated), not the client.

---

**End of document.** If you're an AI assistant resuming this: `Read` this file, then `git status` to check whether `apps/mobile/` exists, confirm §8 defaults + the §13 gateway decision with Jo, then dispatch Phase 1. **Do not implement StoreKit. Do not build v1 render on-device (remote-only). Do not expose an AI-disclosure toggle. Sign in with Apple is mandatory. Do not use inline scripts anywhere — everything CSP-strict.**
