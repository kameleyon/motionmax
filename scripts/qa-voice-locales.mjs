#!/usr/bin/env node
/**
 * qa-voice-locales.mjs
 * ─────────────────────────────────────────────────────────────────────
 * One-shot voice-locale QA generator. Renders the test paragraphs in
 * scripts/qa-test-paragraphs/<locale>.txt through whatever TTS provider
 * production routing would pick for that locale, drops the audio under
 * qa-output/voices/<locale>.mp3 (or .wav for Gemini), and emits a fresh
 * REPORT.md a native-speaker reviewer can fill in.
 *
 * Once a reviewer has marked Pass / Marginal / Fail in REPORT.md,
 * scripts/apply-voice-qa-results.mjs counts the Passes and emits a diff
 * to update the public "Voice generation in N languages" claim.
 *
 * USAGE:
 *
 *   # 1) Drop the right keys into .env.local. The script reads:
 *   #      GEMINI_API_KEY  (alias: GOOGLE_API_KEY) — Gemini Flash 2.5 TTS
 *   #      LEMONFOX_API_KEY                          — English Male (Adam)
 *   #      FISH_AUDIO_API_KEY                        — cloned voices only
 *   #      ELEVENLABS_API_KEY                        — currently unused by
 *   #                                                  the router; reserved
 *   #                                                  for --voice-override
 *   #
 *   # 2) Dry run — print what would be generated, no API calls:
 *   #    node scripts/qa-voice-locales.mjs --dry-run
 *   #
 *   # 3) Real run, all 11 locales:
 *   #    node scripts/qa-voice-locales.mjs
 *   #
 *   # 4) Subset:
 *   #    node scripts/qa-voice-locales.mjs --locales=en,fr,ht
 *   #
 *   # 5) Override the voice for one provider (e.g. test ElevenLabs Rachel
 *   #    against the same paragraphs to compare):
 *   #    node scripts/qa-voice-locales.mjs --voice-override=elevenlabs:Rachel
 *   #
 *   # 6) Custom output dir:
 *   #    node scripts/qa-voice-locales.mjs --output-dir=qa-output/voices-2026-Q2
 *
 * OUTPUTS:
 *
 *   <output-dir>/<locale>.{wav,mp3}   one audio file per locale
 *   <output-dir>/REPORT.md            review checklist (native-speaker fills in)
 *   <output-dir>/run.json             machine-readable run metadata
 *
 * SAFETY:
 *
 *   • No npm deps — Node 20 built-ins only (fetch, fs, path, child_process,
 *     crypto). Matches the dep-free style of scripts/sync-stripe-products.mjs.
 *   • Missing API keys / 401 / 403 / network errors are surfaced as warnings
 *     and the locale is reported in the REPORT's "Skipped locales" section
 *     — the script keeps going for the rest of the catalog.
 *   • Never mutates production source. The router map below is a *mirror* of
 *     worker/src/services/audioRouter.ts — re-verify when the catalog changes.
 *   • Network errors are retried once (with a 2s delay) before giving up.
 * ─────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";

// ── arg + env loading ──────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split("=")[1] : undefined;
};

const DRY_RUN = flag("--dry-run");
const OUTPUT_DIR = path.resolve(opt("--output-dir") ?? "qa-output/voices");
const LOCALES_ARG = opt("--locales");
const VOICE_OVERRIDE = opt("--voice-override"); // e.g. "elevenlabs:Rachel"

// Lightweight .env.local parser — no dotenv dep, matches sync-stripe-products.mjs.
function loadDotEnvLocal() {
  for (const candidate of [".env.local", "worker/.env.local", "worker/.env"]) {
    const p = path.resolve(candidate);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
loadDotEnvLocal();

const GEMINI_KEY =
  process.env.GEMINI_API_KEY ??
  process.env.GOOGLE_API_KEY ??
  process.env.GOOGLE_API_KEYS?.split(",")[0]?.trim();
const LEMONFOX_KEY = process.env.LEMONFOX_API_KEY;
const FISH_KEY = process.env.FISH_AUDIO_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;

// ── Routing mirror ─────────────────────────────────────────────────
// MUST stay in sync with worker/src/services/audioRouter.ts —
// re-verify when catalog changes. As of 2026-05-10 the router has
// three branches:
//   1. Any cloned voice (any language) → Fish Audio s2-pro
//   2. English + Male standard         → LemonFox (Adam)
//   3. Anything else                   → Gemini Flash 2.5 TTS (voiceName)
//
// For QA we render each locale with the **default standard female voice**
// (no clone, no English-male override), which means every locale routes
// through Gemini today. We surface the per-route info anyway so when a
// future router branches per-locale (e.g. EL for tonal langs), we just
// flip the provider/voice fields and re-run.

const GEMINI_FEMALE_VOICE = "Aoede";
const GEMINI_MALE_VOICE = "Enceladus";
const GEMINI_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * One row per supported locale. `provider` + `voice` describe what the
 * production router would pick for the **default** narration choice
 * (standard female, no clone, no English-male override).
 */
const LOCALE_CATALOG = [
  { locale: "en", language: "English",          provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "fr", language: "French",           provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "es", language: "Spanish",          provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "ht", language: "Haitian Creole",   provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "de", language: "German",           provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "it", language: "Italian",          provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "nl", language: "Dutch",            provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "ru", language: "Russian",          provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "zh", language: "Chinese (Mandarin)", provider: "gemini", voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "ja", language: "Japanese",         provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
  { locale: "ko", language: "Korean",           provider: "gemini",   voice: GEMINI_FEMALE_VOICE, model: GEMINI_MODEL },
];

// Apply --voice-override (single provider, all matching locales)
if (VOICE_OVERRIDE) {
  const [overrideProvider, overrideVoice] = VOICE_OVERRIDE.split(":");
  if (!overrideProvider || !overrideVoice) {
    console.error("FATAL: --voice-override must be 'provider:voiceId' (e.g. elevenlabs:Rachel)");
    process.exit(2);
  }
  for (const row of LOCALE_CATALOG) {
    row.provider = overrideProvider;
    row.voice = overrideVoice;
    row.model = overrideProvider === "gemini" ? GEMINI_MODEL : undefined;
  }
  console.log(`[override] All locales now route through ${overrideProvider}:${overrideVoice}`);
}

// Subset filter
const wantedLocales = LOCALES_ARG
  ? new Set(LOCALES_ARG.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const ROUTES = wantedLocales
  ? LOCALE_CATALOG.filter((r) => wantedLocales.has(r.locale))
  : LOCALE_CATALOG;

if (ROUTES.length === 0) {
  console.error(`FATAL: --locales=${LOCALES_ARG} matched zero rows in the catalog.`);
  process.exit(2);
}

// ── Provider TTS calls (built-in fetch only) ───────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ttsGemini({ text, voice, model, key }) {
  // Same shape as worker/src/services/audioProviders.ts ::generateGeminiTTS
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `[Speak with natural enthusiasm, warmth, and varied pacing. Use a conversational storytelling tone — sometimes faster with excitement, sometimes slower for emphasis. Sound like a captivating documentary narrator.] ${text}`,
          }],
        }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`Gemini ${res.status}: ${body.substring(0, 200)}`), { status: res.status });
  }
  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "OTHER") throw new Error("Gemini content filter blocked the output");
  const b64 = candidate?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) throw new Error("Gemini returned no inline audio data");
  const pcm = Buffer.from(b64, "base64");
  return { ext: "wav", bytes: pcmToWav(pcm, 24000, 1, 16) };
}

async function ttsLemonfox({ text, voice, key }) {
  const res = await fetch("https://api.lemonfox.ai/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, voice: voice ?? "river", response_format: "mp3", speed: 1.05 }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`LemonFox ${res.status}`), { status: res.status });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100) throw new Error("LemonFox returned empty audio");
  return { ext: "mp3", bytes };
}

async function ttsFish({ text, voice, key }) {
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      model: "s2-pro",
    },
    body: JSON.stringify({
      text,
      reference_id: voice, // optional — when undefined Fish picks a default
      format: "mp3",
      sample_rate: 44100,
      mp3_bitrate: 192,
      normalize: true,
      prosody: { speed: 1, normalize_loudness: true },
      temperature: 0.7,
      top_p: 0.7,
      latency: "normal",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`Fish Audio ${res.status}: ${body.substring(0, 200)}`), { status: res.status });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100) throw new Error("Fish Audio returned empty audio");
  return { ext: "mp3", bytes };
}

async function ttsElevenLabs({ text, voice, key }) {
  // voice = ElevenLabs voiceId (or named voice). The router does not normally
  // route here today — exposed only via --voice-override for comparison runs.
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.25, similarity_boost: 0.8, style: 0.75, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`ElevenLabs ${res.status}`), { status: res.status });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100) throw new Error("ElevenLabs returned empty audio");
  return { ext: "mp3", bytes };
}

// ── PCM → WAV (Gemini returns raw 24kHz mono 16-bit PCM) ───────────
// Mirror of worker/src/services/audioWavUtils.ts ::pcmToWav. Kept inline
// so this script has zero local imports / TS deps.
function pcmToWav(pcm, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// ── Run helpers ────────────────────────────────────────────────────

function tryGitHash() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return null;
  }
}

function paragraphsHash() {
  const dir = path.resolve("scripts/qa-test-paragraphs");
  if (!fs.existsSync(dir)) return "missing";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
  const hash = crypto.createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return hash.digest("hex").slice(0, 12);
}

function readParagraph(locale) {
  const p = path.resolve("scripts/qa-test-paragraphs", `${locale}.txt`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing test paragraph: ${p}`);
  }
  return fs.readFileSync(p, "utf8").trim();
}

function keyForProvider(provider) {
  switch (provider) {
    case "gemini":     return { name: "GEMINI_API_KEY (or GOOGLE_API_KEY)", value: GEMINI_KEY };
    case "lemonfox":   return { name: "LEMONFOX_API_KEY",                   value: LEMONFOX_KEY };
    case "fish":       return { name: "FISH_AUDIO_API_KEY",                 value: FISH_KEY };
    case "elevenlabs": return { name: "ELEVENLABS_API_KEY",                 value: ELEVENLABS_KEY };
    default:           return { name: `unknown:${provider}`,                value: undefined };
  }
}

async function callProvider(route, text) {
  const { provider, voice, model } = route;
  const { value: key } = keyForProvider(provider);
  if (!key) throw Object.assign(new Error(`Missing API key for provider '${provider}'`), { skipReason: "missing-key" });
  switch (provider) {
    case "gemini":     return ttsGemini({ text, voice, model: model ?? GEMINI_MODEL, key });
    case "lemonfox":   return ttsLemonfox({ text, voice, key });
    case "fish":       return ttsFish({ text, voice, key });
    case "elevenlabs": return ttsElevenLabs({ text, voice, key });
    default:           throw new Error(`Unknown provider in route: ${provider}`);
  }
}

async function runOne(route) {
  const text = readParagraph(route.locale);
  if (DRY_RUN) {
    return {
      ok: true,
      dryRun: true,
      file: `${route.locale}.${route.provider === "gemini" ? "wav" : "mp3"}`,
      bytes: 0,
    };
  }
  // One retry on network error (status 0 / undefined).
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await callProvider(route, text);
      return { ok: true, ext: out.ext, bytes: out.bytes };
    } catch (err) {
      lastErr = err;
      const status = err.status;
      // Don't retry on 401/403 (won't change), or skip-reasons.
      if (status === 401 || status === 403 || err.skipReason) break;
      if (attempt === 1) {
        console.warn(`  retry ${route.locale}/${route.provider} after error: ${err.message}`);
        await sleep(2000);
        continue;
      }
    }
  }
  return { ok: false, error: lastErr };
}

// ── REPORT.md emitter ──────────────────────────────────────────────

function buildReportMarkdown({ generatedAt, gitHash, paragraphsVersion, results }) {
  const successRows = [];
  const skippedRows = [];
  for (const r of results) {
    if (r.success) successRows.push(r);
    else skippedRows.push(r);
  }

  const tableRows = LOCALE_CATALOG
    .filter((row) => results.some((r) => r.locale === row.locale))
    .map((row) => {
      const r = results.find((x) => x.locale === row.locale);
      const fileLink = r?.success ? `[${row.locale}.${r.ext}](${row.locale}.${r.ext})` : "_(skipped)_";
      return `| ${row.locale} | ${row.language} | ${fileLink} | ${row.provider} | ${row.voice} | _Pass / Fail / Marginal_ | — | — |`;
    })
    .join("\n");

  const skippedSection = skippedRows.length === 0
    ? "_(none — every requested locale generated successfully)_"
    : skippedRows.map((r) => `- **${r.locale}** (${r.language}): \`${r.error}\``).join("\n");

  return `# Voice Locale QA Report

**Generated:** ${generatedAt}
**Source routing:** worker/src/services/audioRouter.ts${gitHash ? ` (commit ${gitHash})` : ""}
**Test paragraph version:** ${paragraphsVersion}

## Review checklist

For each row, listen to the MP3 (or WAV) with a native or fluent speaker. Mark **Pass / Fail / Marginal** in the Status column. Add a one-line note explaining your reasoning.

| Locale | Language | File | Provider | Voice ID | Status | Reviewer | Notes |
|---|---|---|---|---|---|---|---|
${tableRows}

## Scoring criteria

- **Pass** — Native speaker would say "sounds like a human reading from a script". Minor accent OK; no mispronunciations.
- **Marginal** — Recognizable as the language, but stiff/robotic OR has noticeable errors. Keep in product, don't include in public count.
- **Fail** — Mispronunciations, wrong tones, gibberish, or output that defaults to English. Should be flagged for provider follow-up.

## Skipped locales

${skippedSection}

## Next step

Once every row above has a Pass / Fail / Marginal in the Status column, run:

\`\`\`
node scripts/apply-voice-qa-results.mjs
\`\`\`

That script counts the **Pass** rows, then emits a unified diff updating the public claim ("Multilingual voiceover") to "Voice generation in N languages" across landingContent.ts, LandingPricing.tsx, pricingPlans.ts, and marketing/.../index.astro. Add \`--apply\` to write the diff after a human eyeballs it.
`;
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
  const generatedAt = new Date().toISOString();
  const gitHash = tryGitHash();
  const paragraphsVersion = paragraphsHash();

  console.log(`[qa-voice-locales] generated=${generatedAt}`);
  console.log(`[qa-voice-locales] paragraphs-hash=${paragraphsVersion}`);
  console.log(`[qa-voice-locales] git=${gitHash ?? "(no git)"}  dry-run=${DRY_RUN}`);
  console.log(`[qa-voice-locales] output-dir=${OUTPUT_DIR}`);
  console.log(`[qa-voice-locales] locales=${ROUTES.map((r) => r.locale).join(",")}`);

  if (!DRY_RUN) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const results = [];
  for (const route of ROUTES) {
    const tag = `${route.locale}/${route.provider}:${route.voice}`;
    process.stdout.write(`  → ${tag} ... `);
    const r = await runOne(route);
    if (r.ok && r.dryRun) {
      console.log(`would write ${r.file}`);
      results.push({ locale: route.locale, language: route.language, success: true, ext: r.file.split(".").pop() });
      continue;
    }
    if (r.ok) {
      const filePath = path.join(OUTPUT_DIR, `${route.locale}.${r.ext}`);
      fs.writeFileSync(filePath, r.bytes);
      console.log(`OK (${r.bytes.length.toLocaleString()} bytes → ${path.basename(filePath)})`);
      results.push({ locale: route.locale, language: route.language, success: true, ext: r.ext });
    } else {
      const reason = r.error?.message ?? "unknown error";
      console.warn(`SKIP (${reason})`);
      results.push({ locale: route.locale, language: route.language, success: false, error: reason });
    }
  }

  // REPORT.md
  const reportPath = path.join(OUTPUT_DIR, "REPORT.md");
  if (DRY_RUN) {
    console.log(`\n[dry-run] would write ${reportPath}`);
  } else {
    fs.writeFileSync(reportPath, buildReportMarkdown({ generatedAt, gitHash, paragraphsVersion, results }));
    console.log(`\nWrote ${reportPath}`);
  }

  // run.json (machine-readable)
  const runJsonPath = path.join(OUTPUT_DIR, "run.json");
  const runJson = {
    generatedAt, gitHash, paragraphsVersion, dryRun: DRY_RUN,
    output: OUTPUT_DIR, voiceOverride: VOICE_OVERRIDE ?? null,
    results,
  };
  if (!DRY_RUN) {
    fs.writeFileSync(runJsonPath, JSON.stringify(runJson, null, 2));
    console.log(`Wrote ${runJsonPath}`);
  }

  const ok = results.filter((r) => r.success).length;
  const skipped = results.length - ok;
  console.log(`\nDone. ${ok}/${results.length} locales rendered, ${skipped} skipped.`);
  if (!DRY_RUN && ok > 0) {
    console.log(`Next: open ${reportPath}, listen to each file with a native speaker, fill in Pass/Fail/Marginal.`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
