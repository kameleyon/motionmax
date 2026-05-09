/**
 * Phase 19.3 — Lighthouse CI configuration for /admin perf gating.
 *
 * Run with:
 *   npx lhci autorun --config=./lighthouserc.cjs
 *
 * Pre-reqs:
 *   • dev server running on http://localhost:5173
 *   • admin login session cookie present (Lighthouse runs unauth'd by
 *     default — for /admin which is gated by AdminRoute, you need
 *     either a Puppeteer pre-auth script or run against a deployed
 *     preview where the admin session cookie is already set).
 *
 * Gates (per Phase 19.3 spec):
 *   • Performance ≥ 90
 *   • Accessibility ≥ 95
 *   • Time-to-Interactive ≤ 1500 ms (proxied via "interactive" metric)
 *
 * Best-practices + SEO scores are NOT gated — admin is noindex by
 * design (`<meta name="robots" content="noindex,nofollow">` in
 * Admin.tsx) and SEO assertions there would be noise.
 */
module.exports = {
  ci: {
    collect: {
      // Run against the dev server. If you're running against a
      // deployed preview, swap to https://<your-preview>.vercel.app
      // (or whatever your hosting target is) and set the BASE_URL env var.
      url: [
        (process.env.BASE_URL || "http://localhost:5173") + "/admin?tab=overview",
      ],
      numberOfRuns: 3,
      settings: {
        // Throttle to 4G to match the spec's "1.5 s p95 on a 4 G
        // connection" assertion. Lighthouse's "mobile" preset is too
        // aggressive (slow 4G); we use "desktop" base + custom
        // throttling so the numbers are interpretable for an admin
        // panel, which won't be loaded on a 2009 Android phone.
        preset: "desktop",
        throttling: {
          rttMs: 40,
          throughputKbps: 10240,
          cpuSlowdownMultiplier: 1,
        },
        // Skip pwa audits — admin is not a PWA.
        skipAudits: ["service-worker", "installable-manifest"],
      },
    },
    assert: {
      assertions: {
        "categories:performance":   ["error", { minScore: 0.90 }],
        "categories:accessibility": ["error", { minScore: 0.95 }],
        "interactive":              ["error", { maxNumericValue: 1500 }],
        // Best practices and SEO are advisory, not gates.
        "categories:best-practices": ["warn", { minScore: 0.90 }],
      },
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
