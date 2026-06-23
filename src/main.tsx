import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { initSentry } from "@/lib/sentry";
import { captureUtmParams } from "@/hooks/useAnalytics";
import { registerServiceWorkerWithUpdates } from "@/lib/swUpdate";
import { startWebVitalsReporting } from "@/lib/webVitals";
import App from "./App.tsx";
import "./index.css";

// Initialise Sentry before rendering so it captures any bootstrap errors
initSentry();
// Persist UTM params before the SPA replaces the URL
captureUtmParams();
// Register the PWA service worker + auto-prompt on new version. With
// skipWaiting+clientsClaim in workbox, the SW takes over immediately;
// this hook prompts the user to reload so the in-memory JS bundle
// catches up too. See src/lib/swUpdate.ts for the full rationale.
void registerServiceWorkerWithUpdates();
// §5 PERF — start Web Vitals (LCP, CLS, INP, TTFB) collection so field
// data flows through the existing GA pipeline. Lighthouse-CI gives us a
// synthetic snapshot; this gives us the real-user distribution.
startWebVitalsReporting();

// Auto-recover from stale-chunk errors after a deploy. When a new
// version ships, Vite re-hashes the lazy chunks; a tab that loaded the
// OLD index.html still references the old hashes, so the next route's
// dynamic import() 404s with "Failed to fetch dynamically imported
// module" and the user lands on the error boundary. Vite fires
// `vite:preloadError` for exactly this.
//
// A plain location.reload() is NOT enough here: the PWA service worker
// uses navigateFallback: "app-shell.html" (see vite.config.ts), so a
// navigation can be served the PRECACHED old index — which references
// the same purged chunk — and we'd loop on the stale shell. So before
// reloading we tear down the SW + caches, forcing the reload to fetch a
// fresh index.html from the network. A sessionStorage timestamp guards
// against reload loops if the chunk is genuinely missing (broken
// deploy): after one recovery inside the window, we let the error
// surface instead of looping.
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "mm_chunk_reload_at";
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 15_000) return; // already recovered recently — surface the error
  sessionStorage.setItem(KEY, String(Date.now()));
  event.preventDefault();
  void (async () => {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* best-effort — reload anyway */
    }
    window.location.reload();
  })();
});

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);
