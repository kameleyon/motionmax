/**
 * Resolves the Supabase project URL in order of reliability:
 *   1. supabase.supabaseUrl  — reads from the already-configured client (has hardcoded new-project fallback)
 *   2. VITE_SUPABASE_URL    — baked-in env var (may be stale if the app was built before migration)
 *   3. hardcoded fallback   — target project URL, always correct
 *
 * Using the client's own URL avoids the "wrong project" problem when the env
 * var was baked into a production build before the Supabase migration.
 */
import { supabase } from "@/integrations/supabase/client";

export const SUPABASE_URL: string =
  (supabase as unknown as { supabaseUrl: string }).supabaseUrl
  ?? import.meta.env.VITE_SUPABASE_URL
  ?? "https://ayjbvcikuwknqdrpsdmj.supabase.co";
