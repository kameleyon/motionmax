/**
 * Provider rate card — single source of truth for per-call cost computation
 * in the worker. Used by writeApiLog call sites to attribute real USD spend
 * to each api_call_logs row so we can compute $/active-user, $/generated-
 * video, $/audit-call and run abuse forensics on outsized callers.
 *
 * All rates are USD. Values reflect the public pricing pages at time of
 * authoring (May 2026). Update here when a provider's contract changes —
 * everything else reads from this file.
 *
 * Cost-by-usage helpers below take raw usage counters (tokens, chars,
 * seconds, calls) and return cost in *USD cents* (integer-safe storage
 * in api_call_logs.cost which is NUMERIC). Sub-cent calls round to 0;
 * the totals roll up correctly because we keep the floating cents in
 * the NUMERIC column itself (no integer truncation).
 *
 * History: pre-fix, every writeApiLog call passed `cost: 0`, making
 * $/* unit-economics dashboards unbuildable. Reconstructed rates from
 * provider pricing pages and our own contracts so the numbers we ship
 * today are honest, not aspirational. (C-8-5 / C-9-7)
 */

export const PROVIDER_RATES_USD = {
  // ── LLMs ──────────────────────────────────────────────────────────
  openai_gpt4o: {
    input_per_1k: 0.0025,
    output_per_1k: 0.01,
  },
  openrouter_claude_sonnet: {
    input_per_1k: 0.003,
    output_per_1k: 0.015,
  },
  // Hypereal's Gemini 3.1 Fast — primary explainer/doc2video script LLM
  hypereal_gemini_fast: {
    input_per_1k: 0.00080,
    output_per_1k: 0.00320,
  },
  // Google native Gemini 3.1 Pro Preview — used by researchTopic
  // (web-grounded research brief). Priced per Google's public sheet.
  google_gemini_pro_preview: {
    input_per_1k: 0.00125,
    output_per_1k: 0.005,
  },

  // ── TTS ───────────────────────────────────────────────────────────
  gemini_flash_tts: {
    // Gemini 3.1 Flash native TTS billed at ~$0.001 per output second of
    // synthesized audio. We track per_second so callers can pass
    // durationSeconds directly.
    per_minute: 0.001,
    per_second: 0.001 / 60,
  },
  elevenlabs_tts: {
    per_1k_chars: 0.18,
  },
  fish_audio_tts: {
    per_1k_chars: 0.10,
  },
  lemonfox_tts: {
    per_1k_chars: 0.08,
  },
  smallest_ai_tts: {
    per_1k_chars: 0.20,
  },
  // Qwen3 TTS via Replicate (currently disabled in code, kept for legacy
  // logs and the off chance we re-enable). Replicate billing model is
  // per-second of synthesized audio.
  qwen3_tts: {
    per_second: 0.001,
  },
  // Google Cloud TTS (only used today for Haitian Creole because Gemini
  // Flash doesn't support that locale). Pricing per second of synthesized
  // audio at Standard voice tier.
  google_cloud_tts: {
    per_second: 0.004,
  },

  // ── ASR ───────────────────────────────────────────────────────────
  hypereal_asr: {
    // audio-asr endpoint billed at $0.01 / minute of audio transcribed.
    per_minute: 0.01,
  },

  // ── Image generation ──────────────────────────────────────────────
  hypereal_image: {
    per_image: 0.04,
  },
  // GPT-Image-2 routed through Hypereal — premium image surface used
  // for storyboard cards. Priced higher than the default Hypereal image.
  hypereal_gpt_image2: {
    per_image: 0.08,
  },
  // Nano-Banana Pro edit (img-to-img) via Hypereal — cheaper than gpt-
  // image2 because we don't pay for first-frame synthesis.
  hypereal_nano_banana_pro: {
    per_image: 0.03,
  },
  replicate_image: {
    per_image: 0.05,
  },

  // ── Video generation ──────────────────────────────────────────────
  // Kling V2.6 Pro I2V via Hypereal — 5s clips at this price; longer
  // clips scale linearly. Pricing matches the export-side estimator
  // in handleFinalize so dashboards reconcile.
  hypereal_video_kling: {
    per_video_5s: 0.20,
    per_video_10s: 0.40,
  },
  hypereal_video_ltx: {
    per_video_5s: 0.15,
  },
  // Replicate-hosted ByteDance Seedance 2.0 Fast — primary cinematic
  // video provider as of 2026-05-13. Billed per output-second, no queue
  // premium. Migrated off Hypereal-hosted Seedance after a 10s scene
  // billed at 281 credits (~$0.28/sec, ~2× the listed rate). Replicate
  // hosts the same ByteDance model at the public sheet price.
  //   - 480p I2V: $0.07/sec output
  //   - 720p I2V: $0.15/sec output
  replicate_seedance_2_0_fast: {
    per_second_480p: 0.07,
    per_second_720p: 0.15,
  },
} as const;

export type ProviderRateKey = keyof typeof PROVIDER_RATES_USD;

/** Compute cost in USD (float) for an LLM call given input + output token counts. */
export function llmCostUsd(
  rateKey: "openai_gpt4o" | "openrouter_claude_sonnet" | "hypereal_gemini_fast" | "google_gemini_pro_preview",
  inputTokens: number,
  outputTokens: number,
): number {
  const r = PROVIDER_RATES_USD[rateKey];
  return (inputTokens / 1000) * r.input_per_1k + (outputTokens / 1000) * r.output_per_1k;
}

/** Compute cost for a character-billed TTS provider. */
export function ttsCharsCostUsd(
  rateKey: "elevenlabs_tts" | "fish_audio_tts" | "lemonfox_tts" | "smallest_ai_tts",
  chars: number,
): number {
  return (chars / 1000) * PROVIDER_RATES_USD[rateKey].per_1k_chars;
}

/** Compute cost for a second-billed TTS provider. */
export function ttsSecondsCostUsd(
  rateKey: "gemini_flash_tts" | "qwen3_tts" | "google_cloud_tts",
  seconds: number,
): number {
  const r = PROVIDER_RATES_USD[rateKey];
  if ("per_second" in r) return seconds * r.per_second;
  return 0;
}

/** Compute cost for ASR by audio minutes. */
export function asrMinutesCostUsd(minutes: number): number {
  return minutes * PROVIDER_RATES_USD.hypereal_asr.per_minute;
}

/** Compute cost for an image generation call (default 1 image). */
export function imageCostUsd(
  rateKey: "hypereal_image" | "hypereal_gpt_image2" | "hypereal_nano_banana_pro" | "replicate_image",
  images = 1,
): number {
  return images * PROVIDER_RATES_USD[rateKey].per_image;
}

/** Compute cost for a video clip generation call. */
export function videoCostUsd(
  rateKey: "hypereal_video_kling" | "hypereal_video_ltx",
  durationSeconds: number,
): number {
  const r = PROVIDER_RATES_USD[rateKey];
  // Kling lists per-5s pricing; for longer clips we bill in 5-second blocks
  // and apply the listed 10-second rate when applicable.
  if (rateKey === "hypereal_video_kling" && durationSeconds > 7) {
    return PROVIDER_RATES_USD.hypereal_video_kling.per_video_10s
      * Math.max(1, Math.ceil(durationSeconds / 10));
  }
  return r.per_video_5s * Math.max(1, Math.ceil(durationSeconds / 5));
}

/** Compute cost for a Replicate-hosted Seedance 2.0 Fast clip. Billed per
 *  output-second; rate depends on resolution. */
export function replicateSeedanceCostUsd(
  resolution: "480p" | "720p",
  outputSeconds: number,
): number {
  const r = PROVIDER_RATES_USD.replicate_seedance_2_0_fast;
  const perSec = resolution === "720p" ? r.per_second_720p : r.per_second_480p;
  return Math.max(0, outputSeconds * perSec);
}

/** Round a USD float to USD cents (integer-ish, but we store as NUMERIC so we keep precision). */
export function toUsdCents(usd: number): number {
  return Math.round(usd * 100);
}
