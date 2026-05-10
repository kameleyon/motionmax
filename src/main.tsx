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

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);
