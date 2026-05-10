import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    // Upload source maps + create a Sentry release/deploy marker in production builds
    mode === "production" && process.env.SENTRY_AUTH_TOKEN && sentryVitePlugin({
      org: process.env.SENTRY_ORG || "motionmax",
      project: process.env.SENTRY_PROJECT || "motionmax-frontend",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: {
        // Use Vercel's VERCEL_GIT_COMMIT_SHA or Render's RENDER_GIT_COMMIT, fall back to timestamp
        name: process.env.VERCEL_GIT_COMMIT_SHA ||
              process.env.RENDER_GIT_COMMIT ||
              process.env.COMMIT_REF ||
              `build-${Date.now()}`,
        // Create a Sentry deploy record linked to the release
        deploy: {
          env: "production",
        },
        setCommits: {
          auto: true,
        },
      },
      sourcemaps: {
        filesToDeleteAfterUpload: ["./dist/**/*.map"], // Don't ship source maps to users
      },
    }),
    VitePWA({
      registerType: "autoUpdate",
      manifest: false, // use existing public/manifest.json
      workbox: {
        // Stale-version eviction settings. Without these three flags, a
        // new SW installs but enters "waiting" state — the OLD SW keeps
        // serving cached app-shell to existing tabs forever, which is
        // why users had to hard-reload to see new code. Now:
        //   skipWaiting        → new SW activates immediately on install,
        //                        no waiting for all tabs to close
        //   clientsClaim       → new SW takes control of all open tabs
        //                        as soon as it activates (combined with
        //                        skipWaiting, no manual hard reload needed)
        //   cleanupOutdatedCaches → old workbox precache buckets from
        //                          prior builds are deleted automatically
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB — covers herobackground.webp (~116 KB) + other assets
        // §5 PERF-005 / Edge F4 fix (2026-05-10): exclude the heavy PNG
        // fallbacks from precache. herobackground.png (2.4 MB) and the
        // raster style-preview PNGs all have WebP equivalents that are
        // 84-95% smaller — those WebPs are what we precache. The PNGs
        // remain reachable from the network for the <0.5% of browsers
        // that can't decode WebP (legacy IE, very old Safari). Without
        // these excludes, every PWA install was eating ~9 MB on first
        // load just to ship dual-encoded images.
        // Small icons (favicon, apple-touch, pwa-*) stay precached via
        // the png glob; the ignore list cherry-picks heavy hero rasters.
        globPatterns: ["**/*.{js,css,ico,png,webp,svg,woff2}", "app-shell.html"],
        globIgnores: [
          "**/herobackground.png",
          "**/caption.png",
          // The Vite asset graph emits `<name>-<hash>.png` for the
          // imported style previews. Match the hashed forms too.
          "**/*-preview-*.png",
          // _archive-pre-b5-fix is reference/snapshot material, not
          // anything the live app fetches — exclude wholesale.
          "**/_archive-pre-b5-fix/**",
        ],
        navigateFallback: "app-shell.html",
        navigateFallbackDenylist: [/^\/(?:$|terms|privacy|acceptable-use)(?:\/|$)/],
        runtimeCaching: [
          // ── C-5-8 (Edge F6): Supabase REST + Auth — NetworkOnly ──
          //
          // Previously: NetworkFirst with maxAgeSeconds 300, applied to
          // ANY supabase.co URL. That cached user-scoped GET responses
          // (rest/v1/projects?user_id=eq.<UUID>, auth/v1/user, etc.)
          // for 5 minutes in the SW's "supabase-api" cache. PRIVACY/AUTH
          // RISK on shared devices and after logout: a different user
          // signing in within 5 min would see the previous user's
          // cached SELECT responses. Workbox doesn't scope caches by
          // Authorization header, so the bytes leaked across sessions.
          //
          // Fix: NetworkOnly for /rest/v1/* and /auth/v1/* paths.
          // Workbox skips Cache Storage entirely for these — every
          // request hits the network with the current session's
          // Authorization header. Trade-off: we lose the 5-minute
          // offline-cache benefit (a backgrounded tab can't read from
          // SW cache while the network is down). Mitigation:
          // tanstack-query's in-memory cache + the realtime channels
          // already provide a soft-online experience; the SW layer was
          // duplicative and unsafe.
          //
          // Cleaner long-term path (deferred — out of scope for the
          // §5 critical fix): use Workbox `cacheKeyWillBeUsed` to
          // namespace the cache key by current user id (read from a
          // `mm_session_user` cookie or postMessage from main thread),
          // then revert to NetworkFirst with a short maxAge. Documented
          // here so the next pass can find the audit reference.
          {
            urlPattern: /^https:\/\/[^/]+\.supabase\.co\/(rest|auth)\/v\d+\/.*/i,
            handler: "NetworkOnly",
            options: { cacheName: "supabase-api" },
          },
          // Other Supabase endpoints (Functions, Realtime websocket
          // upgrade, Storage list APIs) keep the previous NetworkFirst
          // posture but with maxAge dropped to 60s — short enough that
          // a stale response can't outlive a logout by more than a
          // minute, long enough to soak up duplicate burst calls.
          {
            urlPattern: /^https:\/\/[^/]+\.supabase\.co\/.*/i,
            handler: "NetworkFirst",
            options: { cacheName: "supabase-api", expiration: { maxEntries: 50, maxAgeSeconds: 60 } },
          },
          // ── C-5-9 (Edge F7): Supabase storage thumbnails — SWR ──
          //
          // Previously: CacheFirst with maxAgeSeconds 86400 (24h).
          // Wrong because Supabase Storage signed URLs expire after
          // 5 minutes (the default `createSignedUrl` TTL). The SW
          // would happily serve a cached signed URL up to 24h after
          // mint; the browser would then fetch the asset, get a 403
          // from Storage because the signature expired, and the user
          // saw broken thumbnails.
          //
          // Fix: StaleWhileRevalidate with maxAge 240s (4 min, well
          // under the 5-min URL TTL). 5-min signed URLs expire fast;
          // SWR-with-4min-TTL prevents stale-after-expiry. Each request
          // returns the cached copy immediately (fast paint) and kicks
          // off a background refetch; under SWR the SW also drops the
          // stale entry once maxAge elapses, so a re-mounted thumbnail
          // with an expired signature triggers a full network round
          // trip (which the upstream code refreshes via a new
          // `createSignedUrl` in any case).
          //
          // Long-term fix (deferred — out of scope here): move
          // thumbnails to a separate "thumbnails" bucket served via
          // public URLs OR signed URLs with a 24h+ TTL. Then 24h
          // CacheFirst is safe and we get real offline behaviour for
          // the dashboard gallery. See audit C-5-9 follow-up.
          {
            urlPattern: /^https:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "supabase-thumbnails",
              expiration: { maxEntries: 200, maxAgeSeconds: 240 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Google Fonts stylesheet (stale-while-revalidate to avoid LCP blocking)
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "google-fonts-stylesheets",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 7 }, // 7 days
            },
          },
          {
            // Google Fonts files (immutable; cache permanently)
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }, // 1 year
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    // Source-map policy:
    //   - In production builds, ALWAYS use 'hidden' so the .map files exist
    //     for Sentry to upload but are NOT referenced by the JS via a
    //     //# sourceMappingURL comment, so even if the post-upload delete
    //     fails partway, browsers won't auto-discover the maps.
    //   - In dev, full source maps for debugging.
    //   - The Sentry plugin still picks up the maps from dist/ via its
    //     glob and uploads them; filesToDeleteAfterUpload then strips them.
    //   This belt-and-suspenders prevents source ever leaking to prod
    //   if the upload-then-delete pipeline glitches.
    sourcemap: mode === "production" ? (process.env.SENTRY_AUTH_TOKEN ? "hidden" : false) : true,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "ui-vendor": ["framer-motion", "@tanstack/react-query"],
          "supabase": ["@supabase/supabase-js"],
          // recharts intentionally NOT in manualChunks — it ships only
          // with the lazy-loaded admin tab chunks (AdminGenerations,
          // AdminPerformanceMetrics, AdminQueueMonitor, AdminWorkerHealth,
          // AdminRevenue) so non-admin users never download its ~120 KB
          // gzipped weight.
        },
      },
    },
  },
}));
