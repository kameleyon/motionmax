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
// `vite:preloadError` for exactly this — we reload ONCE to pull the
// fresh index.html + current hashes. A sessionStorage timestamp guards
// against reload loops if the chunk is genuinely missing (broken
// deploy): after one reload inside the window, we let the error surface
// instead of looping.
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "mm_chunk_reload_at";
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 10_000) return; // already reloaded recently — surface the error
  sessionStorage.setItem(KEY, String(Date.now()));
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);
