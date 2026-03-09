# MotionMax — Full Web Application Code Audit

**Audit Date:** March 9, 2026
**Auditor:** Automated Code Review (Claude Opus 4.6)
**Scope:** Entire codebase — frontend, backend (Supabase Edge Functions), worker service, database migrations, static assets, configuration

---

## Executive Summary

**MotionMax** is an AI-powered content creation platform that transforms text into narrated videos with AI-generated visuals, voiceovers, and multiple visual styles. It targets creators, educators, and businesses.

**Tech Stack:**
- **Frontend:** React 18 + TypeScript, Vite, Tailwind CSS, shadcn/ui (Radix), Framer Motion, React Router v6, TanStack React Query
- **Backend:** Supabase (PostgreSQL, Auth, Edge Functions, Storage, Realtime)
- **Payments:** Stripe (subscriptions + one-time credit packs)
- **AI Services:** OpenRouter (LLM scripting), Replicate (image/video/TTS), ElevenLabs (voice cloning), Grok (cinematic video), Hypereal (video generation)
- **Worker:** Node.js service on Render with FFmpeg for video export
- **PWA:** Vite PWA plugin with Workbox

**Reference Standard (App's Own Documentation):** The Landing page, Terms of Service, Privacy Policy, Acceptable Use Policy, and the in-app pricing/features sections define what the app is supposed to do. All findings are measured against these.

**Key Product Modes:**
1. **Explainers (Doc-to-Video)** — Transform text/documents into narrated explainer videos
2. **Visual Stories (Storytelling)** — Turn story ideas into narrative videos with genre/tone/inspiration
3. **Smart Flow (Infographics)** — Generate infographic visuals from data/CSV/tables
4. **Cinematic (Beta)** — High-quality cinematic video generation (Pro plan only)
5. **Voice Lab** — Clone voices for personalized narration

**Subscription Tiers:** Free, Starter ($14.99/mo), Creator ($39.99/mo), Professional ($89.99/mo), Enterprise (contact sales)

---

## Findings by Severity Summary

| Severity | Count |
|----------|-------|
| Critical | 8 |
| High | 17 |
| Medium | 26 |
| Low | 19 |

---

## Page-by-Page Audit

---

### 1. Landing Page (`/`) — `src/pages/Landing.tsx`

#### What Is Working Correctly
- Clean, responsive marketing page with hero section, features, pricing, about, and footer
- Smooth scroll-reveal animations using Framer Motion `whileInView`
- Mobile hamburger menu with AnimatePresence transitions
- Hero video autoplays muted with poster fallback
- Pricing section dynamically pulls credit counts from `PLAN_LIMITS`
- Dark/light theme toggle present in the navigation
- Proper Open Graph and Twitter Card meta tags in `index.html`
- Structured data (JSON-LD) for SoftwareApplication and Organization

#### What Needs to Be Changed

1. **[Critical] Stripe Product ID Mismatch Between Frontend and Webhook**
   The frontend `useSubscription.ts` references product IDs `prod_Tnyz2nMLqpHz3R`, `prod_Tnz0KUQX2J5VBH`, `prod_Tnz0BeRmJDdh0V` for subscriptions, and `prod_Ts3r9EBXzzKKfU`, `prod_Tnz0B2aJPD895y`, `prod_Tnz1CygtJnMhUz`, `prod_Ts3rl1zDT9oLVt` for credit packs. However, the `stripe-webhook/index.ts` references completely different product IDs: `prod_TqznNZmUhevHh4` (starter), `prod_TqznlgT1Jl6Re7` (creator), `prod_TqznqQYYG4UUY8` (professional) for subscriptions, and `prod_TqznJ5NkfAEdUY`, `prod_TqznSfnDazIjj2`, `prod_Tqznn5NHeJnhS6`, `prod_Tqznoknz2TmraQ` for credit packs. The `check-subscription/index.ts` references yet another set matching the frontend. This means webhook events from Stripe are being processed against a different set of product IDs than what the frontend creates checkouts for. If these are not all valid aliases for the same products in Stripe, subscription provisioning and credit allocation after payment will silently fail.

2. **[High] Pricing Data Inconsistency**
   Landing page hardcodes monthly prices: Free $0, Starter $14.99, Creator $39.99, Professional $89.99. The Pricing page (`src/pages/Pricing.tsx`) also has its own hardcoded price display. Credit pack prices in `useSubscription.ts` are: 15 credits/$11.99, 50/$14.99, 150/$39.99, 500/$249.99. Meanwhile the webhook file comments show different prices: 50 credits/$34.99, 150/$89.99. These prices should come from a single source of truth, not be scattered across three files.

3. **[Medium] Landing Page Shows Only Monthly Pricing**
   The Pricing page inside the app has a monthly/yearly toggle with "Save 20%" badge, but the Landing page pricing section only shows monthly prices with no yearly option. This inconsistency may confuse users who see one price on the landing page and different options after signing up.

4. **[Medium] Features Section Uses Dark Background Image for Both Themes**
   The features section uses `features-bg-dark.png` as background regardless of light/dark mode. In light mode this creates a jarring visual contrast with the rest of the page. Text is forced to white (`text-white`) which works on the dark background but doesn't respect the user's theme preference.

5. **[Low] Footer Missing Navigation Links**
   The footer only contains the logo and copyright. It has no links to Terms of Service, Privacy Policy, or Acceptable Use Policy. These legal pages are linked from the Auth page and legal pages themselves, but the landing page footer — which is where users typically look for these — has none.

6. **[Low] "sameAs" Array Empty in Organization Schema**
   The JSON-LD Organization schema has `"sameAs": []` — this should either link to the app's social media profiles or be removed entirely to avoid appearing incomplete to search engines.

7. **[Low] No Video Fallback**
   The hero video element shows "Your browser does not support the video tag" text but no visual fallback image. If the .mp4 fails to load, users see nothing. The poster image only shows before playback starts, not on error.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added

1. **[Medium] Sitemap Reference**
   `robots.txt` allows all crawlers but has no `Sitemap:` directive. A sitemap.xml should be generated and referenced for proper SEO indexing.

2. **[Low] Crawl-delay in robots.txt**
   No crawl-delay is specified, which means aggressive crawlers have no rate guidance.

---

### 2. Auth Page (`/auth`) — `src/pages/Auth.tsx`

#### What Is Working Correctly
- Four authentication modes: Login, Sign Up, Password Reset, Password Update
- Password visibility toggle
- Supabase auth integration with `signIn`, `signUp`, `resetPassword`, `updatePassword`
- Listens for `PASSWORD_RECOVERY` auth state change event
- Fallback hash-based recovery detection (handles edge cases)
- Links to Terms and Privacy from the signup form
- Post-auth redirect using `returnUrl` query parameter
- Success toast messages for password reset and signup confirmation

#### What Needs to Be Changed

1. **[Critical] ProtectedRoute Does Not Pass Return URL**
   `ProtectedRoute.tsx` redirects unauthenticated users to `/auth?returnUrl=` with an empty value. The current location path is never captured or appended, so after login the user is always redirected to `/app` (the fallback). This breaks deep-link preservation — a user accessing `/projects` while logged out gets redirected to `/auth` and after login ends up at `/app` instead of `/projects`.

2. **[High] Password Minimum Length Inconsistency**
   The Auth page's password update mode requires 6+ characters (`password.length < 6`). The Settings page requires 8+ characters for password changes. Supabase's default minimum is 6. This inconsistency means a user could set a password via the reset flow that they then can't change via Settings because it's under 8 characters. One standard should be used across both locations.

3. **[High] No Client-Side Rate Limiting on Login Attempts**
   There is no throttling or lockout after repeated failed login attempts. While Supabase has server-side rate limiting, the client provides no feedback about rate limits being hit — a failed login due to rate limiting would show a generic error message.

4. **[Medium] Hash-Based Recovery Detection is Fragile**
   The auth page checks `window.location.hash` for `type=recovery` or `access_token` to detect password recovery flows. This is fragile because: (a) the hash format depends on Supabase's implementation which could change, (b) the hash is checked even after the `PASSWORD_RECOVERY` event fires, creating redundant logic, (c) clearing the hash with `history.replaceState` is called in a setTimeout which could race with other effects.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added

1. **[Medium] Email Confirmation Feedback**
   After signup, a success toast is shown but there's no persistent UI indicator that the user needs to check their email. If the user refreshes the page, the context is lost.

---

### 3. Dashboard (`/app`) — `src/pages/Index.tsx` + `src/pages/Dashboard.tsx`

#### What Is Working Correctly
- Welcome greeting with user's display name from profile
- Credits balance display with React Query caching (30s stale time)
- Recent projects carousel with Embla Carousel
- Project type icons (Video, Clapperboard, Wallpaper, Film) for different modes
- Quick tips rotation every 8 seconds
- "No projects yet" empty state with CTA
- Dark/light themed background images
- Skeleton loaders during data fetch

#### What Needs to Be Changed

1. **[High] No Error States for Failed Queries**
   The Dashboard fetches user credits, profile, and projects but has no error handling UI. If any query fails (network error, auth expiry), the component silently shows loading skeletons or zero values. Users won't know something is wrong.

2. **[Medium] Index.tsx Is a Redundant Wrapper**
   `Index.tsx` only wraps Dashboard with SidebarProvider and AppSidebar. This pattern is repeated identically for Projects, Settings, VoiceLab, and Usage pages, each with its own SidebarProvider/AppSidebar wrapper. This should be a shared layout route to avoid code duplication.

3. **[Medium] "smart-flow" vs "smartflow" Project Type Inconsistency**
   The Dashboard handles both `"smartflow"` and `"smart-flow"` project types in its normalization logic (line 141-142). The same dual-check exists in AppSidebar, Projects, and Usage pages. The database likely stores both values due to a naming change that was never migrated. This creates unnecessary complexity in every component that reads project types.

4. **[Low] Tips Array Has Arbitrary Timing**
   The 6 tips rotate every 8 seconds via `setInterval`. The animation uses `AnimatePresence` with `mode="wait"` which is correct, but the 8-second interval doesn't account for the animation duration, meaning the tip may appear to "pop" rather than smoothly transition on slow devices.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added

1. **[Low] Quick Action Buttons**
   The dashboard has a single "Start Creating" button. Given the app has 4 distinct workspace modes, the dashboard should offer quick-access buttons for each mode (Explainers, Visual Stories, Smart Flow, Cinematic) rather than requiring users to navigate through the sidebar.

---

### 4. Workspace / Create Page (`/app/create`) — `src/pages/CreateWorkspace.tsx` + Workspace Components

#### What Is Working Correctly
- WorkspaceRouter correctly routes between 4 workspace modes based on URL `?mode=` parameter
- Project loading via `?project=` parameter with auto-recovery for in-progress generations
- 3-step wizard flow (Content → Art Direction → Voice) for Doc2Video and Storytelling
- Style selector carousel with 13 visual styles and preview images
- Custom style with text description and reference image upload
- Brand mark toggle for Creator+ plans
- Character consistency toggle gated to Professional plan
- Voice selector with standard voices and user's cloned voices
- Format selector (landscape, portrait, square) with plan-based restrictions
- Length selector with plan-based restrictions
- Generation progress display with phase-specific status messages
- Result display with scene-by-scene editing, audio/image regeneration
- Video export, image ZIP download, share link generation, project deletion
- Credit estimation display before generation
- Subscription validation before generation starts

#### What Needs to Be Changed

1. **[Critical] Character Consistency Flag Not Sent to Backend (Doc2Video)**
   In `Doc2VideoWorkspace.tsx`, the `characterConsistencyEnabled` state is captured via the toggle but is never included in the generation request body passed to `useGenerationPipeline`. The backend (`generate-video/index.ts`) accepts and processes `characterConsistencyEnabled`, but the frontend never sends it. This means the paid Pro feature advertised to users does not actually activate for Doc2Video projects. The Cinematic and Storytelling workspaces do appear to include it.

2. **[Critical] CreditEstimate Component Likely Crashes**
   `CreditEstimate.tsx` calls `getCreditsRequired(projectType, length)` which is a pure function from `planLimits.ts`, but the component imports it via `useSubscription` hook re-export. Reviewing the actual implementation, `getCreditsRequired` is indeed a plain function (not a hook), so it should work. However, the component does not handle the case where `length` is undefined or empty string — `getCreditsRequired` will throw an error with "Invalid video length" for SmartFlow projects that don't use the `length` parameter in the same way. The component needs to guard against this.

3. **[High] ContentInput Has 60+ Lines of Dead Code**
   `ContentInput.tsx` has a large commented-out section (~60 lines) for file upload tabs and functionality. This dead code clutters the file and suggests an incomplete feature that was abandoned mid-implementation.

4. **[High] Custom Style Image Upload Silently Fails**
   In `StyleSelector.tsx` and `SmartFlowStyleSelector.tsx`, the file size validation for custom style reference images (5MB limit) silently returns without user feedback when the file is too large. The `uploadStyleReference` function's error is only logged to console. Users will think their upload worked but no image will be sent.

5. **[High] Share URL Construction Is Fragile**
   `ResultActionBar.tsx` and `CinematicResult.tsx` construct share URLs using: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/share-meta/${token}` for metadata bots and hardcoded `https://motionmax.io/share/${token}` for display. The display URL is hardcoded to the production domain, which means it won't work in development/staging environments. The metadata URL uses the Supabase function URL directly, creating two different URLs for the same share.

6. **[High] Scene Edit Modal Image Selection Bug**
   In `SceneEditModal.tsx`, `selectedImageIndex` state tracks which image is being viewed in multi-image scenes, but the modification/regeneration handlers don't use this index. When a user selects a specific image and requests a modification, the backend may apply the change to a different image than the one displayed.

7. **[High] Audio Playback Memory Leak in VoiceSelector**
   `VoiceSelector.tsx` creates an `Audio` element stored in a ref for previewing custom voice samples. There is no cleanup on component unmount — if the component unmounts while audio is playing, the audio will continue playing in the background and the reference will be lost.

8. **[Medium] Polling-Based Auto-Recovery Is Inefficient**
   All four workspace components poll every 5 seconds via `setInterval` to check for in-progress generations when loading existing projects. This should use Supabase Realtime subscriptions instead, which would be more efficient and provide instant updates. The `callPhase.ts` file even has commented-out Realtime subscription code, suggesting this was considered but not implemented for recovery.

9. **[Medium] InclinationSelector Component Name Is Misleading**
   The component `InclinationSelector.tsx` controls whether voice expressions are disabled. "Inclination" does not describe this functionality. It should be named `VoiceExpressionsToggle` or similar.

10. **[Medium] SmartFlow Extraction Prompt Not Persisted**
    In `SmartFlowWorkspace.tsx`, the extraction prompt (what key insights to extract from data) is stored in the `presenterFocus` field in the database. This is a field repurposing that creates confusion. When loading an existing SmartFlow project, the extraction prompt is not restored from the project data.

11. **[Medium] Cinematic Workspace Resume Race Condition**
    `CinematicWorkspace.tsx` uses an `isResumeInFlightRef` guard to prevent duplicate resume loops, with a comment acknowledging previous bugs in this area. The polling-based resume logic with multiple refs and effects is fragile and prone to race conditions. A single Realtime subscription would be more reliable.

12. **[Medium] FormatSelector Toast Shows Wrong Plan Name**
    When a locked format is clicked, the toast message says "Starter plan" regardless of which plan the user is on. It should reference the plan that would unlock the format.

#### What Needs to Be Removed

1. **[Low] Commented-Out Upload UI in ContentInput.tsx** — 60+ lines of dead code for file upload tabs
2. **[Low] Commented-Out "Visual Prompt" Section in SceneEditModal.tsx** — Dead code for a removed feature
3. **[Low] `temp_callPhase.ts` at Project Root** — This appears to be a working copy or backup of `src/hooks/generation/callPhase.ts` and is corrupted/malformed. It should be deleted.
4. **[Low] `base_file.txt` at Project Root** — Contains corrupted/binary content that appears to be admin-related TypeScript code. Serves no purpose in its current state.

#### What Needs to Be Added

1. **[High] Error Boundaries Around Workspace Components**
   No error boundaries exist in any workspace. A JS error in any workspace component crashes the entire app. Given the complexity of the generation pipeline with multiple async operations, error boundaries are essential.

2. **[Medium] Image Format Validation for Style Reference Uploads**
   The custom style reference image upload only checks file size (5MB) but not file type. Users could upload non-image files (PDFs, ZIPs, etc.) and the upload would proceed.

---

### 5. Projects Page (`/projects`) — `src/pages/Projects.tsx`

#### What Is Working Correctly
- Infinite scroll pagination with React Query
- Server-side filtering by project type
- Server-side sorting (newest, oldest, A-Z, Z-A)
- Grid and list view toggle
- Search functionality
- Favorites toggle
- Bulk select with delete
- Rename dialog
- Share link generation
- Download (redirects to workspace for video download)
- Thumbnail display with signed URL refresh
- Empty state handling

#### What Needs to Be Changed

1. **[High] Share Token Uses Truncated UUID**
   Share tokens are generated with `crypto.randomUUID().replace(/-/g, "").slice(0, 16)`. This reduces the UUID's 128 bits of entropy to approximately 64 bits (16 hex characters). While still reasonably secure for share links, this is an unnecessary reduction. The full UUID should be used, or a purpose-built token generator with defined entropy requirements should be used instead.

2. **[Medium] Thumbnail Refresh Happens Client-Side**
   The `useRefreshThumbnails` hook regenerates signed URLs client-side for every page of projects. For users with many projects, this creates significant client-side overhead. Signed URLs should have longer expiry times or be refreshed server-side.

3. **[Medium] Download Function Has Unclear Logic**
   The download button for projects checks for `video_url` presence but the actual download mechanism navigates to the workspace page. The flow for downloading existing videos vs navigating to re-export is unclear to the user.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added

1. **[Low] URL-Based Pagination State**
   The current pagination uses component state (`visibleCount`). If a user navigates away and returns, they start at the beginning. Pagination state should be preserved in URL search parameters.

---

### 6. Pricing Page (`/pricing`) — `src/pages/Pricing.tsx`

#### What Is Working Correctly
- Plan comparison with feature lists
- Monthly/yearly billing toggle
- "Save 20%" badge for yearly plans
- Current plan highlighting
- Credit pack purchases
- Downgrade confirmation dialog
- Stripe checkout integration
- Customer portal link for billing management
- Enterprise "Contact Sales" option

#### What Needs to Be Changed

1. **[High] Hardcoded Pricing Data Duplicated Across Three Files**
   Prices are hardcoded in: Landing.tsx (display only), Pricing.tsx (display + checkout), and useSubscription.ts (checkout + Stripe price IDs). The credit pack prices displayed to users should match what Stripe charges. Currently the webhook file shows different prices for the same credit amounts (50 credits: $14.99 in frontend, $34.99 in webhook comments). This either means the prices were updated in one place but not the other, or there are different product versions.

2. **[Medium] "Save 20%" Badge Is Hardcoded**
   The yearly savings badge says "Save 20%" but this percentage is hardcoded, not calculated from the actual monthly vs yearly prices. If prices change, this badge will show incorrect savings.

3. **[Medium] No Error Handling for Stripe Checkout Failure**
   The `createCheckout` function can fail if the Stripe session creation fails, but the Pricing page only catches the error with a generic toast. There's no specific handling for common failure modes (invalid payment method, declined, etc.).

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added
- Nothing identified.

---

### 7. Settings Page (`/settings`) — `src/pages/Settings.tsx`

#### What Is Working Correctly
- Account tab with display name and email editing
- Security tab with password change and strength meter
- Password strength scoring (4 criteria: length, mixed case, digits, special chars)
- Account deletion with confirmation dialog requiring "DELETE" typed
- Sidebar layout consistent with other app pages

#### What Needs to Be Changed

1. **[High] Account Deletion Does Not Actually Delete**
   The "Delete Account" flow opens a confirmation dialog that requires typing "DELETE", but then opens a `mailto:` link to `support@motionmax.io` instead of actually deleting the account. This is misleading — the user goes through a serious confirmation flow expecting immediate deletion, but instead gets an email draft. The Terms of Service (Section 10) state "You may terminate your Account at any time" which implies self-service deletion should be available.

2. **[High] Password Minimum Length Mismatch**
   Settings page requires 8+ character passwords while Auth page requires 6+. See Auth page finding #2.

3. **[Medium] Email Change Has No Verification Flow**
   The email update calls `supabase.auth.updateUser({ email })` which triggers Supabase's email confirmation flow, but there's no UI to inform the user that they need to confirm the change via email. The success toast says "Email update initiated — check your inbox" but there's no persistent indicator.

4. **[Medium] "DELETE" Confirmation Is Case-Sensitive**
   The delete confirmation requires exactly "DELETE" in uppercase. No hint is given about case sensitivity. Users typing "delete" in lowercase will be stuck.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added

1. **[Low] Display Name Character Limit**
   The display name input has no maxLength constraint. A user could enter an extremely long name that breaks sidebar layout.

---

### 8. Usage & Billing Page (`/usage`) — `src/pages/Usage.tsx`

#### What Is Working Correctly
- Current plan display with subscription status
- Credits used this cycle calculation
- Available credits balance
- Activity history table with project type, title, date, credits used, and generation time
- Month filtering dropdown
- "Show More" pagination
- Stripe customer portal integration
- Checkout success detection via URL parameters

#### What Needs to Be Changed

1. **[Medium] Credit Cost Calculation Duplicated**
   The `getCostForGeneration` function in Usage.tsx reimplements the credit cost logic from `planLimits.ts` instead of importing and using `getCreditsRequired`. This creates a maintenance risk — if costs change, both files need updating.

2. **[Medium] "AudioMax:" and "MotionMax:" Prefix Stripping**
   Project titles are cleaned by removing "AudioMax:" or "MotionMax:" prefixes (magic strings). This suggests a naming convention from an older version of the app that was never properly migrated. These prefixes should be cleaned at the database level, not in the display layer.

3. **[Medium] Renewal Date Fallback Uses End of Month**
   When `subscriptionEnd` is not available, the code falls back to end of current month for renewal date display. This may show an incorrect renewal date for users whose billing cycle doesn't align with month boundaries.

4. **[Low] Checkout Success Detection Only on Mount**
   The `checkout_success=true` URL parameter is only checked on initial component mount. If the component is already mounted when the user returns from Stripe checkout (e.g., if opened in the same tab), the success detection and subscription refresh won't trigger.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added

1. **[Low] Export Functionality for Billing History**
   Users cannot export their billing/usage history as CSV or PDF. This is commonly expected for business users who need records for expense reporting.

---

### 9. Voice Lab Page (`/voice-lab`) — `src/pages/VoiceLab.tsx`

#### What Is Working Correctly
- Audio recording with real-time waveform visualization
- File upload with drag-and-drop support
- 10-second minimum duration validation
- Voice list display with playback and delete
- Consent checkbox before cloning
- Links to Terms, Privacy, and Acceptable Use policies
- Voice limit warning modal (based on plan)

#### What Needs to Be Changed

1. **[High] No Handling for Microphone Permission Denial**
   The `startRecording` function calls `navigator.mediaDevices.getUserMedia` but only has a generic catch block that logs to console. If the user denies microphone permission, there's no user-facing error message explaining why recording failed or how to grant permission.

2. **[Medium] Recording Format Mismatch**
   The file upload accepts `audio/mpeg, audio/wav, audio/ogg, audio/webm, audio/mp4, audio/aac` but the recording only produces `audio/webm` via MediaRecorder. The component should document this limitation or attempt to use a more compatible format.

3. **[Medium] Audio Visualization Performance**
   The recording waveform visualization runs at approximately 60fps via `requestAnimationFrame` with `AnalyserNode.getByteTimeDomainData()`. On lower-end devices or when the browser tab is in background, this creates unnecessary CPU usage. The animation should pause when the tab is not visible.

4. **[Medium] Voice Limit Warning Appears But Doesn't Prevent Submission**
   The modal warning about voice clone limits appears automatically when the user has reached their plan's limit, but it doesn't disable the clone button. A user could dismiss the modal and still attempt to clone, which would fail on the backend.

5. **[Low] No Cleanup of Recorded Blob on Unmount**
   The recorded audio blob is stored in state and not cleaned up when the component unmounts. While not a severe leak, the blob URL should be revoked on unmount.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added
- Nothing identified.

---

### 10. Public Share Page (`/share/:token`) — `src/pages/PublicShare.tsx`

#### What Is Working Correctly
- Fetches shared project via edge function with fresh signed URLs
- Video and image playback with per-scene navigation
- Audio sync with image rotation
- Seekable progress slider
- Scene counter display
- Responsive mobile layout
- "Back to MotionMax" link

#### What Needs to Be Changed

1. **[High] Complex Playback Logic With Potential Sync Issues**
   The playback system uses multiple refs (`audioRef`, `currentSceneRef`, `timerRef`, `sceneStartTimeRef`), multiple effects, and the `timeupdate` event for audio synchronization. The `timeupdate` event fires at irregular intervals (typically 4 times per second) which can cause visible desync between scenes and audio, especially for short scenes (under 3 seconds).

2. **[Medium] Scene Duration Hardcoded to 3 Seconds**
   When no audio duration is available, scene duration defaults to 3 seconds. This is hardcoded in the component rather than coming from the project data or backend configuration.

3. **[Medium] Share Link Validity Not Periodically Checked**
   The share link validity is only checked on initial page load. If a share link is revoked while the page is open, the user will see no indication until they refresh.

4. **[Medium] No Buffering Indicator**
   When video or audio content is loading/buffering, there is no visual indicator. Users may think the playback is broken when it's actually loading.

5. **[Low] Full-Screen API Not Checked for Browser Support**
   The component may attempt to use fullscreen API without checking `document.fullscreenEnabled`, which could throw errors in unsupported browsers.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added
- Nothing identified.

---

### 11. Admin Page (`/admin`) — `src/pages/Admin.tsx` + `src/components/admin/*`

#### What Is Working Correctly
- Admin authentication check via `useAdminAuth` hook
- Tabbed interface: Overview, Subscribers, Revenue, Generations, API Calls, Flags, Logs
- Sign out functionality
- Access denied screen for non-admins

#### What Needs to Be Changed

1. **[High] Admin Route Has No Additional Auth Beyond ProtectedRoute**
   The `/admin` route uses the same `ProtectedRoute` wrapper as all authenticated pages. Admin verification happens inside the `Admin.tsx` component via `useAdminAuth`. This means any authenticated user hits the admin page component and loads its code before being denied access. The admin check should be a separate route guard to prevent unnecessary code loading.

2. **[Medium] No Logging of Unauthorized Admin Access Attempts**
   When a non-admin user navigates to `/admin`, they see an "Access Denied" screen but no server-side log is created. Tracking unauthorized access attempts is a basic security monitoring practice.

3. **[Low] User Avatar Shows Only First Character of Email**
   The admin page displays the user's email initial in an avatar. Since the app has a profile display name feature, the avatar should use the display name initial when available.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added
- Nothing identified.

---

### 12. Legal Pages — Terms (`/terms`), Privacy (`/privacy`), Acceptable Use (`/acceptable-use`)

#### What Is Working Correctly
- Comprehensive legal content covering all major areas
- Terms: 12 sections covering account, usage, IP, billing, voice cloning, liability, termination
- Privacy: 10 sections covering data collection, usage, sharing, rights, cookies
- Acceptable Use: 7 sections covering prohibited content, voice cloning rules, enforcement
- Consistent layout with back navigation and logo
- Cross-linked to each other
- Contact email (support@motionmax.io) consistently referenced

#### What Needs to Be Changed

1. **[Medium] Hardcoded "February 2026" Dates**
   All three legal pages have "Last updated: February 2026" hardcoded. When these documents are updated, the dates must be manually changed in each file. A more robust approach would derive dates from a config or git metadata.

2. **[Low] No Version History or Changelog**
   Legal documents have no version history. When terms change, users should be able to see what changed.

3. **[Low] Acceptable Use Policy References `abuse@motionmax.io`**
   The Acceptable Use page references `abuse@motionmax.io` for reporting violations, while all other pages use `support@motionmax.io`. This second email address should be verified to be a real, monitored inbox.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added
- Nothing identified.

---

### 13. 404 Page — `src/pages/NotFound.tsx`

#### What Is Working Correctly
- Shows 404 indicator with "Home" and "Go Back" buttons
- Clean, minimal design

#### What Needs to Be Changed

1. **[Low] No Analytics Tracking**
   404 hits are not tracked, so there's no way to identify broken links or common mistyped URLs.

2. **[Low] No Suggestions**
   The 404 page offers no suggestions for where the user might have intended to go. A list of common pages would be helpful.

#### What Needs to Be Removed
- Nothing identified for removal.

#### What Needs to Be Added
- Nothing identified.

---

## Cross-Cutting / Application-Wide Findings

### Security

1. **[Critical] `.env` File Committed to Repository**
   The `.env` file containing `VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_SUPABASE_URL` is in the repository. While these are client-side keys meant to be public, having `.env` in the repo establishes a dangerous pattern. If someone adds a `STRIPE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` to this file, it would be committed. The `.env` should be in `.gitignore` with a `.env.example` template instead.

2. **[Critical] Overly Permissive RLS Policies on `video_generation_jobs`**
   Migration `20260308210700_worker_anon_access.sql` creates RLS policies with `USING (true)` for SELECT, INSERT, UPDATE, and DELETE on `video_generation_jobs`. This means any user with the anonymous key can read, create, modify, or delete any video generation job in the system, including those belonging to other users. This is a data exposure and tampering vulnerability.

3. **[Critical] Public Video Storage Bucket Without Path-Based Access Control**
   Migration `20260309013400_create_videos_bucket.sql` creates a public storage bucket where authenticated users have full CRUD access and anonymous users have read/insert access, with no path-based restrictions. Any authenticated user can read/delete any other user's videos. The policies should restrict access to `user_id/` prefixed paths.

4. **[High] CORS Set to Allow All Origins**
   All Supabase Edge Functions use `"Access-Control-Allow-Origin": "*"` in CORS headers. While common for APIs, this means any website can make requests to the functions. The CORS origin should be restricted to the app's domain(s).

5. **[Medium] No Content Security Policy**
   The `index.html` has no Content Security Policy (CSP) meta tag or header. This leaves the app vulnerable to XSS attacks from injected scripts.

### Architecture

6. **[High] Duplicate Sidebar Layout Pattern**
   Pages that need the sidebar (Index, Projects, Settings, Usage, VoiceLab, Pricing) each independently wrap themselves with `SidebarProvider` + `AppSidebar`. This is repeated 6+ times. A layout route in React Router should provide this wrapper once.

7. **[High] No React Error Boundaries**
   The entire application has no error boundaries. A JavaScript error in any component crashes the whole app with a white screen. Given the complexity of the generation pipeline with WebSocket connections, async operations, and media playback, unhandled errors are inevitable.

8. **[Medium] QueryClient Has No Global Error Handler**
   The `QueryClient` in `App.tsx` is created with default options. There's no `onError` callback, meaning failed queries are silently swallowed unless individual components handle errors.

9. **[Medium] `next-themes` Used in Non-Next.js App**
   The app uses `next-themes` for theme management in a Vite/React app. While it works, `next-themes` is designed for Next.js and carries unnecessary SSR-related code. A lighter alternative like a simple React context or `@radix-ui/react-themes` would be more appropriate.

10. **[Medium] PWA Manifest `display: "browser"` Defeats PWA Purpose**
    The manifest sets `display: "browser"` which shows the full browser chrome when the PWA is installed. This makes the installed PWA look identical to a regular browser tab, defeating the purpose of PWA installation. It should be `"standalone"` for app-like experience. A comment in `index.html` explains `apple-mobile-web-app-capable` was removed due to audio session issues on iOS, but `display: "standalone"` in the manifest affects all platforms, not just iOS.

11. **[Medium] PWA Icon Purpose Malformed**
    The manifest icons use `"purpose": "any maskable"` which should be two separate icon entries — one with `"purpose": "any"` and another with `"purpose": "maskable"`. Combining them in a space-separated string is deprecated.

### Data Consistency

12. **[High] Three Different Product ID Sets Across Frontend, Webhook, and Check-Subscription**
    As detailed in Finding #1 of the Landing Page section, there are three different sets of Stripe product IDs across the codebase. The frontend `useSubscription.ts` and `check-subscription/index.ts` use one set, while `stripe-webhook/index.ts` uses a completely different set. Both include legacy mappings, creating four effective ID sets. This needs immediate reconciliation to ensure payments are correctly processed.

13. **[Medium] "smartflow" vs "smart-flow" Dual Project Type**
    Multiple components throughout the app check for both `"smartflow"` and `"smart-flow"` as project types. This suggests a naming change was made in the frontend but never migrated in the database. A migration should standardize this to one value.

### Performance

14. **[Medium] Google Fonts Loaded via CSS @import**
    `index.css` imports Inter and Montserrat from Google Fonts via `@import url()`. This blocks CSS rendering until the fonts are fetched. These should be preloaded via `<link rel="preload">` in `index.html` for better performance.

15. **[Medium] Workbox Runtime Caching for Supabase API**
    The Vite PWA config caches Supabase API responses with `NetworkFirst` strategy and 300-second expiry. This means stale data could be served for up to 5 minutes if the network fails. For an app dealing with real-time generation status, this could show outdated generation progress or credit balances.

16. **[Low] `node-fetch` Dependency Is Redundant in Worker**
    The worker service (`worker/package.json`) includes `node-fetch` as a dependency. Node.js 18+ (which the worker targets with `ES2022`) has built-in `fetch`. This is an unnecessary dependency.

17. **[Low] `axios` vs Native `fetch` Inconsistency in Worker**
    The worker uses both `axios` and native `fetch` for HTTP requests. This should be standardized to one approach (preferably native `fetch`) to reduce bundle size and complexity.

### CSS / Design System

18. **[Critical] Destructive Color Same as Primary**
    In `index.css`, `--destructive` is set to `170 55% 54%` — the exact same value as `--primary` (teal). This means destructive actions (delete buttons, error states, alert dialogs) are visually identical to primary actions. Users cannot visually distinguish between a "Create" button and a "Delete" button based on color. Destructive actions should use a red/warning color to signal danger. The delete button in `AppSidebar.tsx` uses `className="bg-muted text-foreground"` to work around this, but this is a band-aid solution.

19. **[Medium] Tailwind Config References Content Paths That Don't Exist**
    The Tailwind config includes `"./pages/**/*.{ts,tsx}"`, `"./components/**/*.{ts,tsx}"`, `"./app/**/*.{ts,tsx}"` as content paths. These root-level directories don't exist — all source files are under `./src/`. While `"./src/**/*.{ts,tsx}"` is also included (so no classes are actually missed), the non-existent paths add unnecessary scanning overhead.

20. **[Low] Montserrat Font Imported But Never Used**
    `index.css` imports both Inter and Montserrat from Google Fonts, but the Tailwind config only sets `Inter` as the sans font family. Montserrat is never referenced in any component or CSS class, making it a wasted 100KB+ download.

### Backend (Edge Functions)

21. **[High] `generate-video/index.ts` Is Extremely Large**
    This single edge function file exceeds 71,000 tokens (roughly 3,000+ lines). It handles scripting, audio generation, image generation, image editing, finalization, scene regeneration — all in one function. This violates single-responsibility principle and makes the code very difficult to maintain, debug, and deploy. Individual phases should be separate functions.

22. **[Medium] Deno Standard Library Version Inconsistency**
    Edge functions use different Deno std versions: `std@0.168.0` in generate-video, `std@0.190.0` in stripe-webhook, `std@0.177.0` in generate-cinematic. These should all use the same version to prevent unexpected behavior differences.

23. **[Medium] Supabase JS Client Version Inconsistency**
    Edge functions use `@supabase/supabase-js@2.90.1`, `@supabase/supabase-js@2.57.2`, and `@supabase/supabase-js@2` across different functions. This creates risk of incompatible behaviors between functions.

### Worker Service

24. **[Medium] No Job Queue System**
    The worker service polls the `video_generation_jobs` table for new jobs rather than using a proper job queue (Bull, BullMQ, etc.). This creates: (a) unnecessary database load from constant polling, (b) no built-in retry/backoff/dead-letter queue, (c) no job priority system, (d) potential race conditions if multiple workers poll simultaneously.

25. **[Medium] No Structured Logging**
    Both the frontend and worker use `console.log`/`console.error` for logging. A structured logging library (pino, winston) would provide log levels, JSON output, correlation IDs, and better observability.

26. **[Low] Worker Has Compiled JS Files Alongside TypeScript Sources**
    The `worker/src/` directory contains both `.ts` source files and their compiled `.js` and `.d.ts` counterparts (e.g., `generateVideo.ts` + `generateVideo.js` + `generateVideo.d.ts`). The compiled files should be in a separate `dist/` directory and excluded from version control.

---

## Assets and Static Files Audit

### Images and Media

| Asset | Status | Notes |
|-------|--------|-------|
| `src/assets/motionmax-logo.png` | OK | Used in Landing, legal pages |
| `src/assets/motionmax-hero-logo.png` | OK | Used in hero section |
| `src/assets/hero-promo-optimized.mp4` | OK | Autoplay hero video |
| `src/assets/hero-video-poster.png` | OK | Video poster image |
| `src/assets/features-bg-dark.png` | Issue | Used for all themes (see Finding #4 Landing Page) |
| `src/assets/dashboard/dashboard-bg-dark.png` | OK | Dashboard dark mode bg |
| `src/assets/dashboard/dashboard-bg-light.png` | OK | Dashboard light mode bg |
| `src/assets/dashboard/default-thumbnail.png` | OK | Placeholder thumbnail |
| `src/assets/styles/*.png` (14 files) | OK | Style preview images for selector |
| `public/favicon.png` | OK | Browser tab icon |
| `public/og-image.png` | OK | Social sharing image |
| `public/apple-touch-icon.png` | OK | iOS home screen icon |

### Links Audit

| Link | Location | Status | Notes |
|------|----------|--------|-------|
| `mailto:support@motionmax.io` | Landing, Pricing, Settings, Terms, Privacy | OK | Primary contact |
| `mailto:abuse@motionmax.io` | Acceptable Use | Unverifiable | Should confirm inbox exists |
| `/auth` | Landing, multiple pages | OK | Auth page |
| `/app` | Dashboard, sidebar | OK | Main dashboard |
| `/app/create?mode=*` | Sidebar, dashboard | OK | Workspace routes |
| `/projects` | Sidebar, dashboard | OK | Projects list |
| `/settings` | Sidebar, admin | OK | Settings page |
| `/usage` | Sidebar | OK | Usage & billing |
| `/pricing` | Sidebar, usage | OK | Pricing page |
| `/voice-lab` | Sidebar | OK | Voice cloning |
| `/admin` | Sidebar (admin only) | OK | Admin panel |
| `/terms` | Auth, legal pages | OK | Terms of service |
| `/privacy` | Auth, legal pages | OK | Privacy policy |
| `/acceptable-use` | VoiceLab, legal pages | OK | Acceptable use |
| `/share/:token` | Share links | OK | Public share page |
| `#features`, `#pricing`, `#about` | Landing nav | OK | Anchor scroll links |
| `https://motionmax.io` | index.html canonical | Unverifiable | Domain should match deployment |
| `https://motionmax.io/og-image.png` | index.html OG tags | Unverifiable | Absolute URL for social sharing |
| `https://motionmax.io/share/*` | ResultActionBar, CinematicResult | Hardcoded | Won't work in non-production environments |

---

## Completeness Assessment

### What the App Documentation Says Should Exist vs What Actually Exists

| Documented Feature | Status | Notes |
|--------------------|--------|-------|
| Text-to-video generation | Exists | Doc2Video and Storytelling workspaces |
| AI-generated visuals | Exists | Multiple style options with AI image generation |
| Natural voiceovers | Exists | Standard voices (male/female) |
| Voice cloning | Exists | VoiceLab page with recording/upload |
| 4K video export | Partially Exists | Worker has FFmpeg export but 4K quality is only on Professional plan; no verification that output is actually 4K |
| Image editing | Exists | SceneEditModal with modification and regeneration |
| Audio regeneration | Exists | Per-scene audio regeneration in edit modal |
| Free signup | Exists | Free tier with 5 credits/month |
| Multiple visual styles | Exists | 13 styles + custom |
| Document to video | Exists | Doc2Video workspace accepts pasted text |
| Infographics | Exists | SmartFlow workspace |
| Cinematic video | Exists (Beta) | Professional plan only |
| Watermark on free exports | Cannot Verify | Referenced in pricing but no watermark logic found in frontend export code; may be applied server-side |
| 720p/1080p/4K quality tiers | Cannot Verify | Plan limits define quality tiers but actual resolution control is in backend/worker; cannot verify output quality matches plan |
| Multilingual narration | Cannot Verify | Referenced in Professional plan features but no language selection UI exists in any workspace |
| Enterprise plan | Partially | Listed in pricing with "Contact Sales" but no dedicated enterprise onboarding or features beyond Professional |

### What Exists But Serves No Clear Purpose

1. **`base_file.txt`** — Corrupted binary/text file at project root with no purpose
2. **`temp_callPhase.ts`** — Temporary/backup file at project root that duplicates `src/hooks/generation/callPhase.ts`
3. **`src/components/ui/use-toast.ts`** — Duplicate of `src/hooks/use-toast.ts` (shadcn/ui default location vs project convention)
4. **Compiled JS files in worker/src/** — `.js` and `.d.ts` files alongside `.ts` source files
5. **`story-weaver-audit.cmd`** — Found in grep results; appears to be a previous audit command file
6. **`lovable-tagger` dev dependency** — Tagged as development tool from Lovable platform; may not be needed if the app has moved away from Lovable

---

## Priority Action Items

### Immediate (Critical)

1. Fix the Stripe product ID mismatch between frontend, check-subscription, and stripe-webhook to ensure payments are correctly processed
2. Fix the destructive color being identical to primary — delete buttons are indistinguishable from create buttons
3. Add path-based RLS policies to `video_generation_jobs` table to prevent cross-user data access
4. Add path-based access control to the videos storage bucket
5. Fix ProtectedRoute to pass the actual return URL so deep links work after authentication
6. Fix `characterConsistencyEnabled` not being sent to the backend in Doc2Video workspace
7. Move `.env` to `.gitignore` and create `.env.example`
8. Add React error boundaries at minimum around each workspace and the main app layout

### Short-Term (High)

9. Reconcile password minimum length (6 vs 8) across Auth and Settings pages
10. Add user-facing error for microphone permission denial in VoiceLab
11. Fix silent failure on custom style image upload (add toast notification)
12. Fix SceneEditModal to use selectedImageIndex in modification/regeneration handlers
13. Clean up audio playback in VoiceSelector on unmount
14. Extract shared sidebar layout into a React Router layout route
15. Restrict CORS origins to application domain(s) in Edge Functions
16. Remove dead code (ContentInput upload section, temp files, compiled worker JS)

### Medium-Term (Medium)

17. Create a single source of truth for pricing data
18. Standardize "smartflow" vs "smart-flow" project type with a database migration
19. Add Content Security Policy headers
20. Replace Google Fonts CSS @import with preload links
21. Add structured logging throughout the application
22. Break apart the 3000+ line generate-video edge function into separate phase functions
23. Standardize Deno std and Supabase client versions across edge functions
24. Implement Realtime subscriptions for generation recovery instead of polling
25. Add image format validation for style reference uploads

### Long-Term (Low)

26. Add sitemap.xml and reference it in robots.txt
27. Remove unused Montserrat font import
28. Implement URL-based pagination state for Projects page
29. Add export functionality for billing history
30. Replace `next-themes` with a lighter Vite-compatible alternative
31. Evaluate replacing `node-fetch` and `axios` with native fetch in worker
32. Add 404 analytics tracking
33. Add legal document version history

---

*End of Audit*
