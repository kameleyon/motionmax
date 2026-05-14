/**
 * Provider key startup banner — logs every external API key the worker
 * can use, with a masked preview so deploy logs surface missing/empty
 * keys before they fail a generation 5 minutes in. Extracted from
 * worker/src/index.ts on 2026-05-10 (per audit C-4-3). No exits on
 * missing keys — some are optional and only certain task types need
 * them. Just warns so the gap is loud.
 */

/**
 * Mask an API key for safe logging.
 * Only reveals total length and last 4 chars; never prints leading
 * characters to avoid accidental partial-key exposure in log
 * aggregation services.
 */
function maskKey(key: string | undefined): string {
  if (!key) return "(NOT SET)";
  const trimmed = key.trim();
  if (trimmed.length === 0) return "(EMPTY)";
  if (trimmed !== key) return `⚠️ HAS WHITESPACE — len=${trimmed.length} (trimmed)`;
  const tail = trimmed.length > 4 ? trimmed.substring(trimmed.length - 4) : "****";
  return `[SET, ${trimmed.length} chars, …${tail}]`;
}

const PROVIDER_KEYS: Array<[string, string, 'required' | 'optional']> = [
  ['HYPEREAL_API_KEY',      'Hypereal account A (image, ASR, music, LLM)', 'required'],
  ['HYPEREALIMAGE_API_KEY', 'Hypereal account B (video — Seedance/Kling/Grok/Veo + image fallback)', 'required'],
  ['REPLICATE_API_KEY',     'Replicate (fallback image, audio)',   'required'],
  ['OPENROUTER_API_KEY',   'OpenRouter (LLM script)',             'required'],
  ['ELEVENLABS_API_KEY',   'ElevenLabs TTS',                      'optional'],
  ['SMALLEST_API_KEY',     'Smallest.ai TTS',                     'optional'],
  ['GEMINI_API_KEY',       'Gemini Flash TTS',                    'optional'],
  ['LYRIA_API_KEY',        'Lyria music generation',              'optional'],
  ['LTX_API_KEY',          'LTX video',                           'optional'],
  ['QWEN3_API_KEY',        'Qwen3 TTS',                           'optional'],
  ['FISH_AUDIO_API_KEY',   'Fish Audio TTS',                      'optional'],
  ['LEMONFOX_API_KEY',     'Lemonfox TTS',                        'optional'],
];

export function logProviderKeysBanner(): void {
  let missingRequired = 0;
  console.log(`[Worker] ── Provider key check ────────────────────────`);
  for (const [envName, label, requirement] of PROVIDER_KEYS) {
    const key = process.env[envName];
    const status = key ? `🔑 ${maskKey(key)}` : (requirement === 'required' ? '❌ MISSING (required)' : '○ not set (optional)');
    if (!key && requirement === 'required') missingRequired++;
    console.log(`[Worker]   ${envName.padEnd(22)} ${label.padEnd(40)} ${status}`);
  }
  console.log(`[Worker] ──────────────────────────────────────────────`);
  if (missingRequired > 0) {
    console.warn(`[Worker] ⚠ ${missingRequired} REQUIRED provider key(s) missing — generations will fail until these are set.`);
  }
}
