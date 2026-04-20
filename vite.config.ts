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
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB — covers herobackground.webp (~116 KB) + other assets
        globPatterns: ["**/*.{js,css,html,ico,png,webp,svg,woff2}"],
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
    // Only generate source maps when SENTRY_AUTH_TOKEN is present so they can be
    // uploaded and deleted. Without the token the Sentry plugin is skipped and
    // .map files would otherwise land in dist/ and ship to prod.
    sourcemap: mode === "production" && !!process.env.SENTRY_AUTH_TOKEN,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "ui-vendor": ["framer-motion", "@tanstack/react-query"],
          "supabase": ["@supabase/supabase-js"],
          "recharts": ["recharts"],
        },
      },
    },
  },
}));
