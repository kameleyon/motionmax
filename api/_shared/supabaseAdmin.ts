/**
 * Server-side Supabase client with service-role privileges.
 *
 * NEVER import this from anything that compiles into the browser bundle.
 * It is meant exclusively for Vercel Functions in `api/` which run on
 * Node.js (Fluid Compute) and have access to `process.env`.
 *
 * Reads:
 *   - SUPABASE_URL              (server-only; the React app uses VITE_SUPABASE_URL)
 *   - SUPABASE_SERVICE_ROLE_KEY (server-only; bypasses RLS)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      'createAdminClient: SUPABASE_URL env var is not set. ' +
        'Add it to Vercel project settings (Production + Preview).'
    );
  }
  if (!key) {
    throw new Error(
      'createAdminClient: SUPABASE_SERVICE_ROLE_KEY env var is not set. ' +
        'Add it to Vercel project settings (Production + Preview, encrypted).'
    );
  }

  cached = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-connection-pooler': 'supavisor' },
    },
  });

  return cached;
}
