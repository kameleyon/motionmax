import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { initSentry } from "@/lib/sentry";
import { captureUtmParams } from "@/hooks/useAnalytics";
import App from "./App.tsx";
import "./index.css";

// Initialise Sentry before rendering so it captures any bootstrap errors
initSentry();
// Persist UTM params before the SPA replaces the URL
captureUtmParams();

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <App />
  </HelmetProvider>,
);
