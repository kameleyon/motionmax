# QA Test Paragraphs — Design Rationale

These 11 paragraphs are the test inputs for `scripts/qa-voice-locales.mjs`.
Each one is roughly 60–90 seconds when narrated at a normal pace, written in
plain prose (not poetry, not idiomatic), so a native-speaker reviewer can
focus on **whether the TTS pronounces the language correctly** rather than
arguing about literary style.

Every paragraph contains, at minimum:

- the brand name **motionmax** (we want to know how each provider says it
  in-language — does it stay "motion-max" or get mangled?)
- the numbers 1–10 spelled out, so cardinal-number pronunciation is audible
- a question mark, period, and comma, to exercise prosody / sentence-end
  intonation
- common verbs and prepositions (no obscure vocabulary)
- a **per-language phonetic challenge** — the single hardest sound for that
  language's TTS to get right. If a provider can survive these, it can
  survive most production scripts.

The challenges, one per locale:

| Locale | Phonetic challenge | Why it matters |
|---|---|---|
| en | TH sounds (voiced + voiceless) — "These three thoughtful theses" | Every TTS engine struggles with /θ/ and /ð/; if it slurs or substitutes /s/ or /f/ the model is sub-par. |
| fr | Nasal vowels + liaison — "En un instant" | Distinct nasal /ɛ̃/, /ɑ̃/, /ɔ̃/ and liaison ("les invités") are the canonical French pronunciation tells. |
| es | Trilled R + ñ — "El perro corre rápido en la mañana" | A flat (English) R immediately marks an inauthentic Spanish voice. ñ confirms the model has a real ES voice, not just ES letters in an EN voice. |
| ht | Contractions + glottal — "M ap ekri yon istwa" | Verifies the model treats Haitian Creole as its own language, not French. The "M ap" contraction is unmistakably HC. |
| de | Umlauts + CH — "Über fünf Mädchen" | Ü, Ö, Ä and the back/front CH (ach-laut vs ich-laut) catch models that fall back to a generic European voice. |
| it | Double consonants (geminates) — "Bello, quattro, ferro" | Italian geminates change meaning ("nonno" vs "nono"). A model that doesn't hold doubled consonants longer is wrong. |
| nl | G + IJ — "De gulden brug" | The hard G /ɣ/ ~ /x/ and the IJ diphthong are the two sounds non-native TTS engines reliably flatten. |
| ru | Trilled R + soft sign — "Дорогой друг, я" | Trilled R + palatalisation (ь / soft consonants) — the two markers of a real Russian voice vs an English voice reading Cyrillic. |
| zh | Tones (mā, má, mǎ, mà) — "妈妈骑着马" | Mandarin without correct tones is unintelligible. The classic "mama riding a horse" sentence forces all four tones in five syllables. |
| ja | Long vowels + mora — "東京の桜を見に" | Long-vowel distinctions (おう vs お) and mora-timing are what separate a real Japanese voice from a phonetic spell-out. |
| ko | Aspirated + batchim — "한국어를 배우고" | Aspirated stops (ㅋ ㅌ ㅍ ㅊ) and final-consonant (batchim) realisation are where most TTS gets exposed. |

## How reviewers should use them

1. Listen to the rendered MP3 once at normal speed.
2. Score in `qa-output/voices/REPORT.md` — Pass / Marginal / Fail (criteria
   are in the report itself).
3. Add a one-line note. Specific is better than vague: "RR sounds like English R" beats "sounds bad".

## Maintaining

Test paragraphs are **repo content**, not generated output — they belong in
git so the QA pass is reproducible. The corresponding MP3s land under
`qa-output/voices/` which is gitignored.

Re-run the generator and re-score whenever:

- A new locale is added to `worker/src/services/audioRouter.ts`
- A locale is moved to a different provider
- A provider is upgraded to a new model (e.g. Gemini Flash 2.5 → Flash 3)

Last reviewed: 2026-05-10.
