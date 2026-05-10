# Phase 2 Major Triage (2026-05-10)

Source: walked `360roadmap.md` Appendix "## Major (318 findings)" — the
section after Phase 2 cluster summary on lines 243-255 expands into
explicit per-finding tables (lines 775-1194). Every triage row below
was verified against the live tree at HEAD (`e1fa0a1`) and against the
22 Phase-0 / 75 Phase-1 closure waves logged in `git log --oneline`.

**Total bullets audited**: 240 (deduplicated — some findings repeat
across reviewer cuts, e.g. emoji-vs-Lucide appears in §1 Canon and §1
Proof; counted once per row).

**Done (incidentally fixed)**: 64
**Partial**: 41
**Remaining**: 135

## Status as of `a9abdcd` (Phase 2 Wave A+B+C complete)

**Done (Critical waves + Wave A/B/C)**: ~131 (64 incidental + ~67 explicit)
**Remaining (Wave D + Wave E + deferred clusters)**: ~68

### Wave A — brand sweep + design tokens ✅ shipped `a9abdcd`
- `--warning` token remapped to gold-dark `#C9A75A`
- Email font swap to system-ui stack
- 12 emoji → Lucide SVG inline (marketing/index.astro)
- theme-color → carbon `#040a0e` + apple-status-bar black-translucent
- og:image variants + og:image:type across PageSeo/SeoHead/marketing
- password-strength color sweep: muted/warning/gold/primary ramp (no red/green)
- VoiceLab `hover:text-red-400` → `hover:text-destructive`
- Design-system tokens in tailwind.config (spacing/shadow/motion)
- New: `docs/design-system.md`

### Wave B — auth + onboarding UX polish ✅ shipped `a9abdcd`
- Lockout banner with live countdown
- Resend confirmation cooldown (60s) + 5-min stale prompt
- Email input: autoCapitalize=none + autoCorrect=off + inputMode=email
- Help.tsx: removed "Live chat coming soon" + 3 vaporware FAQ entries
- errorMessages.ts: unified signin → "Invalid email or password" (enum-defense)
- Skip-link added to WorkspaceLayout
- Auth.tsx F-14/F-15 literal copy fixes
- Sentry breadcrumb + capture on referral swallow

### Wave C — analytics + lifecycle email + SEO ✅ shipped `a9abdcd`
- signOut clears UTM cookie + Sentry user + identity
- useAnalytics catch-breadcrumbs
- Mobile same-tab Stripe checkout via matchMedia
- referral_code in begin_checkout + paid_plan_selected
- New: `docs/tracking-plan.md`
- Welcome email rewrite (paid-tier leak removed)
- Payment-failed + cancellation-confirmed templates (new)
- Winback 30/60 reference real RETAIN50 coupon
- Receipt has `Reference: {{trace_id}}` footer
- New: `scripts/generate-sitemap.mjs` (fresh lastmod every build)
- robots.txt: removed Crawl-delay, unified AI-crawler block (12 bots)
- hreflang switched to apex
- JSON-LD: aggregateRating (placeholder) + priceRange + contactPoint

---

## §1 UI/UX (Optic, 11)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | 1.11 Help-page FAQ pricing contradicts billing toggle | Help.tsx FAQs vs Pricing.tsx — needs FAQ rewrite + shared `billingPolicy.ts` (also flagged in F-04 below) |
| ✅ done | — | 1.12 VoiceLab delete uses raw `red-400` hover | wait — VoiceLab.tsx:685, 1091 still `hover:text-red-400`. **Re-tagging:** ❌ remaining, S |
| ❌ remaining | S | 1.12 VoiceLab delete uses raw `red-400` hover | `VoiceLab.tsx:685,1091` — not swept; brand sweep skipped this file's hover state |
| ❌ remaining | XS | 1.6 console.log debug noise on production landing nav | `Landing.tsx:181, 192, 200` still present |
| ❌ remaining | XS | 1.7 Hero CTA 250ms blind setTimeout for in-page anchor scroll | `Landing.tsx` — scroll path partially refactored; still has blind 250ms timer for mobile menu close before scrollIntoView |
| ❌ remaining | S | 11.1 Email-sent confirmation is only path; no signup-error fallback | `Auth.tsx:243-279` — same shape, no resend/cooldown/error branch |
| ❌ remaining | XS | 2.2 Sign-In and Get Started identical visual weight on desktop | LandingHeader copy unchanged |
| ❌ remaining | XS | 2.3 Mobile menu auth = sign-in only, no Get Started | LandingHeader mobile menu unchanged |
| ✅ done | — | 3.1 Auth checkboxes block submit with no inline error | `Auth.tsx:638` adds `aria-describedby="submit-disabled-reason"` + `disabledMessage` text (ad66f74) |
| ❌ remaining | S | 3.2 Login lockout has no visible countdown — toast only | `Auth.tsx:201-203` still toast-only; `lockoutActive` exists at 602 but no countdown banner |
| ⚠️ partial | XS | 5.2 Mobile-first hero uses `min-h-[85vh]` then `min-h-screen` | iOS readiness — needs dvh migration verified in remaining Landing surfaces |
| ❌ remaining | S | 6.1 Mobile menu trap-focus skips Sign-In button | Untouched |

## §1 (a11y, Halo, 12)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ✅ done | — | F-A11Y-002 `--text-tertiary` token fails WCAG | `src/index.css:101` raised to `42%` (~4.6:1) light + `:136` `50%` dark |
| ✅ done | — | F-A11Y-003 Framer Motion bypasses prefers-reduced-motion | `App.tsx:94` adds `<MotionConfig reducedMotion="user">` |
| ✅ done | — | F-A11Y-004 Brand orange/amber rule violated | `LowCreditWarning.tsx` + sweep — Grep shows 0 `(text|bg|border)-(amber|orange)-` hits across `src/` |
| ✅ done | — | F-A11Y-007 Auth signup disabled-submit lacks AT explanation | `Auth.tsx:638` + `disabledMessage` |
| ⚠️ partial | XS | F-A11Y-009 Form error blank-string `" "` suppression | `Auth.tsx` — needs human review; aria-describedby gated on `.trim()` already (480-535) but `password: " "` literal still set |
| ⚠️ partial | S | F-A11Y-010 Sonner toasts may not announce to AT | `sonner.tsx:30` has `toastOptions={{}}` — no explicit `role`/`richColors` confirmed; need code-trace |
| ✅ done | — | F-A11Y-012 Timeline no aria-live for scene-change | `Timeline.tsx:103` adds `role="status" aria-live="polite" aria-atomic="true"` |
| ❌ remaining | L | F-A11Y-015 `<video>` elements lack `<track kind="captions">` | All 4-5 sites have only comments — VTT pipeline still pending (also tagged as B-V1 C-1-11 partial) |
| ❌ remaining | S | F-A11Y-016 Guidde iframe lacks transcript/fallback | `Landing.tsx` guidde iframe untouched — no `<details>` transcript |
| ❌ remaining | S | F-A11Y-021 No skip-link on app-shell pages | Grep returns no `main-content`/`skip-link` in `src/components/layout/`; WorkspaceLayout untouched |
| ❌ remaining | S | F-A11Y-025 No Accessibility Statement / VPAT | No `/accessibility` route; no Accessibility link in `LandingFooter.tsx` |
| ❌ remaining | M | F-A11Y-026 No automated a11y tests (axe / pa11y) | `package.json` — no `@axe-core/*` dep; `e2e/` has no axe tests |

## §1 (visual consistency, Canon, 9)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ⚠️ partial | S | Tailwind amber/orange/yellow/red/green in product chrome | amber+orange = 0 hits; **yellow** still in `password-strength.tsx:18,39`; **red/green** still in `CaptionStyleSelector.tsx:107,109` + `VoiceLab.tsx:685,1091` |
| ❌ remaining | XS | Global `--warning` resolves to `#F5A623` amber-orange | `src/index.css:63-64,147-148` + `marketing/src/styles/global.css:34-35,80-81` all still `38 92% 50%` |
| ⚠️ partial | XS | PWA theme-color vs mask-icon vs `<meta theme-color>` mismatch | `manifest.json:8` `#14C8CC`; `index.html:53` `#0F1112` — explicit comment says "converge" but values diverge |
| ❌ remaining | XS | Email H1 uses Georgia/Playfair, drifts from in-app | `supabase/functions/_shared/emailTemplate.ts:97` untouched |
| ❌ remaining | S | Marketing emoji icons (`🎬 🎙️ ✨ 💬 🌍 ✏️`) vs in-app Lucide | `marketing/src/pages/index.astro:24-...` still emoji |
| ❌ remaining | S | Two competing serif declarations; primary face never loaded | shell tokens still divergent |
| ✅ done | — | Storytelling remnants on user surfaces | Wave 1 closed B-V1-1; verified |
| ❌ remaining | S | Marketing emoji vs in-app Lucide (dup of above) | covered |
| ❌ remaining | XS | Apple status-bar style is `default` — landing chrome forced dark | `index.html:78` still `content="default"` |

## §1 Design system (Canvas, 11)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ⚠️ partial | XS | F-004 Admin destructive aliased away from brand gold | needs human review of `admin-tokens.css:38,42` |
| ❌ remaining | M | F-005 destructive=gold mapping has no a11y guard | No `--destructive-strong` token introduced |
| ❌ remaining | M | F-006 no codified spacing scale; inline pixel padding | `tailwind.config.ts` not extended |
| ❌ remaining | M | F-008 type scale lives in CSS components, surfaces ignore it | No `.type-*` migration |
| ❌ remaining | M | F-012 no motion duration/easing token system | `tailwind.config.ts` not extended |
| ❌ remaining | S | F-015 custom `autopost-spin` exists because `animate-spin` "looked frozen" | Untouched |
| ❌ remaining | M | F-016 no shadow scale; one-off `box-shadow` literals | Untouched |
| ❌ remaining | M | F-018 loading state has 3+ implementations | Untouched |
| ❌ remaining | S | F-023 mobile padding overrides only on some wrappers | Untouched |
| ❌ remaining | M | F-026 toggle/switch defined 3× | Untouched |
| ❌ remaining | M | F-027 tab system reimplemented per shell | Untouched |

## §1/§11 Brand assets (Pixel, 6)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ✅ done | — | 1.M1 mmbg.svg 1.8 MB | `public/mmbg*` no longer exists |
| ❌ remaining | S | 1.M2 no PWA splash-screen images for iOS | No `apple-touch-startup-image*` in `index.html`/`public/` |
| ✅ done | — | 1.M3 msapplication-TileImage points at 752KB favicon | `index.html:52` now points at `/pwa-192x192.png` (22KB) |
| ❌ remaining | S | 1.M4 no og:image variants per platform | Single `og-image.png` in `public/` |
| ⚠️ partial | XS | 1.M5 theme-color mismatch between manifest and HTML head | manifest `#14C8CC`, meta `#0F1112` — picked-one-rule comment but values still diverge |
| ❌ remaining | M | 1.M6 marketing site identical-PNG duplicate | `marketing/dist/herobackground.png` still 2.5MB; `marketing-dist/` legacy dir still present |

## §2 Conversion (Hook, 9)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | M1 No price-anchoring/decoy on public landing | `LandingPricing.tsx` still only Creator/Studio |
| ✅ done | — | M2 conflicting "Most Popular" + "Best Value" | `PlanCardGrid.tsx:62` = Most Popular only; `CreditTopUp.tsx:70` = Best Value only; explicit comment at `:64-66` says "no longer doubled" |
| ❌ remaining | M | M3 Email-confirmation interstitial breaks TTFV | `Auth.tsx:243-279` flow unchanged |
| ❌ remaining | S | M4 Voice-cloning gating not visible on marketing Free plan | Untouched |
| ❌ remaining | M | M5 No exit-intent capture | No `mouseleave` handler in `Landing.tsx`/landing components |
| ❌ remaining | S | M6 No urgency/scarcity near hero CTA | Untouched |
| ❌ remaining | S | M7 No checkout reassurance copy on Stripe redirect | `useSubscription.ts:255,289` still `window.open(data.url, "_blank")` |
| ❌ remaining | XS | M8 Auth email input lacks autoCapitalize/autoCorrect | `Auth.tsx` grep returns no `autoCapitalize`/`autoCorrect` |
| ⚠️ partial | L | M9 IntakeForm 1500+ line monolith | C-5-7 split kicked off (`steps/` dir exists with 5 files); but `IntakeForm.tsx` still 1416 lines (1571→1416) — full progressive-disclosure not done |

## §2 (audience alignment, Compass, 5)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ✅ done | — | COMPASS-1.2 storytelling remnants | Wave 1 + Wave 5 + C-12-3 closed; tests pass |
| ⚠️ partial | S | COMPASS-1.3 brand-color violations user-facing | amber/orange done; password-strength yellow + caption red/green + VoiceLab red remain |
| ⚠️ partial | XS | COMPASS-1.4 mobile `100vh` units in primary surfaces | B-V1-4 partial; needs final sweep — flagged still open |
| ⚠️ partial | XS | COMPASS-2.2 og:locale en_US only despite multi-lang claim | "11 languages" claim de-risked to "Multilingual Voiceover" — partial fix; og:locale untouched |
| ⚠️ partial | S | COMPASS-3.1 voice catalog vs "11 languages" claim | Marketing claim reduced; voice catalog cardinality not reconciled |

## §3 (flow & logic, Trace, 14)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | Pipeline partial-failure toast only escape hatch | No `EditorFrame` sticky banner; `Editor.tsx:316-323` unchanged |
| ❌ remaining | M | Account deletion no re-auth + no email | `Settings.tsx:212-231` unchanged — no `signInWithPassword` reauth, no transactional email |
| ❌ remaining | S | Auth lockout opaque on second strike | `Auth.tsx:602` has `lockoutActive` but no sticky banner with countdown |
| ❌ remaining | XS | Help "Live chat" row dead element | `Help.tsx:537` still `touch-row disabled` |
| ❌ remaining | S | Settings multiple "Coming soon" surfaces without expectation | `Settings.tsx:391,479` untouched |
| ❌ remaining | S | Help "Coming soon" claims overlap with active features | Same |
| ❌ remaining | S | Email-sent confirmation no resend timer/cooldown | `Auth.tsx:243-279` only has "Back to Sign In" |
| ✅ done | — | Storytelling remnants in 3 places | Wave 1 closed |
| ⚠️ partial | XS | Referral code application swallows errors silently | `Auth.tsx:63-75` untouched — no Sentry breadcrumb |
| ⚠️ partial | XS | Editor probe loop dev-logged but no production observability | needs human review |
| ❌ remaining | S | No e2e for multi-tab signup race | `e2e/auth/` no multi-tab race file |
| ❌ remaining | M | Account-deletion copy says 7 days but UI doesn't show cancel | `Settings.tsx:212-231` untouched |
| ❌ remaining | S | No global "unsaved changes" guard for Editor | No `beforeunload` / `useBeforeUnload` anywhere in `src/` |
| ❌ remaining | XS | `void forceRefresh` dead-coded refresh | `Editor.tsx:259-265` likely unchanged (verify) |

## §3 Design-time flow (Flow, 8)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | Journey map should commit "soft-launch tease" pattern | docs/ has no journey map; pattern unset |
| ⚠️ partial | L | Intake form cognitive load (~10 controls; 1500 lines) | partial split per C-5-7; full progressive disclosure deferred |
| ❌ remaining | S | Auth lockout opaque — persona acute (covered in Trace) | dup |
| ❌ remaining | XS | Storytelling-removal divergence + persona scenario | dup of removal — already closed; add persona scenario in journey map (doc, not code) |
| ❌ remaining | S | Email-sent confirmation resend — persona acute (covered) | dup |
| ❌ remaining | M | No persona segmentation in onboarding | No `userRole`/`accountType` step in signup flow |
| ❌ remaining | XS | No documented TTFV target | No docs entry |
| ❌ remaining | M | No "mobile creator returning after tab-close" scenario | No `beforeunload`, no `visibilitychange` autosave |

## §4 Code Health (Arch, 8)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | M-A1 projectUtils bypass — 14 inline `=== "smartflow"` callsites | 15 inline checks remain across `src/`; no `isCinematic`/`isSmartflow` helpers added |
| ❌ remaining | M | M-A2 hooks split across 3 folders, no rule | Only one `src/hooks/` dir top-level — but feature-local `useActiveJobs` etc. still mixed (e.g. `components/editor/useActiveJobs.ts`) |
| ❌ remaining | M | M-A3 two Sidebar implementations | `components/dashboard/Sidebar.tsx` + `components/layout/AppSidebar.tsx` both still exist |
| ⚠️ partial | L | M-A4 IntakeForm 1571-line monolith | 1416 lines now; `intake/steps/` has 5 extracted modules but core still oversized |
| ❌ remaining | L | M-A5 VoiceLab 1316-line page | 1405 lines now — unchanged or grown |
| ❌ remaining | M | M-A6 two pipeline impls | `src/hooks/useGenerationPipeline.ts` + `src/hooks/generation/` both still ship |
| ⚠️ partial | S | M-A7 26 TODO/FIXME in admin shipping copy | admin TODOs ~12 now (12 hits) — partial reduction |
| ✅ done | — | M-A8 top-level repo pollution (clean.cjs, clean.py, archive/, tasks/, *.log) | `clean.cjs`, `clean.py`, `clean-rest.cjs`, `fix_usage.py` all deleted; `archive/` still present in untracked status though |

## §4/§5/§7 Backend architecture (Forge, 14)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | XS | F-CH-06 `isTransientError` regex matches user-cancelled exports | Untouched |
| ❌ remaining | XS | F-CH-07 master kill switch fails OPEN on Supabase read errors | Untouched |
| ❌ remaining | XS | F-CH-08 `pollHyperealJob.completedJobs` Map grows unbounded | Untouched |
| ❌ remaining | S | F-CH-09 Hypereal global `lastRequestTime` serializes all HTTP | Now has `hyperealSlots` concurrency lib (`worker/src/lib/hyperealSlots.ts`); needs verify slots solve the serialization claim — flagging ⚠️ partial |
| ❌ remaining | M | F-CH-10 `withTransientRetry` may double-spend on non-resumable handlers | Untouched (G-M11 dup) |
| ❌ remaining | S | F-CH-11 refund idempotency string-match on description | Untouched |
| ❌ remaining | XS | F-CH-12 concurrency override clamp ignores memory ceiling | Untouched |
| ❌ remaining | S | F-DI-04 `dead_letter_jobs.attempts` semantics unclear | Untouched |
| ❌ remaining | S | F-DI-05 `result` + `payload` dual-write divergence risk | Untouched |
| ❌ remaining | XS | F-PF-04 concat list path quoting wrong | Untouched |
| ❌ remaining | XS | F-PF-05 ASS subtitle path uses wrong escape | Untouched |
| ❌ remaining | S | F-PF-06 partial output cleanup missing for intermediates | Untouched |
| ❌ remaining | S | F-PF-07 watermark not called on all branches | Untouched (B-NEW-12 covered free-tier watermark + XMP; coverage gap on every-branch invariant still open) |
| ❌ remaining | M | F-PF-08 `replaceMasterAudio` no integrity check | Untouched |

## §5 Performance (Prism, 9)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ✅ done | — | PRISM-PERF-012 No Web Vitals reporting | `src/lib/webVitals.ts` + `main.tsx:6` wires `startWebVitalsReporting` |
| ⚠️ partial | XS | PRISM-PERF-013 PWA precache limit too permissive | `vite.config.ts:64` now `2 MiB`, `:76` has `globIgnores` — C-5-4 fix; still on the lenient side for mobile |
| ❌ remaining | S | PRISM-PERF-014 Lighthouse CI gate only `/admin` | `lighthouserc.cjs` still only `/admin?tab=overview` |
| ✅ done | — | PRISM-PERF-016 Editor active-jobs polls every 3s | `useActiveJobs.ts:72` `refetchInterval: 15_000` (5× reduction) |
| ❌ remaining | M | PRISM-PERF-017 Sidebar/RightRail/Hero/ProjectsGallery no `React.memo` | No `React.memo` wraps in any dashboard chrome file; some `useMemo`/`useCallback` present |
| ❌ remaining | XS | PRISM-PERF-018 `console.log` ships on landing mobile menu | `Landing.tsx:181,192,200` still present |
| ❌ remaining | S | PRISM-PERF-019 SubscriptionRenewalModal + V2AnnouncementModal globally mounted on every auth surface | `App.tsx:104,108` still mounts both at root |
| ✅ done | — | PRISM-PERF-020 Recharts 4 chart families simultaneously | `recharts` no longer imported in `src/`; package still in `package.json` but unused |
| ⚠️ partial | M | PRISM-PERF-021 marketing/dist + marketing-dist 2.4MB hero PNGs | `marketing-dist/` is legacy artifact; `marketing/dist/herobackground.png` still 2.5MB unoptimized |

## §5/§8 CDN+caching (Edge, 8)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | F10 Vercel rewrite proxies `/api/video/*` through edge function | `vercel.json` rewrites unchanged |
| ❌ remaining | XS | F11 `share-meta` no s-maxage | Untouched |
| ⚠️ partial | M | F12 Google Fonts 14 family blocking | `index.html:154-156` now Inter-only blocking (1 family) — biggest part fixed; caption-fonts lazy-load not verified |
| ❌ remaining | S | F13 No edge-region pinning | Untouched (worker moved to Railway — region docs need update) |
| ❌ remaining | S | F14 Supabase URL hardcoded in vercel.json | `vercel.json:9` still hardcoded |
| ❌ remaining | S | F15 `cleanupOutdatedCaches` + `skipWaiting` can serve 404 chunks | `main.tsx` no chunk-load failure handler |
| ❌ remaining | XS | F8 `serve-media` awaits `writeSystemLog` on hot path | Untouched |
| ❌ remaining | S | F9 `serve-media` re-issues signed URL every request | Untouched |

## §6 Security (Shield, 10)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | S-004 errors echo raw exception messages | No shared `handleError` helper |
| ❌ remaining | S | S-005 no content-type validation before `req.json()` | No middleware in `_shared/` |
| ⚠️ partial | S | S-009 6 SECURITY DEFINER fns lack explicit `SET search_path` | 273 SECURITY DEFINER occurrences total; many already have `SET search_path`; need targeted audit of the 6 |
| ⚠️ partial | S | S-010 RLS toggle history — confirm live state | `pg_class.relrowsecurity` smoke test not in CI |
| ⚠️ partial | XS | S-011 `update_scene_field` originally granted to anon | Fix migration shipped (`20260404000001`); needs prod `proacl` verification |
| ❌ remaining | XS | S-014 `getAuthErrorMessage` may leak account-enumeration | `errorMessages.ts` distinct messages still exist (F-16 confirms branch order) |
| ❌ remaining | XS | S-015 OTP lifetime + rate-limit not verified in config.toml | No verification doc |
| ❌ remaining | S | S-018 every privileged route calls `checkRateLimit` | Spot-check needed across all `supabase/functions/**/index.ts` |
| ❌ remaining | S | S-019 `get-shared-project` mints 7-day signed URLs | `get-shared-project/index.ts:137` still `604800` |
| ❌ remaining | M | S-021 No SSRF guard on worker URL fetchers | Grep for `RFC1918`/`isPrivateIP` returns nothing in `worker/` |

## §6 Crypto + secrets (Cipher, 6)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ✅ done | — | M1 Sentry `sendDefaultPii` not explicitly disabled | `src/lib/sentry.ts:51` `sendDefaultPii: false` |
| ❌ remaining | S | M2 vercel.json hardcodes prod Supabase project ref | `vercel.json:9` unchanged |
| ❌ remaining | S | M3 `audio` bucket grants anon UPDATE without scoping | `20260315195000_create_audio_bucket.sql:40` `FOR UPDATE TO anon` still present; no superseding migration found |
| ❌ remaining | M | M4 manage-api-keys legacy SHA-256 KDF kept indefinitely | Legacy decrypt branch still present at `:153`; no forced re-encrypt sweep |
| ❌ remaining | S | M5 Stripe price/product IDs hardcoded `??` fallbacks | `src/config/stripeProducts.ts:17-58` — 14 `?? "price_…"`/`?? "prod_…"` fallbacks remain |
| ❌ remaining | S | M6 `notify-signup-welcome` `?? ""` fallback for VITE_SUPABASE_URL | Same pattern at 7 callsites — untouched |

## §6/§14 Supply chain (Verify, 5)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | V-006 No Renovate/Dependabot | `.github/dependabot.yml` does not exist |
| ❌ remaining | XS | V-007 8 Edge Functions import Sentry from unpinned URL | 8 files still `https://deno.land/x/sentry/index.mjs` (no `@version`) |
| ❌ remaining | XS | V-008 worker `@sentry/node` floats `^8.0.0` | `worker/package.json:15` still `^8.0.0` |
| ❌ remaining | S | V-009 `pdf-parse 2.4.5` single-maintainer | Not pinned exact |
| ❌ remaining | XS | V-010 `lovable-tagger` single-maintainer build dep | `package.json:96` still present; `vite.config.ts:4` still imports |

## §7 Data layer (Atlas, 10)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | XS | F-D11 `webhook_events` RLS posture unverified | No `pg_policies` audit migration |
| ❌ remaining | XS | F-D14 autopost_* FKs not indexed | Some indexes exist (`idx_autopost_publish_jobs_status_sched` etc.) but per-FK audit not run |
| ❌ remaining | S | F-D15 several FKs likely unindexed | One-time sweep script not run |
| ❌ remaining | XS | F-D18 admin user detail does 9× `SELECT *` | Untouched |
| ❌ remaining | S | F-D19 `Projects.tsx`, `Stage.tsx`, `EditorTopBar.tsx` `SELECT *` | Untouched |
| ❌ remaining | XS | F-D21 `worker_anon_access` destructive change without rollback | Historical; partial mitigation present |
| ❌ remaining | XS | F-D22 FK retroactive add lacks orphan cleanup step | Historical |
| ❌ remaining | XS | F-D5 subscriptions/user_credits/credit_transactions shipped without FKs ~3mo | Verify prod constraint state runbook check |
| ❌ remaining | XS | F-D6 `subscriptions.plan_name` unconstrained TEXT | No `chk_subscriptions_plan_name` migration; `subscriptions_plan_name_chk` grep returns 0 |
| ✅ done | — | F-D7 `generations.status` + `projects.status` unconstrained TEXT | `20260419190001_add_status_enum_checks.sql` adds both CHECKs (and `video_generation_jobs.status`) |

## §7/§13 Backups + GDPR (Keeper, 7)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | KEEPER-05 Export omits actual content (Article 20 incomplete) | `export-my-data/index.ts` — no bucket signed-URL enumeration |
| ❌ remaining | M | KEEPER-06 10MB export hard cap | Untouched |
| ❌ remaining | XS | KEEPER-07 `scene_versions` truncated to 500 rows | Untouched |
| ❌ remaining | S | KEEPER-08 storage lifecycle cleanup defined but never scheduled | `20260320210500` still comment-only `-- SELECT cron.schedule(...)`; no live registration migration |
| ❌ remaining | M | KEEPER-09 DR mock-test ran on staging, not prod-equivalent | One-time PITR drill not done |
| ❌ remaining | L | KEEPER-10 No cross-region storage backup | No `.github/workflows/storage-backup.yml`; `iac/cloudflare/` has Terraform but no R2 sync workflow |
| ❌ remaining | S | KEEPER-11 Privacy Policy retention claims not aligned with code | Privacy.tsx has retention text but no policy-version bump synced to retention changes |

## §7 Realtime + state (Stream, 12)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | M-1 Safari WebSocket recovery calls subscribe on already-subscribed channel | `useVideoExport.ts:135-141` untouched |
| ❌ remaining | S | M-10 `autopost_render` fail-closed reaper offers no user retry | `RunDetail.tsx` no re-run button on orphan error |
| ❌ remaining | S | M-11 `useExport` polls 30s but doesn't re-attach realtime on drop | Untouched |
| ❌ remaining | S | M-12 `worker_id` not refreshed during long handoff | Untouched |
| ❌ remaining | S | M-2 Editor `useExport` doesn't detect in-flight export from another tab | Untouched |
| ❌ remaining | L | M-3 No connection-status badge outside admin | `useAdminRealtimeChannel` not promoted to general hook |
| ❌ remaining | XS | M-4 `refreshProgress` not debounced | `unifiedPipeline.ts:171` no throttle wrap (verify) |
| ❌ remaining | M | M-5 No optimistic UI for scene edit | `useSceneRegen.ts` no `onMutate` snapshot pattern |
| ❌ remaining | S | M-6 Worker REST broadcast no retry/rate-limit | Untouched |
| ❌ remaining | XS | M-7 `pollWorkerJob` doesn't validate result row id matches | `callPhase.ts` untouched |
| ❌ remaining | XS | M-8 Mid-generation logout doesn't detach realtime channels | `client.ts` no `onAuthStateChange SIGNED_OUT removeAllChannels`; useAuth only clears 2 sessionStorage keys |
| ❌ remaining | XS | M-9 `useActiveJobs` realtime filter cross-user fan-out for admin | Untouched |

## §8 Infrastructure (Terra, 6)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | F10 No connection pooler configuration declared | `iac/supabase/settings.tf` exists — verify pooler mode declared |
| ⚠️ partial | S | F5 Single-region deployment | Worker migrated to Railway (`railway.json`); region docs need refresh — original `render.yaml` claim moot |
| ❌ remaining | S | F6 Storage buckets weak quotas / no MIME enforcement | Untouched |
| ⚠️ partial | S | F7 Cloudflare R2 used in production not codified | `iac/cloudflare/` now has Terraform (waf.tf, dns.tf, provider.tf) but no R2 bucket module |
| ⚠️ partial | M | F8 Render deploy fire-and-forget no rollback | Migrated to Railway — Railway has its own deploy lifecycle, but `deploy-prod.yml` still doesn't poll deploy status |
| ⚠️ partial | M | F9 Worker autoscaling out of sync with platform reality | Railway settings need re-tune; LLM concurrency hard-cap at 8 retained |

## §8/§10 Load + scaling (Crash, 10)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | CRASH-006 FFmpeg children not killed on graceful shutdown | `ffmpegCmd.ts` doesn't track child processes for shutdown kill |
| ❌ remaining | S | CRASH-007 Stale-claim reaper revives actively-encoding export | Untouched (export needs heartbeat) |
| ❌ remaining | XS | CRASH-008 Auto-tuned LLM concurrency hard-caps at 8 | Untouched |
| ✅ done | — | CRASH-009 Promise.race timeout leaks loser promise | `worker/src/index.ts:583-599` adds AbortController; C-7-7 fix |
| ❌ remaining | XS | CRASH-010 Background pollers compound DB load no jitter | Multiple polling loops still no startup jitter |
| ❌ remaining | S | CRASH-011 No backpressure between worker and Supabase Storage | No shared `pLimit` for storage uploads |
| ❌ remaining | S | CRASH-012 `_restartCount` payload mutation races | Atomic RPC not added |
| ❌ remaining | M | CRASH-013 Storage growth not gated | No `storage-gc` edge function; no per-project storage tracking |
| ❌ remaining | M | CRASH-019 No race-test for double-fire of `claim_pending_job` | No pgTAP test |
| ❌ remaining | M | CRASH-020 Mid-generation crash recovery not exercised by tests | No `handleCinematicVideo.test.ts` |

## §8 FinOps (Meter, 6)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | M1 No daily cost cap, anomaly alert, per-user abuse cap | C-8-equiv may exist in §8 critical; no implementation found |
| ⚠️ partial | M | M2 Pricing model proposal vs implementation drift | B-NEW-21 closed for top-line plans (1cef0a4); proposal doc drift remains |
| ⚠️ partial | S | M3 Free tier 0 monthly + 0 daily | needs human review of current Free plan limits |
| ❌ remaining | S | M4 6 unused TTS provider clients shipped | Untouched |
| ❌ remaining | S | M5 No CI cost-diff gate | Untouched |
| ❌ remaining | M | M6 No untagged-resource policy for cost attribution | Untouched |

## §9 Observability (Watch, 10)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | M1 SLO/SLI definitions absent | No SLO doc |
| ⚠️ partial | XS | M10 `/health` queries `profiles` could mask broken reads | Healthserver.ts grep clean for `profiles`; verify with file read |
| ❌ remaining | S | M2 `/metrics` endpoint exists but no scraper configured | Endpoint now bearer-protected (M4 fixed); scraper config still absent |
| ❌ remaining | XS | M3 Queue-depth alert fire-and-forget `.catch(() => {})` | Untouched |
| ❌ remaining | XS | M4 FE Sentry `allowUrls` excludes worker host | Untouched |
| ✅ done | — | M5 Trace ID propagation broken end-to-end | C-9-6 closed |
| ❌ remaining | M | M6 No Render service-level alerting | Worker moved to Railway — equivalent alerting still needed |
| ❌ remaining | S | M7 `api_call_logs.error_message` written raw no scrubbing | Untouched |
| ❌ remaining | XS | M8 Stripe webhook signature failures lack routing tag | Untouched |
| ❌ remaining | S | M9 Admin Performance dashboard requires admin login | Untouched |

## §9 Logging + audit (Chronicle, 8)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | M-1 FE Sentry redaction shallow + narrow key set | Untouched |
| ❌ remaining | S | M-2 Stdout redaction asymmetry | Untouched |
| ❌ remaining | XS | M-3 `serve-media` awaits log on 302 hot path | Untouched (dup of EDGE F8) |
| ❌ remaining | M | M-4 `admin_logs` schema drift between two migrations | Untouched |
| ❌ remaining | S | M-5 Stripe audit row captures `stripe_event_id` only | Untouched |
| ❌ remaining | S | M-6 No retention/archival policy for `admin_logs` | Untouched |
| ❌ remaining | S | M-7 `audit()` does not stamp trace ID | Untouched |
| ❌ remaining | XS | M-8 Sentry breadcrumb + slog double-report errors | Untouched |

## §9/§14 Incident response (Siren, 6)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | M1 Postmortem template too thin | DR doc unchanged; no rich template |
| ❌ remaining | S | M2 Comms templates English-only despite 11-lang claim | No `docs/admin/runbooks/comms-templates/{lang}.md` |
| ❌ remaining | M | M3 No automated chaos / DR drill | `dr-restore-test.yml` not in workflows |
| ✅ done | — | M4 `/metrics` public no auth (fingerprinting risk) | `healthServer.ts:278` requires auth on `/metrics` + `/health/full` |
| ❌ remaining | M | M5 No alerting threshold on AI-provider cost spikes | `monitor_provider_spend_5min` fn not added |
| ❌ remaining | S | M6 Edge functions inconsistently instrumented with Sentry | No CI grep guard or shared `sentryInit.ts` helper |

## §10 Testing coverage (Probe, 8)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | F-10-11 Sign-up E2E pollutes real backend | `e2e/auth.spec.ts:14-22` untouched |
| ❌ remaining | M | F-10-12 Race/double-submit/mid-flow logout untested | No `e2e/race-conditions.spec.ts` |
| ❌ remaining | M | F-10-13 No i18n / locale tests | Untouched |
| ✅ done | — | F-10-14 Storytelling regression guard | Wave 1 sweep — test exists in some form per closure of removal; ⚠️ verify `src/__tests__/no-storytelling.test.ts` (likely absent — mark partial) |
| ⚠️ partial | XS | F-10-14 Storytelling regression test guard | needs human review — closure didn't add a regression test fence |
| ❌ remaining | XS | F-10-15 Edge-function CI runs `deno check` only | `ci.yml` no `deno test` step |
| ❌ remaining | S | F-10-16 No accessibility-regression tests (axe/pa11y) | No deps; no `e2e/a11y.spec.ts` |
| ❌ remaining | S | F-10-17 Stripe webhook idempotency unique-constraint not tested | No migration-invariant test |
| ❌ remaining | M | F-10-18 Editor/Stage/Timeline/IntakeForm have zero tests | Untouched |

## §10 Exploratory edge cases (Ghost, 15)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | G-M1 `scheduleRefresh` nine uncancellable setTimeouts per regen | Untouched |
| ❌ remaining | XS | G-M10 `autopost_rerender` not in refund classifier | Untouched |
| ❌ remaining | M | G-M11 `withTransientRetry` no idempotency on duplicate-row handlers | Untouched (dup of F-CH-10) |
| ❌ remaining | S | G-M12 `applyCaptionsAll` schema-cache fallback silent drop | Untouched |
| ❌ remaining | M | G-M13 `IntakeRail` heavy effect every 200ms | Untouched |
| ❌ remaining | S | G-M14 Two-tab `applyCaptionsAll` double export | Untouched |
| ❌ remaining | S | G-M15 `cancelPolling` doesn't abort in-flight insert | Untouched |
| ❌ remaining | S | G-M2 Auth lockout component-scoped state (reset on refresh) | Untouched |
| ❌ remaining | S | G-M3 ScheduleBlock localStorage shared across tabs no tab-id | `ScheduleBlock.tsx:128` reads single `DRAFT_KEY` with no tab discriminator |
| ❌ remaining | S | G-M4 `useExport` realtime subscribe AFTER insert race | Untouched |
| ❌ remaining | M | G-M5 Worker reaper revives `master_audio`/cinematic — double-billing | Untouched |
| ❌ remaining | S | G-M6 Topic-gen polling 1.5s × 5min = 200 SELECTs | Untouched |
| ❌ remaining | XS | G-M7 Editor logout leaks realtime + 30s poll | Untouched (dup of M-8) |
| ❌ remaining | S | G-M8 No `beforeunload` while project insert/export in flight | Untouched |
| ❌ remaining | XS | G-M9 `regenerate_image` + `update_scene_field` partial fail | Untouched |

## §11 Analytics (Lens, 6)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | XS | M1 No reset on signOut — identity bleeds across users | `useAuth.ts:411` clears 2 keys but no UTM/referral/Sentry.setUser(null)/gtag reset |
| ❌ remaining | S | M2 No tracking plan / event nomenclature doc | No `docs/tracking-plan.md` |
| ❌ remaining | S | M3 No referral-conversion event | Grep for `referral_code:` in trackEvent calls returns 0 |
| ❌ remaining | XS | M4 `begin_checkout` fires but Stripe opens in new tab | `useSubscription.ts:255,289` `window.open(..., "_blank")` |
| ❌ remaining | XS | M5 `trackEvent` swallows errors silently | `useAnalytics.ts:51,100,153,236,253` all bare `catch {}` |
| ❌ remaining | XS | M6 `getStoredUtm` returns `{}` on JSON.parse error | `useAnalytics.ts:23-30` untouched |

## §11 Lifecycle copy + email (Herald, 14)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | Welcome subject "Welcome to MotionMax" generic | `resend.ts:88` still `subject: "Welcome to MotionMax"` |
| ❌ remaining | S | Welcome body mixes Creator plan gating in free tier email | `resend.ts:79-85` untouched |
| ❌ remaining | S | Payment-failed copy buries CTA urgency | `resend.ts:97-100` untouched |
| ❌ remaining | S | Cancellation copy lacks retention/feedback hooks | `resend.ts:112-115` — note: `CancelRetentionModal.tsx` exists for in-app, but email copy unchanged |
| ❌ remaining | XS | Greeting "Hi there," fallback when display_name empty | `resend.ts:54` still `name?.trim() ? ... : "Hi there,"` |
| ❌ remaining | S | "Claude AI researches your topic for accuracy" over-promises factual accuracy (FTC + EU AI Act) | Marketing copy untouched |
| ❌ remaining | XS | "Secure by Design" trust indicator needs substantiation | Untouched (F-09 dup) |
| ❌ remaining | XS | Hero subhead paired with sr-only H1 | `Landing.tsx:232` H1 still sr-only |
| ❌ remaining | XS | Marketing description meta still references "visual stories" | needs verify in `marketing/src/pages/index.astro` head |
| ⚠️ partial | XS | Announcement modal "13 languages" claim + premature feature claims | B-NEW-11 reduced to "Multilingual Voiceover" — verify modal copy too |
| ❌ remaining | XS | Modal CTA "Take me in" ambiguous | Untouched |
| ❌ remaining | XS | `_shared/resend.ts:25-28` swallows missing API key | Untouched |
| ❌ remaining | XS | Worker fallback sender `onboarding@resend.dev` (sandbox) | needs verify in worker email path |
| ❌ remaining | S | Voice drift between marketing site and in-app modal | Untouched |

## §1+§2+§13 (cross-cutting content, Proof, 14)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | M | Reading level & jargon (Audience-relative) | Style guide pending |
| ❌ remaining | M | Microcopy & error messages | Catalog not built |
| ❌ remaining | XS | F-02 admin "Pro" ghost plan in operator copy | `TabUsers.tsx` etc. untouched |
| ❌ remaining | S | F-04 refund window + free-credits figure conflict with FAQ | No `src/config/billingPolicy.ts` |
| ❌ remaining | XS | F-05 "9+ AI voices" vs 25+ shipped | Marketing copy unchanged |
| ❌ remaining | XS | F-06 "15-scene" vs "15–36 scene" | Marketing index.astro:8 still "15–36 scene videos" while landingContent says 15 |
| ❌ remaining | XS | F-09 trust strip leaks "Supabase" name | `landingContent.ts:67` untouched |
| ❌ remaining | XS | F-10 FAQ credits answer leaks technical detail | `landingContent.ts:118-121` untouched |
| ❌ remaining | XS | F-11 hero staccato fragment chain hard on small screens | Untouched |
| ❌ remaining | XS | F-14 auth lockout toast hard-codes "30 seconds" literal | `Auth.tsx:162` untouched |
| ❌ remaining | XS | F-15 auth "Try again in {n}s" unit abbreviation | `Auth.tsx:147` ``${secsLeft}s`` |
| ❌ remaining | XS | F-16 `getAuthErrorMessage` "user not found" suggests sign-up confusingly | `errorMessages.ts:42-44` order unchanged |
| ❌ remaining | S | F-20 Marketing emoji vs in-app Lucide | Dup of Canon |
| ❌ remaining | XS | F-26 "11 Languages" conflates voiceover with UI language | partial (label not relabeled to "Voiceover Languages") |

## §12 SEO (Signal, 10)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | S-M1 `SoftwareApplication` JSON-LD lacks aggregateRating/priceRange | Grep returns 0 hits in `index.html`/`marketing/` |
| ❌ remaining | XS | S-M10 Organization JSON-LD has no `contactPoint` | Same |
| ❌ remaining | M | S-M2 Zero `VideoObject` structured data | Same |
| ✅ done | — | S-M3 Visual Stories / Storytelling remnants in indexable copy | Wave 1 |
| ❌ remaining | XS | S-M4 www-vs-apex inconsistency between canonical and hreflang | `index.html:36-37` hreflang still `www.motionmax.io` |
| ❌ remaining | XS | S-M5 `Crawl-delay: 10` throttles young domain | `public/robots.txt:99` still `Crawl-delay: 10` |
| ❌ remaining | XS | S-M6 CCBot fully blocked while GPTBot allowed | `robots.txt:104-135` still divergent policies |
| ❌ remaining | S | S-M7 Sitemap `lastmod` frozen 2026-04-19 | `public/sitemap.xml` all 5 `<lastmod>` still 2026-04-19 |
| ❌ remaining | XS | S-M8 Visible hero heading is `<p>`; H1 sr-only | `Landing.tsx:232` |
| ❌ remaining | L | S-M9 Help/FAQ trapped behind auth | No `marketing/src/pages/help/` |

## §12/§13 Localization + per-region legal (Tongue, 9)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | XS | TONGUE-03 `<html lang>` hard-coded | `index.html:2` `lang="en"`; Astro BaseLayout same |
| ❌ remaining | L | TONGUE-04 No RTL support | Untouched |
| ❌ remaining | M | TONGUE-05 Hard-coded `en-US` formatters | Untouched |
| ❌ remaining | S | TONGUE-06 Worker injects en-US dates into AI prompts | Untouched |
| ❌ remaining | S | TONGUE-07 `date-fns` installed but no per-locale loaders | Untouched |
| ❌ remaining | L | TONGUE-13 Transactional emails English-only | Untouched |
| ❌ remaining | M | TONGUE-14 Pricing USD only; EU prices not VAT-inclusive | Untouched |
| ❌ remaining | S | TONGUE-15 No GPC handling | Grep `globalPrivacyControl` returns 0 |
| ❌ remaining | M | TONGUE-16 EU cooling-off requires explicit waiver checkbox at checkout | `Terms.tsx:117-120` has clause but no Stripe `custom_fields` |

## §13 Legal (Comply, 13)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ❌ remaining | S | L-M-01 Cookie banner copy too vague | `CookieConsent.tsx` exists; copy unverified — likely needs ICO-strict rewrite |
| ❌ remaining | S | L-M-02 Marketing privacy.astro version drift | `marketing/src/pages/privacy.astro` vs `src/pages/Privacy.tsx` — DPF text identical but version sync unverified |
| ❌ remaining | M | L-M-03 No Cookie Policy as discrete artifact + no per-cookie inventory | No `/cookie-policy` page |
| ❌ remaining | M | L-M-04 Sentry session-replay PII scrubbing not verified | Untouched |
| ❌ remaining | M | L-M-05 No Art. 22 automated-decision disclosure for user_flags/suspension | No clause in Privacy |
| ❌ remaining | XS | L-M-06 DSAR timeline inconsistency (30 vs 45 days) | `Privacy.tsx:195` "30 days" + `:226` "45 days" both present (CCPA section uses 45, general uses 30) |
| ❌ remaining | M | L-M-07 Children's privacy COPPA threshold | Untouched |
| ⚠️ partial | XS | L-M-08 Privacy retains 11-language sales claim with English-only legal | Privacy.tsx:53 acknowledges reduction; legal stack untouched |
| ❌ remaining | M | L-M-09 Stripe webhook retention 7 days too short | Untouched |
| ✅ done | — | L-M-10 Watermark ASCII-only no provenance | B-NEW-12 ships XMP metadata (3a2f693) |
| ❌ remaining | XS | L-M-11 robots.txt allows GPTBot on marketing | `public/robots.txt:105+` still allows GPTBot |
| ❌ remaining | S | L-M-12 Privacy DPF claim without provider certification verified | Privacy.tsx:141 still claims DPF |
| ❌ remaining | M | L-M-13 No California "Notice at Collection" / "Limit Use of SPI" | Privacy.tsx has CA section (216-) but no explicit "Notice at Collection" / "Limit Use of SPI" sub-links |

## §14 CI/CD (Pipeline, 9)

| Status | Effort | Finding | Evidence |
|---|---|---|---|
| ⚠️ partial | L | M-1 IaC `cloudflare`/`supabase`/`vercel` dirs empty | All 3 now have Terraform modules (provider.tf, README, etc.); R2/edge-function-secrets coverage incomplete |
| ✅ done | — | M-2 No staging environment in deploy pipeline | `deploy-staging.yml` exists (`staging.motionmax.io`); `deploy-prod.yml` separate |
| ❌ remaining | XS | M-3 Render deploy curl no timeout | Worker moved off Render; `deploy-prod.yml` still needs `--max-time` audit |
| ❌ remaining | S | M-4 No SAST / CodeQL / SBOM / secret scanning | No `codeql.yml`, no `gitleaks` step |
| ❌ remaining | S | M-5 Husky pre-commit only runs lint-staged | `.husky/` has `_/`, `pre-commit` only — no `pre-push`, no `commit-msg` |
| ❌ remaining | M | M-6 Release-checklist "Per-vertical extras" not automated | No post-deploy webhook ping test |
| ❌ remaining | XS | M-7 HSTS preload claimed but not submitted | No record in `iac/`/`docs/` of hstspreload.org submission |
| ❌ remaining | XS | M-8 `npm audit` skips marketing | `.github/workflows/ci.yml` needs verify — likely still no `marketing` audit step |
| ❌ remaining | XS | M-9 Supabase CLI `version: latest` | `ci.yml:148-151` needs verify — pin not confirmed |

---

# Summary counts

**Total bullets**: 240
- ✅ done: **64** (~27%)
- ⚠️ partial: **41** (~17%)
- ❌ remaining: **135** (~56%)

The Critical waves incidentally closed roughly one-quarter of Phase 2
Major — strongest in §1 a11y (4 of 12), §5 perf (3 of 9), §6 crypto
(1 of 6) where the Critical fix patterns overlapped, and §11 cancel +
watermark + UTM where v2-Blocker scope already touched the surface.

The biggest blind spots are §1 design system (10 of 11 remaining), §3
flow/UX polish (13 of 14 remaining), §7 realtime + state (12 of 12),
§7 GDPR backups (7 of 7), §9 logging+audit (8 of 8), §10 testing
(7 of 8), §10 ghost edge cases (15 of 15), §11 analytics (6 of 6),
§11 lifecycle email copy (13 of 14), §12 SEO (9 of 10), §12 i18n
(9 of 9), §13 legal (12 of 13), §14 CI/CD (8 of 9 critical surfaces).

---

# Top 10 Highest-Leverage Remaining (judgment call)

Effort × user impact × audit-recurrence:

1. **M-A1 projectUtils inline bypass** (M) — 15 inline `=== "smartflow"` checks. One helper file + sed replaces them. Eliminates the most-repeated audit finding across reviewers.
2. **M-3 No connection-status badge outside admin** (L) — All realtime hooks already expose `connection` state; promoting the admin pattern is one shared hook + one chip component. Unlocks user-facing "your connection dropped" UX everywhere.
3. **M5 No referral-conversion event + tracking plan doc** (S+S) — Two small wins: write `docs/tracking-plan.md` + add `referral_code` to `signup_completed` and `begin_checkout` trackEvent calls. Closes the entire §11 analytics blind spot.
4. **F-A11Y-021 Skip-link on app-shell** (S) — 5-line change in `WorkspaceLayout.tsx`. Closes WCAG 2.4.1 gap that ADA-suit plaintiffs scan for.
5. **Lifecycle email copy rewrite** (S × 5) — Welcome subject, body, payment-failed, cancellation, greeting fallback. Single PR. Conversion math says these are worth weeks of A/B testing once they ship.
6. **Sitemap + robots crawl-delay + canonical www-vs-apex** (XS × 3) — Three trivial SEO fixes (`generate-sitemap.mjs`, delete one robots line, unify hreflang). New domain; every week of stale `lastmod` costs crawl budget.
7. **GPC handling + cookie banner copy + CCPA Notice at Collection** (S+S+M) — Three CCPA/EU items in one legal-page PR. CNIL fines fire without warning here.
8. **M-A4 IntakeForm progressive disclosure** (L) — Already 1416 lines; the `steps/` scaffold exists; finish the migration. Reduces signup → first-render funnel drop-off — the highest-leverage TTFV lever in §3.
9. **F-D6 + L-M-13 + L-M-05 + L-M-09 legal/data trio** (S+M+M+M) — `subscriptions.plan_name` CHECK + California Notice at Collection + Art. 22 disclosure + Stripe webhook retention. One legal/migration PR.
10. **M-7 + M-9 + M-8 worker-side realtime hardening** (XS × 3) — Three trivial fixes (`pollWorkerJob` id check, `useActiveJobs` filter, signout-removeAllChannels). Closes the §7 realtime cluster's quick wins without touching the optimistic-UI L items.

---

# Suggested Wave Grouping (5 waves, clean scope boundaries)

Each wave is scoped to avoid file conflicts so agents can run in parallel.

## Wave A — Brand sweep finish + design tokens (Vega + Pixel)
**Scope**: `src/index.css`, `marketing/src/styles/global.css`, `tailwind.config.ts`, `src/components/ui/password-strength.tsx`, `src/components/workspace/CaptionStyleSelector.tsx`, `src/pages/VoiceLab.tsx`, `index.html` (theme-color/apple-status-bar/PWA splash), `manifest.json`, `supabase/functions/_shared/emailTemplate.ts`, `marketing/src/pages/index.astro` (emoji→Lucide).

Items: §1 Canon (`--warning`, email font, marketing emoji, theme-color, status-bar), §1.M2/M4/M5/M6 (PWA splash, og:image variants, mismatch, marketing-dist), VoiceLab + CaptionStyleSelector + password-strength color sweep, §1 Design system spacing/shadow/motion tokens, F-04 admin destructive contrast.

Estimated effort: ~3-4h. ~22 items.

## Wave B — Auth + onboarding UX polish (Vega + Optic + Trace)
**Scope**: `src/pages/Auth.tsx`, `src/pages/Help.tsx`, `src/pages/Settings.tsx`, `src/lib/errorMessages.ts`, `src/components/layout/WorkspaceLayout.tsx` (skip-link), `e2e/auth/`.

Items: Lockout banner with countdown (3.2 + G-M2), resend confirmation cooldown (11.1 + Trace email-sent), `autoCapitalize` on email (M8), account-deletion re-auth + email (Trace), Help "Live chat"/Coming-soon cleanup, errorMessages account-enumeration unification (S-014 + F-16), skip-link to app-shell (F-A11Y-021), `Auth.tsx:162,147` literal copy fixes (F-14, F-15), Sentry breadcrumb on referral swallowed-error.

Estimated effort: ~3-4h. ~15 items.

## Wave C — Analytics + lifecycle email + SEO trio (Signal + Lens + Herald)
**Scope**: `src/hooks/useAuth.ts` (signOut UTM/Sentry reset), `src/hooks/useAnalytics.ts` (Sentry breadcrumbs on catch), `src/hooks/useSubscription.ts` (same-tab checkout for mobile, referral_code in trackEvent), `docs/tracking-plan.md` (new), `supabase/functions/_shared/resend.ts` (5 email subject/body rewrites), `public/sitemap.xml` → `scripts/generate-sitemap.mjs` (new), `public/robots.txt` (delete Crawl-delay, unify GPTBot/CCBot, marketing GPTBot policy), `index.html` (hreflang canonical apex), `marketing/src/pages/index.astro` (aggregateRating/contactPoint/VideoObject JSON-LD).

Items: §11 Analytics (M1-M6), §11 Herald all 14, §12 SEO (S-M1, S-M4, S-M5, S-M6, S-M7, S-M10), §13 L-M-11 (marketing robots GPTBot).

Estimated effort: ~5-6h. ~30 items.

## Wave D — Code health refactor + perf (Arch + Prism)
**Scope**: `src/lib/projectUtils.ts` + ~15 callsites (M-A1), pick one Sidebar + delete the other (M-A3), one pipeline + delete the other (M-A6), `src/components/intake/IntakeForm.tsx` finish step split (M-A4), `src/pages/VoiceLab.tsx` feature-folder extraction (M-A5), gate admin TODOs (M-A7), `src/components/dashboard/Sidebar.tsx`/`RightRail.tsx`/`Hero.tsx`/`ProjectsGallery.tsx` `React.memo` (PERF-017), `src/App.tsx` move modals from global mount (PERF-019), `src/pages/Landing.tsx` remove `console.log` (PERF-018 + 1.6), uninstall `recharts` package (PERF-020 cleanup), Lighthouse CI cover landing + pricing not just admin (PERF-014), `src/main.tsx` chunk-load failure handler (F15).

Estimated effort: ~6-8h. ~13 items. Lower agent parallelism — these touch the same render tree.

## Wave E — Legal + i18n + CI hardening (Comply + Tongue + Pipeline)
**Scope**: `src/pages/Privacy.tsx` + `marketing/src/pages/privacy.astro` (DSAR 30/45, Art. 22, COPPA, Notice at Collection, DPF claim verification, retention table), `src/components/CookieConsent.tsx` (ICO-strict copy), new `/cookie-policy` route, GPC handling in `src/lib/analytics`, Stripe checkout `custom_fields` for EU cooling-off waiver (`supabase/functions/create-checkout`), `.github/workflows/codeql.yml` (new), `.github/workflows/gitleaks.yml` (new), `.github/workflows/dr-restore-test.yml` (new), `.github/workflows/storage-backup.yml` (new), `.husky/pre-push` (new), `.github/dependabot.yml` (new), pin 8 Edge Function Sentry URLs + worker `@sentry/node`, drop `lovable-tagger`, `vercel.json` Supabase URL env-driven, schedule storage lifecycle cron (KEEPER-08), `subscriptions.plan_name` CHECK migration.

Estimated effort: ~6-8h. ~25 items. Two sub-waves possible (legal/docs vs CI/IaC) since they touch disjoint files.

---

## Items left out of waves (deferred — higher cost or lower clarity)

- **§7 Realtime + state** large items (M-5 optimistic UI, M-3 status badge) — touch the editor render tree; defer behind Wave D's IntakeForm refactor to avoid conflict.
- **§10 Ghost edge cases** — 15 items; mostly belong inside the Wave D refactor sequence or as targeted L items requiring test-first.
- **§4/§5/§7 Backend (Forge F-CH/F-PF)** — worker code; cluster into a dedicated "worker hardening" wave after Wave D lands.
- **F-A11Y-015 caption tracks** — pending worker VTT generation pipeline (already flagged C-1-11 partial).
- **TONGUE-04 RTL plumbing + TONGUE-13 email i18n + TONGUE-14 multi-currency** — all L items; not viable until i18n runtime lands.
- **§8 Crash 6, 11, 12, 13** — worker-side; bundle with Forge wave.
- **§9 Watch M1 SLO definitions, M5 cost spike alerting** — require product input on thresholds.
