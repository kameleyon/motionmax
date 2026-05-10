/**
 * Cipher S-002 / Shield S-001 stopgap — JWT storage adapter.
 *
 * The Supabase client used to persist its session in `localStorage`. That
 * means the JWT survives a tab close AND is readable by any script that
 * runs in the page (XSS = full account takeover with stored Stripe payment
 * methods).
 *
 * We can't move the JWT into an httpOnly cookie without an SSR layer — the
 * MotionMax web app is a Vite SPA served as static files from `dist/` (no
 * Next.js / Astro SSR / Remix server). `@supabase/ssr` cookies set client-
 * side from JS are still readable by JS, so they buy nothing over
 * localStorage.
 *
 * Therefore this adapter:
 *   1. Stores the Supabase auth token in `sessionStorage` instead of
 *      `localStorage`. sessionStorage is per-tab and CLEARS on tab close,
 *      bounding the post-XSS exposure window.
 *   2. Migrates any pre-existing token from localStorage on first read,
 *      so users currently signed in are NOT logged out by the deploy.
 *      The localStorage copy is then deleted.
 *   3. Implements the synchronous `Storage`-shaped contract that
 *      supabase-js expects (getItem / setItem / removeItem).
 *
 * Combined with the strict CSP shipped in vercel.json (no inline script,
 * no unauthorized origins), the residual XSS-→-account-takeover risk is
 * acceptable as a stopgap until we add an SSR layer.
 *
 * TODO (C-6-6 follow-up): once an SSR layer exists (Astro adapter for the
 * marketing site is NOT enough — we need SSR on the /app routes), migrate
 * to `@supabase/ssr` with `createServerClient` + `createBrowserClient` and
 * httpOnly Secure SameSite=Lax cookies set server-side. At that point the
 * JWT becomes unreachable to JS entirely.
 */

const KEY_PREFIX = "sb-"; // supabase-js key prefix — avoid touching unrelated keys.

/**
 * SessionStorage-backed adapter. Falls back to an in-memory map when neither
 * sessionStorage nor localStorage exists (SSR / tests / private mode quirks).
 */
class JwtSessionStorage {
  private memory = new Map<string, string>();

  private get sessionAvailable(): boolean {
    try {
      return typeof window !== "undefined" && !!window.sessionStorage;
    } catch {
      return false;
    }
  }

  private get localAvailable(): boolean {
    try {
      return typeof window !== "undefined" && !!window.localStorage;
    } catch {
      return false;
    }
  }

  /**
   * On first read for a given key, if there is a value still sitting in
   * localStorage from a previous deploy, copy it into sessionStorage and
   * delete the localStorage entry so the user does not get bounced to
   * sign-in. Idempotent: future calls just hit sessionStorage directly.
   */
  private migrateFromLocalStorage(key: string): void {
    if (!key.startsWith(KEY_PREFIX)) return;
    if (!this.sessionAvailable || !this.localAvailable) return;
    try {
      // Already migrated? sessionStorage wins.
      if (window.sessionStorage.getItem(key) !== null) return;
      const legacy = window.localStorage.getItem(key);
      if (legacy !== null) {
        window.sessionStorage.setItem(key, legacy);
        window.localStorage.removeItem(key);
      }
    } catch {
      // Quota / private mode — fall through to whatever is available.
    }
  }

  getItem(key: string): string | null {
    this.migrateFromLocalStorage(key);
    if (this.sessionAvailable) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        // fall through
      }
    }
    return this.memory.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.sessionAvailable) {
      try {
        window.sessionStorage.setItem(key, value);
        // Belt-and-suspenders: stamp out any straggling localStorage copy
        // so two windows of the same browser don't disagree about identity.
        if (key.startsWith(KEY_PREFIX) && this.localAvailable) {
          try { window.localStorage.removeItem(key); } catch { /* ignore */ }
        }
        return;
      } catch {
        // fall through
      }
    }
    this.memory.set(key, value);
  }

  removeItem(key: string): void {
    if (this.sessionAvailable) {
      try { window.sessionStorage.removeItem(key); } catch { /* ignore */ }
    }
    if (key.startsWith(KEY_PREFIX) && this.localAvailable) {
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    }
    this.memory.delete(key);
  }
}

export const jwtSessionStorage = new JwtSessionStorage();
