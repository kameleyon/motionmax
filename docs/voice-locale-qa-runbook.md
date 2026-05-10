# Voice Locale QA Runbook

A one-time-per-quarter pipeline for backing the public "Voice generation in
N languages" claim with native-speaker evidence, instead of vague language
("Multilingual voiceover") that doesn't survive a regulatory question.

This runbook lives next to the scripts in `scripts/qa-voice-locales.mjs`
and `scripts/apply-voice-qa-results.mjs` — see those for implementation
detail. This file is the human-facing how-to.

---

## Why we do this

US FTC Act §5 prohibits "deceptive acts or practices" — meaning specific
marketing claims must be substantiated. The EU's Unfair Commercial
Practices Directive (Art. 6) requires the same for any EU customer.

Saying "Voice generation in **11 languages**" without QA-evidence is a
borderline §5 / UCPD Art. 6 risk if any one of those 11 actually produces
gibberish on a real phrase. Saying "**Multilingual voiceover**" is safe
but uninformative — and unhelpfully vague when prospects compare us to
products that quote a number.

This pipeline closes that gap: we only publish a number we can defend
with audio + reviewer notes on file.

---

## Catalog at a glance (verify before each run)

| Locale | Language | Production provider (default standard female) |
|---|---|---|
| en | English          | Gemini Flash 2.5 TTS (Aoede) |
| fr | French           | Gemini Flash 2.5 TTS (Aoede) |
| es | Spanish          | Gemini Flash 2.5 TTS (Aoede) |
| ht | Haitian Creole   | Gemini Flash 2.5 TTS (Aoede) |
| de | German           | Gemini Flash 2.5 TTS (Aoede) |
| it | Italian          | Gemini Flash 2.5 TTS (Aoede) |
| nl | Dutch            | Gemini Flash 2.5 TTS (Aoede) |
| ru | Russian          | Gemini Flash 2.5 TTS (Aoede) |
| zh | Chinese (Mandarin) | Gemini Flash 2.5 TTS (Aoede) |
| ja | Japanese         | Gemini Flash 2.5 TTS (Aoede) |
| ko | Korean           | Gemini Flash 2.5 TTS (Aoede) |

Source of truth: `worker/src/services/audioRouter.ts`. The QA generator
duplicates this map at the top of `scripts/qa-voice-locales.mjs` with a
"MUST stay in sync" comment — re-read the router before each quarterly
run and bump the script if anything has changed.

> Note: clones (any language) route to Fish Audio s2-pro and English-male
> standard routes to LemonFox (Adam). The QA pipeline tests the
> **default standard female** narration, which is the path 99% of free
> users land on. Clone QA is a separate workflow per voice.

---

## Step-by-step

### 0. Prerequisites (one-time per machine)

- Node 20+ (the script uses built-in `fetch` + `Buffer`)
- `.env.local` with at least `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`).
  Add `LEMONFOX_API_KEY`, `FISH_AUDIO_API_KEY`, and/or `ELEVENLABS_API_KEY`
  only if you want to run those specific providers (e.g. via
  `--voice-override=elevenlabs:Rachel`).
- A way to play MP3 / WAV (any browser, VLC, Windows Media Player, etc.)
- A native-speaker reviewer per locale (see "Finding reviewers" below)

### 1. Generate audio

```sh
# Dry run — confirm catalog and routing are as you expect:
node scripts/qa-voice-locales.mjs --dry-run

# Real run, all 11 locales:
node scripts/qa-voice-locales.mjs
```

Outputs:

- `qa-output/voices/<locale>.{wav|mp3}` — one per locale
- `qa-output/voices/REPORT.md` — review checklist, ready to fill in
- `qa-output/voices/run.json` — machine-readable run metadata

If a locale's API key is missing or the provider returns 401/403, the
script keeps going and lists that locale in the **Skipped locales**
section of REPORT.md.

### 2. Review with native speakers

Open `qa-output/voices/REPORT.md`. For each row:

1. Listen to the file once at normal speed.
2. Use the scoring rubric in the report:
   - **Pass** — sounds like a human reading from a script; minor accent OK
   - **Marginal** — recognisable as the language but stiff / has errors
   - **Fail** — mispronunciations, wrong tones, gibberish, or defaulted to English
3. Replace `_Pass / Fail / Marginal_` in the Status column with one of those words.
4. Put the reviewer's name in Reviewer.
5. Add a one-line note. Specific is better than vague — "RR sounds like English R" beats "sounds bad".

Reviewers don't need to be linguists. They need to be **native or
fluent speakers** willing to say "yes that sounds right" or "no, X is
mispronounced". Five minutes per locale. Eleven locales = under an hour
of total review time.

### 3. Apply the result to public-facing copy

```sh
# Dry-run: print the diff to stdout
node scripts/apply-voice-qa-results.mjs

# When you've eyeballed the diff and it looks correct:
node scripts/apply-voice-qa-results.mjs --apply
```

The apply step:

- Counts rows where Status === Pass → produces N
- Rewrites these files:
  - `src/config/landingContent.ts`
  - `src/components/landing/LandingPricing.tsx`
  - `src/config/pricingPlans.ts`
  - `marketing/src/pages/index.astro`
- Public claim becomes `Voice generation in ${N} languages`
- Trust badge becomes `Voice in ${N} languages`

If a target file no longer contains the expected source string (because
someone has touched the copy since this runbook was written), the apply
script aborts with a clear message — it never silently leaves the
codebase half-updated.

If any locale scored **Fail**, also run:

```sh
node scripts/apply-voice-qa-results.mjs --list-failed
```

This emits a comment block to paste above the `languages` array in
`src/components/workspace/LanguageSelector.tsx`, listing which locales
to comment out (it does NOT auto-edit). Decide per-locale whether to
hide entirely, or label as beta.

### 4. Commit

```
git add scripts/qa-test-paragraphs/ docs/voice-locale-qa-runbook.md
git add src/config/landingContent.ts src/config/pricingPlans.ts \
        src/components/landing/LandingPricing.tsx \
        marketing/src/pages/index.astro
git commit -m "docs(voice): publish QA-backed N-language claim"
```

The audio outputs themselves (`qa-output/`) are gitignored — they're
big, regeneratable, and not source.

---

## Finding native-speaker reviewers

In rough order of cost / turnaround:

1. **Internal team** — Slack #general, ask "anyone speak X natively?"
   Free, fast, but limited to the languages our team knows.
2. **Friends / family of internal team** — same speed, expand coverage.
   Pay $5–$10 by Venmo/PayPal as a thank-you, no contract needed.
3. **Fiverr** — search "[language] voice over review" or "[language]
   pronunciation check". $10–$25 per locale, 24-hour turnaround typical.
4. **Upwork** — better for ongoing relationships, $20–$50 per hour.
   Worth it once we publish enough languages that someone needs to
   re-check on every catalog change.
5. **Local university language department** — for under-represented
   languages (Haitian Creole, etc). Often free for a 5-minute listen,
   especially if framed as feedback to a startup.

For the first run, internal team + Fiverr usually clears 11 locales in
2–3 days for under $200 total.

---

## Re-audit cadence

- **Quarterly** — full re-run. Providers update their TTS models more
  often than they tell us. A voice that passed last quarter may sound
  different this quarter.
- **On catalog change** — when `worker/src/services/audioRouter.ts`
  adds, removes, or re-routes a locale.
- **On provider model upgrade** — when we move from Gemini Flash 2.5
  to a newer model, redo the run.
- **On user complaint** — if support gets an "X language sounds wrong"
  ticket twice in a quarter, do an out-of-cycle audit for that locale
  and the others on the same provider.

Document each run by keeping the corresponding `REPORT.md` archived in
the team drive (the audio under `qa-output/` is regeneratable; the
filled-in REPORT is the evidence we need to keep on file).

---

## Legal reference (for the "why bother" file)

- US FTC Act §5 — prohibits "unfair or deceptive acts or practices in
  or affecting commerce". Specific marketing claims (numbers, percent-
  ages, comparison statements) must be substantiable.
- EU UCPD Art. 6 — a commercial practice is misleading if it contains
  false information or otherwise deceives the average consumer in
  relation to material characteristics of the product (which includes
  feature claims like "X languages").
- Saying "11 languages" without an evidence file → if any one of them
  is meaningfully broken, that's a §5 / Art. 6 exposure. Saying
  "Multilingual voiceover" is safe but doesn't help conversion.
- Saying "Voice generation in N languages" with the QA evidence on
  file (this pipeline) → both safe **and** specific.

---

## Files

- `scripts/qa-voice-locales.mjs` — generator
- `scripts/apply-voice-qa-results.mjs` — apply (dry-run by default)
- `scripts/qa-test-paragraphs/<locale>.txt` — tracked, repo content
- `scripts/qa-test-paragraphs/README.md` — design rationale per paragraph
- `qa-output/` — gitignored; regenerated each run
- `docs/voice-locale-qa-runbook.md` — this file
