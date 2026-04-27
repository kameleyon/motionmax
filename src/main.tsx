import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { initSentry } from "@/lib/sentry";
import { captureUtmParams } from "@/hooks/useAnalytics";
import { registerServiceWorkerWithUpdates } from "@/lib/swUpdate";
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

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);
