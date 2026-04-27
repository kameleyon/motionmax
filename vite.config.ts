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
        globPatterns: ["**/*.{js,css,ico,png,webp,svg,woff2}", "app-shell.html"],
        navigateFallback: "app-shell.html",
        navigateFallbackDenylist: [/^\/(?:$|terms|privacy|acceptable-use)(?:\/|$)/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: "NetworkFirst",
            options: { cacheName: "supabase-api", expiration: { maxEntries: 50, maxAgeSeconds: 300 } },
          },
          {
            // Project thumbnails served from Supabase storage (signed URLs)
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "supabase-thumbnails",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 }, // 24h
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
