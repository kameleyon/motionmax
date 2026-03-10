/**
 * Canonical Supabase project URL for edge-function fetch calls.
 *
 * The project was migrated on 2026-03-10 to `ayjbvcikuwknqdrpsdmj`.
 * This constant is hardcoded so that ALL edge-function calls target the
 * new project even when an older production build has the previous project
 * URL baked into VITE_SUPABASE_URL.
 *
 * VITE_SUPABASE_URL is still honoured as an override for local development
 * but only if it contains the correct new project reference.
 */
const NEW_PROJECT = "ayjbvcikuwknqdrpsdmj";
const ENV_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";

export const SUPABASE_URL: string =
  ENV_URL.includes(NEW_PROJECT) ? ENV_URL : `https://${NEW_PROJECT}.supabase.co`;
