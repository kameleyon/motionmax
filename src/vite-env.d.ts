/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_APP_URL: string;
  readonly VITE_SENTRY_DSN: string;
  readonly VITE_SENTRY_RELEASE: string;
  readonly VITE_GA_MEASUREMENT_ID: string;
  readonly VITE_WORKER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
