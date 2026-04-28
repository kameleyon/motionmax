/**
 * Manual kill-switch drill helper. NOT a unit test.
 *
 * Usage (from repo root, after `cd worker && npm run build`):
 *   node worker/dist/handlers/autopost/__killSwitchTest.js
 *
 * What it does:
 *   1. Reads current value of `app_settings.autopost_enabled`
 *   2. Forces it to `false`, prints state
 *   3. Waits 10s — long enough for the dispatcher's 5s tick to read the
 *      flag at least once and quiesce
 *   4. Restores `autopost_enabled` to `true` (or to its prior value)
 *   5. Prints the final state
 *
 * The point: confirm before a soft launch that flipping the switch
 * actually causes in-flight ticks to bounce out. The dispatcher's
 * tick() reads autopost_enabled at the very top, before any other
 * DB query, so a value of false should produce zero downstream
 * activity within ~5s.
 *
 * This file is named with a `__` prefix so the regular handler
 * `index.ts` re-export does not pick it up.
 */

import { supabase } from "../../lib/supabase.js";

const SETTING_KEY = "autopost_enabled";

async function readEnabled(): Promise<unknown> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();
  if (error) throw new Error(`read failed: ${error.message}`);
  return (data as { value?: unknown } | null)?.value;
}

async function writeEnabled(v: boolean): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: SETTING_KEY, value: v }, { onConflict: "key" });
  if (error) throw new Error(`write failed: ${error.message}`);
}

async function main(): Promise<void> {
  const initial = await readEnabled();
  console.log(`[killSwitchTest] initial value: ${JSON.stringify(initial)}`);

  console.log(`[killSwitchTest] flipping autopost_enabled = false ...`);
  await writeEnabled(false);
  console.log(`[killSwitchTest] now: ${JSON.stringify(await readEnabled())}`);

  const waitMs = 10_000;
  console.log(`[killSwitchTest] waiting ${waitMs / 1000}s — dispatcher tick is 5s, so it should read the flag at least twice`);
  await new Promise((r) => setTimeout(r, waitMs));

  // Restore to true. If the operator wants to leave it off, they can
  // edit this script — leaving the system off is the riskier default
  // for an automated drill helper.
  console.log(`[killSwitchTest] restoring autopost_enabled = true ...`);
  await writeEnabled(true);
  console.log(`[killSwitchTest] final value: ${JSON.stringify(await readEnabled())}`);
  console.log(`[killSwitchTest] done.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[killSwitchTest] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
