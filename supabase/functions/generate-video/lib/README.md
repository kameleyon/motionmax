# `generate-video/lib`

Internal modules carved out of `supabase/functions/generate-video/index.ts`
as part of audit C-4-2 (Arch C-A3, "5,530-line god-file refactor"), round 1
on 2026-05-10.

The Edge Function still deploys as a single bundle via
`supabase functions deploy generate-video`. Supabase's deployer walks the
function directory and bundles `index.ts` plus every relative import,
including this `lib/` tree — there is no separate build step.

## Why

`index.ts` had grown to 5,530 lines covering input validation, content
moderation, LLM fallback, six TTS providers, two image providers, the
chunk-and-stitch audio pipeline, every phase handler, and the HTTP entry
point. The audit flagged this as the single largest file in the repo and
the primary obstacle to onboarding new backend contributors.

This first round extracts the **safest, most self-contained** sub-systems
— the ones whose I/O surface is a pure function with no closure over
module-level mutable state and no hidden dependence on per-request
variables like `corsHeaders`. Round 2 will tackle the more entangled
pieces (TTS providers, image providers, phase handlers).

## What lives here

| File              | Purpose                                                                                                     | Original lines in `index.ts` |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `types.ts`        | Shared TS interfaces: `GenerationRequest`, `Scene`, `ScriptResponse`, `CostTracking`.                       | 313–391                      |
| `validation.ts`   | Input validators, DOMPurify sanitisation, Gemini-based content moderation, user-flagging, `CONTENT_COMPLIANCE_INSTRUCTION`. | 10–311                       |
| `llm.ts`          | OpenRouter primary + Gemini-Flash fallback wrapper, robust JSON extractor, `PRIMARY_LLM_MODEL` / `FALLBACK_MODEL` constants. | 410–706                      |
| `logging.ts`      | `api_call_logs` and `system_logs` sinks (`logApiCall`, `logSystemEvent`, `logApiCallToSystem`).             | 708–832                      |
| `audioCodec.ts`   | PCM/WAV codec, chunk-and-stitch engine, voiceover sanitisers, Haitian Creole detector, single-chunk Chatterbox call. | 1034–1342, 1679–1710         |

## Still inline in `index.ts` (round 2 candidates)

Each of these is a viable extraction but was deferred because it touches
either closure state, the inner `corsHeaders` binding, or a tightly
coupled fallback chain. Pick them off one at a time, with a behavioural
diff every time, exactly as round 1 did.

- **TTS providers** — `generateSceneAudioFishAudio`, `generateSceneAudioLemonfox`,
  `generateSceneAudioReplicateChunked`, `generateSceneAudioGeminiWithModel`,
  `generateSceneAudioGemini`, `generateSceneAudioOpenRouter`,
  `generateSceneAudioElevenLabs`, `transformAudioWithElevenLabsSTS`,
  `generateSceneAudioReplicate`, and the unified `generateSceneAudio` router.
  Suggested home: `lib/narration.ts` (+ one file per provider, or a single
  `lib/tts/*.ts` directory).
- **Image providers** — `generateImageWithHypereal`,
  `generateCharacterReferenceWithHypereal`, `generateImageWithReplicate`,
  `editImageWithReplicatePro`. Suggested home: `lib/imageGen.ts`.
- **Phase handlers** — `handleSmartFlowScriptPhase`, `handleScriptPhase`,
  `handleAudioPhase`, `handleImagesPhase`, `handleFinalizePhase`,
  `handleRegenerateAudio`, `handleRegenerateImage`. These currently read
  `corsHeaders` from the enclosing `handler()` scope; extracting them
  requires plumbing CORS headers (or an env-derived helper) through every
  handler signature. The script-phase handlers are also dead code today
  (see `SCRIPT_PHASE_DEPRECATED` guard) — they can probably be deleted
  entirely once the worker migration is confirmed stable.
- **Retry classifier / progress tracker / final assembler** — these
  don't currently exist as discrete units in the file. Retry logic is
  inlined per-provider (per-call exponential backoff with `sleep` and a
  status-code switch). Progress tracking is interleaved with the phase
  handlers (`supabase.from("generations").update({ progress, scenes... })`).
  Final assembly (FFmpeg concat, watermark, XMP) has moved to the Render
  worker — there is no FFmpeg logic in this edge function anymore. So
  these three audit-listed "candidates" are either non-existent or
  out-of-scope for the edge function in its current form. Flag for round
  2 strategy discussion before attempting.

## Contract for adding a new module

1. **Single responsibility.** One file = one cohesive sub-system. If the
   functions inside need to share private helpers, fine; if they share
   private state, you have a different problem to solve first.
2. **No closure over `index.ts` scope.** Functions must take every input
   as an explicit parameter — including `supabase`, `userId`,
   `generationId`, `projectId`, `corsHeaders`, env-derived keys, etc.
   The `lib/` tree must compile with `index.ts` deleted.
3. **No top-level mutable state.** Module-level `const` (constants,
   regexes, arrays of static strings) is fine. Module-level `let` is
   forbidden — that's a footgun for the Edge runtime's per-invocation
   instance model and breaks the audit guarantee that the refactor is
   structural-only.
4. **Preserve every log call, Sentry breadcrumb, and DB write verbatim.**
   The audit treats observability output as part of the public contract.
   If you genuinely want to change a log line, that's a separate change
   with its own diff.
5. **Document the contract at the top of the file.** A JSDoc-style block
   listing each exported function with one sentence describing its
   purpose, plus any module-level constants worth knowing about. See
   `audioCodec.ts` for the canonical template.
6. **Import from `./lib/foo.ts`, not `lib/foo.ts` or `./foo.ts`.** The
   `./lib/` prefix is what Supabase's deployer uses to resolve siblings;
   stick to it for grep-ability.
7. **TypeScript types live in `types.ts`.** Add new shared interfaces
   there. Provider-specific types (e.g. raw response shapes for a single
   API) can stay private inside the module that owns them.

## Verification step (every extraction)

```bash
deno check supabase/functions/generate-video/lib/<your-new-file>.ts
deno check supabase/functions/generate-video/index.ts
```

The second command will still report the pre-existing `@types/node`
phantom error from `https://esm.sh/v135/@types/node@20.11.20/events.d.ts`
— that's a Deno + esm.sh interop issue, not a real type problem, and it
exists on `main` independently of this refactor. As long as the error
output is identical before and after your change, you're fine.

Do **not** deploy as part of an extraction PR. Deploys go through the
normal release process after a green CI run.
