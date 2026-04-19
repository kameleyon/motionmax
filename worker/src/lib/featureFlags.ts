/**
 * Feature-flag helper for runtime provider kill-switches.
 *
 * Resolution order (highest → lowest priority):
 *   1. Env var  FLAG_<UPPERCASE_FLAG_NAME>=true|false
 *   2. DB row   public.feature_flags.enabled
 *   3. Default  true (fail-open; missing flag = feature active)
 *
 * Flags are cached in-process for CACHE_TTL_MS to avoid a DB round-trip
 * on every job. Call `invalidateFeatureFlags()` to force a fresh fetch.
 */

import { supabase } from "./supabase.js";
import { wlog } from "./workerLogger.js";

const CACHE_TTL_MS = 60_000; // 1 minute

interface FlagCache {
  flags: Record<string, boolean>;
  fetchedAt: number;
}

let cache: FlagCache | null = null;

async function loadFlags(): Promise<Record<string, boolean>> {
  const { data, error } = await supabase
    .from("feature_flags")
    .select("flag_name, enabled");

  if (error) {
    wlog.warn("feature_flags fetch failed, using defaults", { error: error.message });
    return {};
  }

  const map: Record<string, boolean> = {};
  for (const row of data ?? []) {
    map[row.flag_name as string] = row.enabled as boolean;
  }
  return map;
}

async function getFlags(): Promise<Record<string, boolean>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.flags;
  }
  const flags = await loadFlags();
  cache = { flags, fetchedAt: now };
  return flags;
}

/** Force next call to `isEnabled` to re-fetch from DB. */
export function invalidateFeatureFlags(): void {
  cache = null;
}

/**
 * Returns true if the named feature flag is enabled.
 *
 * @param flagName - DB flag_name, e.g. "ai_video_generation"
 * @param defaultValue - value when flag is absent from both env and DB (default: true)
 */
export async function isEnabled(flagName: string, defaultValue = true): Promise<boolean> {
  // Env var override: FLAG_AI_VIDEO_GENERATION=true|false
  const envKey = `FLAG_${flagName.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    return envVal.toLowerCase() !== "false" && envVal !== "0";
  }

  const flags = await getFlags();
  return flagName in flags ? flags[flagName] : defaultValue;
}
