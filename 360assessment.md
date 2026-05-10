# MotionMax — Unified 360° Production-Readiness Audit

**Target:** `C:\Users\Administrator\motionmax`
**Mode:** Deploy every available Studio Zero agent in parallel. Exhaustive assessment. Report with precise file paths, line numbers, severity, and actionable fixes (no full code rewrites — just solution + location + how to apply).
**Audit owner:** Studio Zero Audit panel (Jury orchestrates)
**Last updated:** 2026-05-09

---

## What MotionMax Is (one paragraph for context only — do not restate in the report)

MotionMax is an AI video generator SaaS. Users transform text, articles, or ideas into cinematic videos, explainer videos, visual stories, and smart-flow infographics — powered by Claude (research + script), Hypereal/Kling (image + video gen), Replicate/Fish/LemonFox/ElevenLabs/Google Gemini (TTS), and FFmpeg (final encoding + caption burn-in). Frontend is React 18 + Vite + Tailwind + shadcn. Backend is Supabase (Postgres + Auth + Storage + Realtime + Edge Functions). Heavy processing runs on a Render.com Node worker. Multi-language support across 11 locales.

---

## Audience (audience-relative scoring is mandatory)

**Primary persona:** Tool-savvy creative adults — content creators, marketers, video producers, agency staff. Mobile-heavy usage. Comfortable with creator software (CapCut / Descript / Canva tier) but **not developers**. Mixed English fluency (product advertises 11 languages). US-first launch implied by USD pricing.

**Secondary persona:** Small-team marketers and L&D / training content authors.

**Explicitly NOT the audience:** Developers, seniors with limited tech literacy, children, enterprise procurement.

If a finding does not tie to this audience, downgrade or drop it. The audience rubric (per `agents/audit/jury.md` Rule 3) is the deciding criterion when reviewers disagree.

---

## Brand (non-negotiable)

- **Aqua `#14C8CC` and gold `#E4C875` only.**
- **No red. No green. No orange — especially in autopost/lab UI.**
- Common template orange `#F5B049` ships in many starters; flag every occurrence.
- Documented brand-rule reference: `src/components/announcements/AdminAnnouncementBanner.tsx:25-28`.

---

## Removal in Progress (flag remnants)

The **Storytelling** product is being removed. Identify every remnant in:
- Code (components, hooks, utilities)
- UI labels and copy (config files, landing content, marketing site)
- Routes (`src/App.tsx` route table)
- Database schema (tables, enums, columns referencing storytelling)
- Translations (locale files)

---

## Surfaces to Cover (no skips)

| # | Surface | Primary files / dirs |
|---|---|---|
| 1 | **In-app landing** | `src/pages/Landing.tsx`, `src/components/landing/*`, `src/config/landingContent.ts` |
| 2 | **Marketing site (Astro)** | `marketing/src/pages/index.astro`, `marketing/src/styles/global.css`, `marketing/src/layouts/*` |
| 3 | **Auth surfaces** | `src/pages/Auth.tsx` (sign-in, sign-up, password reset, OAuth callback, age gate, lockout) |
| 4 | **Dashboard** | `src/components/dashboard/*` (Hero, Sidebar, AppShell), `src/pages/dashboard-new` |
| 5 | **Intake form** (the most-used screen) | `src/components/intake/IntakeForm.tsx`, `src/components/intake/primitives.tsx`, `src/components/intake/ScheduleBlock.tsx` |
| 6 | **Editor** | `src/pages/Editor.tsx`, `src/components/editor/*` (EditorFrame, EditorTopBar, MiniSidebar, ScenesColumn, Stage, Timeline, Inspector, BulkOpModal, ConfirmModal, ShareModal) |
| 7 | **Voice Lab** | `src/pages/VoiceLab.tsx`, `src/lib/voiceCatalog.ts` |
| 8 | **Autopost Lab** | `src/pages/lab/autopost/*`, `src/pages/lab/_LabLayout.tsx`, `src/pages/lab/LabHome.tsx` |
| 9 | **Projects gallery** | `src/pages/Projects.tsx`, `src/components/dashboard/ProjectsGallery.tsx` |
| 10 | **Settings** | `src/pages/Settings.tsx`, `src/components/settings/*` |
| 11 | **Pricing** | `src/pages/Pricing.tsx`, `src/components/landing/LandingPricing.tsx`, `src/config/products.ts` |
| 12 | **Admin** (flagged in prior context for broken API calls) | `src/pages/Admin.tsx`, `src/components/admin/*` (AdminApiCalls, AdminFlags, AdminGenerations, AdminLogs, AdminOverview, AdminPerformanceMetrics, AdminQueueMonitor, AdminRevenue, AdminSubscribers, AdminUserDetails, AdminWorkerHealth) |
| 13 | **Help & Support** | `src/pages/Help.tsx`, FAQ in `src/config/landingContent.ts`, in-product tooltips, all error messages, empty states, support contact path, refund/cancellation flow |
| 14 | **Email / notifications** | `supabase/functions/_shared/emailTemplate.ts` (transactional templates), in-product notification system, push readiness |
| 15 | **Render.com worker** | The Node worker that owns script generation, research phase, audio/image/video generation, image editing, video export. Job lifecycle, idempotency, partial-failure recovery |
| 16 | **Supabase backend** | Postgres schema, RLS policies, indexes, migrations, Edge Functions, Storage buckets, Auth config, Realtime channels |
| 17 | **AI provider integrations** | OpenRouter (Claude), Hypereal (Gemini Flash + Kling V2.5/V2.6 + Nano Banana Edit), Replicate (Qwen3, Chatterbox), Fish Audio, LemonFox, ElevenLabs (TTS + Voice Cloning), Google Gemini (Haitian Creole TTS) |
| 18 | **Public assets bundle** | `public/favicon.png`, `public/apple-touch-icon.png`, `public/og-image.png`, `public/momaxlogo.png`, `public/manifest.json`, `index.html` head |

---

## Mobile / Tablet / Cross-Platform Readiness

Test every primary flow at every breakpoint. No skips, no "we'll fix mobile later."

| Width | Device class | Flows that must work |
|---|---|---|
| 320px | Smallest modern phone (older Android) | Sign-up, intake, editor critical paths |
| 375px | iPhone SE / iPhone 13 mini | All |
| 390px | iPhone 14 / 15 standard | All |
| 414/428px | iPhone Plus / Pro Max | All |
| 768px | iPad portrait | Editor, dashboard, intake |
| 1024px | iPad landscape / small laptop | All |
| 1280px+ | Desktop | All |

### iOS Safari readiness
- `100vh` excludes the address bar — use `100dvh` or JS-detected viewport height
- Body bounce scroll — `overscroll-behavior: contain` on scrollable containers
- Inputs zoom on focus when font-size < 16px — every input needs `font-size: 16px` minimum
- Notched devices — `viewport-fit=cover` + `padding: env(safe-area-inset-*)` on top/bottom bars
- Touch targets ≥ 44×44px (Apple HIG) on every interactive element
- Date / time / file inputs use native pickers — verify the UX (placeholder/min/max may not apply)
- Add-to-home-screen — manifest, apple-touch-icon, splash, status-bar-style
- Sound autoplay restrictions — every video preview needs `muted+autoplay` or a user gesture
- Pull-to-refresh — disable where it would lose unsaved work (intake form, editor)

### Android Chrome readiness
- Edge-to-edge support — `padding: env(safe-area-inset-*)` works the same as iOS
- Status bar color via `<meta name="theme-color">` (per-route if needed)
- Hardware back button — does it close modals, navigate back, or exit unpredictably
- Touch targets ≥ 48dp (Material Design) on every interactive element
- Soft keyboard — viewport resize vs. overlay; input scroll-into-view; keyboard avoidance on editor and intake
- WebAPK install — service worker, manifest with proper icon set (192/512 maskable), `display: standalone`
- Long-running uploads / generations across screen-off / app-backgrounded states

### Tablet (iPad + Android tablet)
- Hybrid touch + mouse + Apple Pencil input — every gesture has a non-touch alternative
- Split-screen / Stage Manager / multitasking — does the editor adapt to half-width windows
- Orientation changes — landscape ↔ portrait without state loss
- External keyboard — Tab, Enter, Esc, arrow-key shortcuts on the editor

---

## Agent Assignments — every Studio Zero agent with a specific job

Each agent gets a focused scope. Findings under each agent should match its expertise. The Audit panel (Jury + 6 reviewers) covers cross-cutting domains; specialists go deep in their layer.

### Audit Layer — the panel (cross-cutting reviewers)

- **Jury** — Orchestrate the panel. Synthesize the verdict. Apply the severity rubric (Blocker / Critical / Major / Minor / Polish). Resolve cross-reviewer conflicts using the audience rubric. Verdict ∈ {PASS, PASS WITH FIXES, FAIL}. Write the verdict to `shared_context/audits/motionmax-360/<date>/verdict.md`.
- **Optic** — UX/UI heuristic audit. Nielsen 10, Hick's/Fitts's law, F/Z patterns, hierarchy, visual rhythm, primary-CTA prominence, empty/loading/error/success state coverage, navigation consistency, friction points across landing/auth/dashboard/intake/editor/admin.
- **Proof** — Content & wording. Reading level (Flesch-Kincaid for `src/config/landingContent.ts`, `src/pages/Pricing.tsx`, `src/pages/Help.tsx`, `src/pages/Terms.tsx`, `src/pages/Privacy.tsx`, in-product microcopy, error messages, empty states). Jargon, FTC §255 substantiation, EU UCPD compliance for marketing claims. Tone consistency app↔marketing. Cross-surface contradictions.
- **Halo** — WCAG 2.2 AA on every primary flow. NVDA + VoiceOver + TalkBack passes. Contrast measurement on every text/background pair. Keyboard-only walkthrough of signup → intake → editor. Reduced motion. Forced colors. Focus management on route changes. Form labels + error association.
- **Compass** — Audience alignment. Does every surface speak to the defined creator/marketer audience? Flag developer jargon leakage (RLS, 429, Retry-After, webhooks) in user-facing surfaces. Persona-fit per primary surface. Pricing-comprehension match. Trust signals authentic vs. fabricated.
- **Trace** — As-built journey. Walk every primary flow end-to-end on the live build (or in code if no live URL). Map dead ends, trap states, missing confirmations, broken redirects, dropped paid-intent on Pricing→Auth→Stripe round-trip. Step counts vs. industry baselines (signup ≤ 4, checkout ≤ 3).
- **Canon** — Visual consistency. Brand-token conformance across every shipped CSS file. Hard-coded hex values vs. `var(--brand-aqua)` / `var(--brand-gold)`. Asset-bundle integrity (favicon / apple-touch-icon / OG card / logo are distinct, correctly-sized files; manifest declares matching dimensions). Per-surface drift between app, lab, admin, marketing, email.

### Strategy Layer

- **Axiom (Chief Product Officer)** — PRD audit: are MVP features actually shipping vs. landing claims? Visual Stories mode advertised but missing in the code (`src/components/dashboard/Hero.tsx:12` only has cinematic / doc2video / smartflow). Storytelling-removal scope — has the PRD been updated? Cross-reference Axiom's intent against Trace's as-built map.
- **Scout (Market Intelligence)** — Competitive positioning audit. How does MotionMax's landing + pricing compare to Descript, CapCut Pro, Synthesia, Pictory, Runway? Identify tier-mismatch risks (under-pricing premium features, over-pricing commodity ones).
- **Penny (Business Model)** — Pricing strategy review. Free / Creator / Studio tier definitions. Credit-economics ($1 credit per second, 5× for cinematic). Yearly vs. monthly disclosure clarity. Refund policy (EU 14-day cooling-off compliance). Cross-check with Comply on auto-renewal disclosures (California ARL, EU).
- **Sprint (Project Manager)** — Roadmap state. TODO / FIXME / HACK inventory across the codebase. Open issues blocking ship. Sequence remediation work into a launch plan.

### Design Layer

- **Canvas (UI/UX Designer)** — Design system completeness audit. Spacing scale, type scale, color tokens, radius scale, motion scale, shadow/elevation tokens. Component pattern reuse vs. one-off implementations. System-feedback consistency (Sonner toasts vs. ad-hoc inline messages). Mobile-first vs. desktop-first inconsistency.
- **Pixel (Brand Identity)** — Brand asset bundle review. Verify each asset is the correct size + format + content (NOT a single PNG repeated). OG/Twitter/LinkedIn/Slack share previews actually render correctly. PWA manifest icons (192/512 maskable). Brand-color drift across CSS files. Email template (`supabase/functions/_shared/emailTemplate.ts`) brand consistency.
- **Flow (UX Researcher)** — Design-time persona audit. Are the documented personas (creator / marketer / agency) reflected in the actual flows? Onboarding journey map — what's the time-to-first-value? Cognitive load on the unified intake form (currently ~10 controls; is that defensible for the audience?).
- **Motion (Animation Design)** — Framer Motion usage audit. `prefers-reduced-motion` compliance (currently zero matches per the v1 audit — every Button bounces). Animation duration consistency across scoped shells. Vestibular-disorder / migraine-trigger risk on landing/auth full-page transitions.

### Frontend Layer

- **Arch (Frontend Architect)** — Architecture review. Folder structure, separation of concerns, state-management consistency (TanStack Query vs. Zustand vs. ad-hoc useState). React 18 vs. React 19 readiness. Naming conventions. Business logic that should be centralized but isn't. The `/dashboard-new` legacy route — can it be removed?
- **Vega (UI Component Engineer)** — Component-level audit. Duplicated components (`+Add source` vs. `File` button on intake — same action, two visuals). `window.prompt()` usage (admin RichEditor, intake URL attach, VoiceLab rename — all need themed dialogs). Form-state persistence across navigations. Mobile-vs-desktop component variants.
- **Touch (Mobile & PWA)** — Mobile responsiveness audit at every breakpoint above. iOS Safari quirks. Android Chrome quirks. Tablet orientation + split-screen behavior. PWA install readiness (manifest, service worker, icons). Touch-target compliance (44px iOS / 48dp Android) on every interactive element. Cross-reference Halo for keyboard-equivalent paths.
- **Prism (Performance Engineer)** — Web Vitals audit. LCP / CLS / INP measurement (or estimate from code) on landing, dashboard, editor. Bundle-size analysis (`vite build --mode production` and inspect chunks). Oversized deps. Code-splitting opportunities. Re-render hotspots. Image format usage (WebP/AVIF vs. PNG). Lazy-loading coverage on below-fold images. Font-loading strategy (17 display fonts blocking on every page request, per Canon's v1 finding).
- **Access (Accessibility Implementer)** — Implementation partner to Halo. Audit fixes needed for any Halo finding. ARIA pattern correctness. Semantic HTML. Form labels. Live regions. Modal focus traps. Skip links. Cross-reference XAUR if any XR/spatial features exist.

### Backend Layer

- **Forge (Backend Architect)** — Server-side architecture audit. The Render.com Node worker design. Job lifecycle (queued → running → succeeded / failed / retrying). Idempotency on regeneration. Partial-failure recovery (mid-render crash). Retry-with-backoff per AI provider. Dead-letter handling. AI provider integration patterns (rate-limit handling, fallback model routing, cost-aware routing). FFmpeg pipeline error handling and partial output cleanup. Supabase Edge Functions wiring.
- **Nexus (API Engineer)** — REST/RPC endpoint audit. Endpoint shape consistency. Error response format (`{ error: string, code?: string, details?: any }`). Pagination strategy. Versioning. Webhook handler for Stripe (signature verification + idempotency on event.id). Auth-required vs. public endpoint mapping.
- **Vault (Auth & Authorization)** — Auth audit. Session lifecycle, token expiry, refresh-token rotation, password policy, OAuth scopes. Account-enumeration prevention (login error messages identical for "wrong password" and "no such user"). Lockout policy persistence (currently `useRef` in-memory — survives page refresh? per v1 audit: no). MFA readiness for admin accounts.
- **Bridge (3rd-Party Integrations)** — Integration audit. Each AI provider: secret handling, rate-limit signal handling, fallback behavior, cost-tracking hooks. Stripe integration: webhook signature, customer portal, subscription state sync. Resend integration: bounce / complaint handling.
- **Queue (Async Jobs)** — Job-queue audit. What's queued vs. synchronous. Concurrency limits per worker. Retry-on-failure policy. Visibility into queue depth (does Watch's dashboard show it?). Stuck-job recovery (zombie generation states per v1 finding Mj-31).

### Data Layer

- **Atlas (Database Architect)** — Postgres schema audit. Every table has `id` (PK) + `created_at` + `updated_at`. Every FK has an index. Every user-data table has RLS enabled. Schema constraints (NOT NULL, CHECK, unique). Migration safety (forward-only, multi-step destructive changes). N+1 queries (run `EXPLAIN ANALYZE` on suspect endpoints). `SELECT *` audit. Soft-delete consistency.
- **Stream (Realtime Systems)** — Realtime audit. Supabase Realtime subscriptions. Reconnection logic. Optimistic update rollback. Mid-generation state sync (does the editor live-update as the worker progresses, or require refresh?). Multi-tab sync.
- **Keeper (Backups & Recovery)** — Backup audit. Point-in-time recovery configured? Cross-region replication? Last verified-restorable date. Retention policy per data type. GDPR data-export endpoint (Article 20 — exists?). GDPR deletion flow (Article 17 — cascade complete? notifies Stripe + Resend + PostHog?).
- **Query (Search & Retrieval)** — Search audit. Voice search in Voice Lab. Project search in gallery. Full-text indexes (if any). pg_trgm for fuzzy match. Search result relevance.

### Security Layer

- **Shield (App Security)** — OWASP Top 10 audit. A01 broken access control (every protected route has a server-side check). A02 crypto failures. A03 injection (parameterized queries, output encoding, no `dangerouslySetInnerHTML` with user input). A05 misconfiguration (security headers — CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy; CORS allowlist). A07 auth failures (rate limit on auth endpoints, password reset, expensive APIs).
- **Cipher (Cryptography & Privacy)** — Secrets + encryption audit. No hardcoded keys (run gitleaks / trufflehog patterns mentally). No client-exposed env. Data at rest encryption (user content, generated videos, payment metadata). Data in transit (HTTPS-only, secure cookies, HSTS). PII redaction in logs (every Sentry breadcrumb, every Chronicle log line).
- **Verify (Supply Chain)** — Dependency audit. `npm audit --audit-level=high`. `osv-scanner`. SBOM completeness. License compliance (GPL/AGPL/SSPL in proprietary code = Blocker). Single-maintainer abandoned deps. Typosquat risks. Renovate / Dependabot config. CI action SHA pinning.

### Quality Layer

- **Probe (QA Engineer)** — Test strategy audit. Coverage map: current % unit / integration / E2E. Critical-flow coverage gaps (auth, payment, generation pipeline, deletion, refund flows MUST be covered). Proposed test plan in priority order. CI test gating policy.
- **Crash (Load & Stress)** — Capacity audit. Worker throughput at expected scale. AI provider rate-limit budgets (OpenRouter, Hypereal, Replicate, ElevenLabs). DB connection pool under load. FFmpeg encoding bottleneck. k6 / Artillery load test scaffold.
- **Ghost (Exploratory Bug Hunter)** — Edge-case audit. Race conditions: regenerate-while-export, double-submit on intake, mid-flow logout, browser-back during multi-step wizards, two-tabs-editing-same-project. Network-drop mid-generation. Storage-full mid-render. AI provider returning 4xx/5xx mid-job.

### DevOps Layer

- **Pipeline (CI/CD)** — Pipeline audit. Tests + lints + audits on every PR. Preview deploys on PR. Deploy rollback protocol. Zero-downtime strategy. Env-var management. Audit gate integration (does CI block deploy on FAIL verdict?).
- **Terra (Infrastructure)** — Infra audit. Dev / staging / prod separation (separate Supabase projects + worker instances?). Worker autoscaling triggers. Storage growth trajectory + archival policy. Regional deployment. IaC completeness (any Vercel/Render config in version control?).
- **Watch (Observability)** — Monitoring audit. Sentry on frontend AND worker AND edge functions. Uptime monitoring per primary path. Alert thresholds. Who gets paged at 3am? Status page existence.
- **Chronicle (Logging & Audit)** — Logging audit. Structured JSON logs. No sensitive-data leakage (per Cipher's redaction patterns). Per-request trace IDs. Audit log for every admin action and billing event. Log retention.
- **Siren (Incident Response)** — Incident-readiness audit. Runbooks per top alert. On-call rotation. Postmortem template. Status-page protocol. Dependency-outage response (Stripe down, OpenRouter down, Supabase down). **Honest answer: if prod breaks right now, would anyone know within 5 minutes?**
- **Meter (FinOps)** — Cost audit. $/active-user. $/generated-video (decompose: script tokens + research tokens + image-gen calls + video-gen calls + TTS calls + FFmpeg compute). $/audit-call to AI providers. Flag every expensive / redundant process; suggest leaner alternative. Identify cost-per-feature; flag features that are unprofitable at current pricing.

### Platform Layer

- **Locale (Internationalization)** — i18n audit. String extraction completeness — any hardcoded English in user-facing UI? Pluralization (ICU / CLDR). Locale-specific date/currency/number formatting. Hardcoded `en-US` formatters across pricing surfaces.
- **Edge (CDN & Caching)** — Edge audit. Cache headers on every asset. CDN config. Image-CDN usage (Supabase Storage CDN? Cloudflare Images? imgix?). Edge-function placement (region selection). Stale-while-revalidate strategy.
- **Tongue (Localization Quality)** — Per-locale quality audit. Native-speaker pass on each of the 11 supported languages. UI fit at expanded text widths (German +30%, Russian +25%). RTL readiness if any RTL language is in scope. Per-region legal-string completeness (GDPR cookie banner, CCPA, ToS) per locale.

### AI Layer

- **Cortex (LLM Integration)** — LLM-feature audit. Prompt design (system prompts, few-shot examples, chain structure). Token-budget hygiene. Model selection rationale per feature (Claude Sonnet 4.6 for research + script — defensible? cheaper alternative?). OpenRouter routing (fallback model behavior, cost-aware routing).
- **Memory (Vector / RAG)** — Memory audit. Any embedding-based features? Voice fingerprints for cloning? If so: vector store choice, embedding model, retrieval freshness, cost per retrieval.
- **Oracle (AI Eval & Red Team)** — AI safety + eval audit. Hallucination risk in script generation (does the AI claim verified facts?). Prompt-injection surface (any user-controlled text reaches an LLM via system or tool input?). Eval suite for AI features (does one exist? what would it look like?). Synthetic-media disclosure compliance (EU AI Act).

### Docs Layer

- **Scribe (Tech Docs)** — Tech-docs audit. README completeness. Local setup instructions. Architecture overview. API contract docs. CONTRIBUTING. Are the markdown docs at the project root (DEPLOYMENT_SECURITY.md, DISASTER_RECOVERY.md, NATIVE_MOBILE_PLAN.md, PRICING_PROPOSAL.md, etc.) up to date with the actual code?
- **Guide (User Docs)** — Help-content audit. `src/pages/Help.tsx` quality. In-product tooltip coverage. Empty-state copy quality (do they tell the user what to do, not just "no data"). Error-message specificity. FAQ accuracy vs. actual product behavior. Changelog visibility.

### Growth Layer

- **Signal (SEO)** — SEO audit. sitemap.xml. robots.txt. Canonical tags. Structured data (schema.org Product / Video / Organization / FAQPage). hreflang for the 11 supported languages. Meta titles / descriptions / OG / Twitter cards on every public page. Indexability of public pages, noindex on private routes (auth, dashboard, editor, admin). Programmatic SEO opportunities given the content-gen nature of the product.
- **Lens (Product Analytics)** — Analytics audit. Event instrumentation consistency (single naming convention `verb_noun_snake`, single source). Funnel definition end-to-end. Conversion event firing. UTM/referral tracking. Identify on signin, reset on signout. Drop-off measurement per onboarding step.
- **Herald (Marketing Copy)** — Copy audit. Landing copy quality + claim substantiation. Lifecycle email (onboarding drip, re-engagement, win-back) — exists? Transactional email voice consistency. "Made with MotionMax" watermark for free-tier outputs (referral loop).
- **Hook (Conversion Optimization)** — CRO audit. Funnel friction at each stage. Pricing-page A/B opportunities. Checkout reassurance. Form-field reduction opportunities. Currently zero A/B testing infra — propose what to instrument first.

### Operations Layer

- **Echo (Customer Support)** — Support audit. Inbound channel (email? chat? Intercom?). Support macro library. Common-issue inventory. Refund-request flow. Escalation path from support → engineer.
- **Ledger (Finance & Billing)** — Billing audit. Stripe webhook handler completeness (every event type that matters). Subscription state sync (Stripe → app DB). Idempotency on event.id. Failed-payment dunning flow. Refund flow. Tax handling (Stripe Tax enabled? per-region VAT?).
- **Comply (Legal)** — Compliance audit. Terms of Service, Privacy Policy, Cookie Policy — present and aligned with actual data practices. GDPR consent banner, data-export endpoint, data-deletion flow, DPA listing for processors. CCPA equivalents. AI-specific: training-data provenance, user-content usage rights, synthetic-media labeling per EU AI Act + FTC AI guidance. Copyright handling for user-uploaded scripts/assets and AI-generated outputs.

---

## Cross-Cutting Categories — all 14 sections, mapped to owners

For convenience and traceability against the original 360 framework, every finding belongs to exactly one of these categories:

| # | Category | Primary owners |
|---|---|---|
| 1 | UI/UX & Design System | Optic, Canon, Pixel, Canvas, Motion |
| 2 | Visitor → Customer Conversion | Hook, Lens, Herald, Compass |
| 3 | Process & Flow Consistency | Trace, Flow |
| 4 | Code Health & Redundancy | Arch, Vega, Forge, Sprint |
| 5 | Performance | Prism, Atlas, Forge, Edge |
| 6 | Security & Encryption | Shield, Cipher, Verify, Vault |
| 7 | Data Integrity & State | Atlas, Keeper, Stream |
| 8 | Infrastructure & Scaling | Terra, Crash, Meter, Edge, Queue |
| 9 | Observability & Incident Readiness | Watch, Chronicle, Siren |
| 10 | Testing | Probe, Crash, Ghost |
| 11 | Analytics, Marketing, Growth | Lens, Hook, Herald, Pixel |
| 12 | SEO | Signal, Prism, Tongue |
| 13 | Legal & Compliance | Comply, Cipher, Tongue |
| 14 | Production Readiness | Pipeline, Terra, Siren, Verify |

---

## Deliverable Format

For **each finding**:

1. **Category** — one of the 14 above
2. **Severity** — `Blocker` (ships nothing until fixed) / `Critical` (fix before launch) / `Major` (next release) / `Minor` (when convenient) / `Polish` (optional)
3. **Issue** — one factual sentence, no speculation
4. **Location** — exact `file:line` (or `file:line-range` when multi-line)
5. **Evidence** — screenshot path, contrast measurement, query plan, log snippet, dependency CVE id, or audit-tool output. **Findings without evidence will be rejected by Jury.**
6. **Fix** — what to do, where, how. No full code rewrites — point to the solution.
7. **Owner** — which agent / layer is on the hook
8. **Effort** — XS (< 30 min) / S (~1 h) / M (~ half day) / L (~ 1+ days)

Group findings by category. Within each category, sort by severity (Blocker → Polish).

End with three tables:

1. **Production Blockers** — every Blocker, sorted by remediation deadline
2. **Top 10 Priority Fixes** — ranked by impact × urgency, regardless of severity
3. **Mobile / iOS / Android findings** — every mobile-specific finding pulled out for fast triage (since the audience is mobile-heavy)

---

## Rules

- **Only report what is verifiable in the codebase.** If unsure, write "Unable to verify from static analysis." No fabrication.
- **No filler.** No restating what MotionMax is. No "in conclusion." No "this is great."
- **Precision per finding, exhaustive across categories.** Better to flag 3 specific issues than to write 1 vague paragraph.
- **Measure against the app's own onboarding / explainer section as the reference standard** for design quality.
- **Audience-relative scoring is mandatory.** A finding that fails for the defined creator/marketer audience is severe; the same finding for a hypothetical developer audience may not be. Score against the actual persona, not "good UX in general."
- **Every Blocker / Critical finding routes to its layer lead** (per `protocols/communication.md` chain of command — never bypass).
- **No long dashes** in the writing. Use `—` only in section dividers, not mid-sentence.
- **No code rewrites in the report.** Point to the fix; let the layer-lead's specialists do the rewrite.

---

## Execution

Run from the studio-zero root:

```bash
cd /c/Users/Administrator/studio-zero
node audit-run.js motionmax-360 \
  "$(cat /c/Users/Administrator/motionmax/360assessment.md)" \
  --project-dir /c/Users/Administrator/motionmax \
  --mirror-to /c/Users/Administrator/motionmax/.audits \
  --full-360 \
  --max-parallel 10
```

Or pass the brief inline as in the prior run. `--full-360` engages the 28 specialists alongside the 6 audit reviewers (35 spawns + Jury = 36 total).

### Output paths

| Path | Contents |
|---|---|
| `studio-zero/shared_context/audits/motionmax-360/<date>/brief.md` | This audit brief, written verbatim |
| `studio-zero/shared_context/audits/motionmax-360/<date>/{optic,proof,halo,compass,trace,canon}.md` | 6 core reviewer findings |
| `studio-zero/shared_context/audits/motionmax-360/<date>/specialists/<agent>.md` | 28 specialist findings, one per agent |
| `studio-zero/shared_context/audits/motionmax-360/<date>/verdict.md` | Jury synthesis |
| `studio-zero/shared_context/projects/motionmax-360/metrics.json` | $/audit + token + duration metrics |
| `motionmax/.audits/<date>/` | Mirrored copy of the entire audit dir for in-project reference |

### Expected duration + cost

- **Wall clock:** 30–50 min at `--max-parallel 10`
- **Cost:** $20–60 USD (first full-360 run; subsequent runs benefit from prompt-cache hits and may be 30–50% cheaper)
- **Spawns:** 35 agents + 1 Jury synthesis = 36 total

### Re-audit cadence

- After every Blocker / Critical remediation cycle, re-run `audit-run.js motionmax-360 ...` to verify fixes landed
- Per `protocols/code-standards.md` Audit Gate, no production deploy without a `PASS` or `PASS WITH FIXES` verdict on file
- Per `protocols/self-improvement.md`, every audit run produces a case study under `studio-zero/shared_context/projects/_case-studies/motionmax-360-<date>.md`

---

## Severity Rubric (fixed — `agents/audit/jury.md`)

- **Blocker** — ships nothing until fixed (legal, security, broken core flow, false advertising, broken billing)
- **Critical** — fix before launch (significant audience exclusion, data loss risk, brand damage, FTC/UCPD exposure, WCAG AA failure on primary flow)
- **Major** — fix before next release (clear friction, comprehension failure, recoverable dead-end, off-token visual drift)
- **Minor** — fix when convenient (polish, edge cases, micro-copy nits)
- **Polish** — optional improvement (taste, parity with best-in-class)

---

## Source-of-Truth Notes

- This document is the canonical brief for any future audit of MotionMax. Reading it should be sufficient to run the audit without external context.
- If the studio-zero agent roster, severity rubric, or build flow changes, update this document so future runs reflect current studio state.
- Last full audit run: see most recent dated directory under `studio-zero/shared_context/audits/motionmax-360/` (or `motionmax/.audits/` for the mirrored copy).
