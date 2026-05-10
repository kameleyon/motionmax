/**
 * Lighthouse CI configuration.
 *
 * History:
 *   Phase 19.3 — initial /admin perf gating.
 *   Wave D §C-3 (2026-05-10) — widened coverage to the public,
 *     conversion-critical funnel (landing, pricing, signup, share,
 *     help). Admin stays the strict perf gate (auth'd, throttled
 *     desktop); the public routes have looser perf budgets per the
 *     mobile-3G reality of a marketing landing.
 *
 * Run with:
 *   npx lhci autorun --config=./lighthouserc.cjs
 *
 * Pre-reqs:
 *   • dev server running on http://localhost:5173 OR set BASE_URL=
 *     to a deployed preview (Vercel preview URL is recommended for
 *     auth'd admin runs since the session cookie is already set).
 *   • For /admin you'll need a pre-auth Puppeteer script or a
 *     preview URL with the admin cookie already attached. Public
 *     routes (landing / pricing / share / help / signup) run
 *     unauthenticated against the dev server with no extra setup.
 */
const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

// Sample shareable token for /share/:token — set SHARE_TOKEN in CI
// to a live preview share, or fall back to a sentinel that returns
// the "share not found" state (which still benchmarks the chrome).
const SHARE_TOKEN = process.env.LH_SHARE_TOKEN || "sample-token";

module.exports = {
  ci: {
    collect: {
      // Wave D §C-3: cover the funnel. Order matters for cache —
      // / lands first to warm any shared chunks, then the rest.
      url: [
        `${BASE_URL}/`,
        `${BASE_URL}/pricing`,
        `${BASE_URL}/auth?mode=signup`,
        `${BASE_URL}/help`,
        `${BASE_URL}/share/${SHARE_TOKEN}`,
        `${BASE_URL}/admin?tab=overview`,
      ],
      numberOfRuns: 3,
      settings: {
        // Desktop preset with 4G throttling. Public routes are run
        // with the same settings so deltas across routes are
        // comparable; for true mobile budgeting set LH_PRESET=mobile.
        preset: process.env.LH_PRESET || "desktop",
        throttling: {
          rttMs: 40,
          throughputKbps: 10240,
          cpuSlowdownMultiplier: 1,
        },
        // Skip pwa audits — admin is not a PWA and the share viewer
        // is route-specific. Public marketing pages DO benefit from
        // the install audit but the perf gates above cover SW.
        skipAudits: ["service-worker", "installable-manifest"],
      },
    },
    assert: {
      // Per-route assertions. /admin stays the strict desktop gate;
      // public routes target the mobile-friendly ≥85 perf / ≥95 a11y
      // bar called out in Wave D §C-3.
      assertMatrix: [
        {
          matchingUrlPattern: "/admin",
          assertions: {
            "categories:performance":    ["error", { minScore: 0.90 }],
            "categories:accessibility":  ["error", { minScore: 0.95 }],
            "interactive":               ["error", { maxNumericValue: 1500 }],
            "categories:best-practices": ["warn",  { minScore: 0.90 }],
          },
        },
        {
          // Public funnel — landing / pricing / help / share / signup.
          // Slightly looser perf budget reflects the marketing-page
          // reality (hero fonts, OG video, signup form). Still gates
          // on the regression that an unbundled dependency would cause.
          matchingUrlPattern: "/(pricing|help|auth|share|^/$)",
          assertions: {
            "categories:performance":    ["error", { minScore: 0.85 }],
            "categories:accessibility":  ["error", { minScore: 0.95 }],
            "categories:best-practices": ["warn",  { minScore: 0.90 }],
            "categories:seo":            ["warn",  { minScore: 0.90 }],
          },
        },
      ],
    },
    upload: {
      // Default: write reports to .lighthouseci/. CI providers can
      // upload from there. Swap target to "lhci" with a server URL
      // for a hosted Lighthouse server.
      target: "filesystem",
      outputDir: "./.lighthouseci",
    },
  },
};
