/**
 * Shared utility for detecting user-attached source material in content
 * payloads and producing the prompt directive that forces the LLM to
 * treat those sources as authoritative ground truth.
 *
 * Producer side: `processContentAttachments` in processAttachments.ts
 * — that's where [FETCH_URL] / [YOUTUBE_URL] / [GITHUB_URL] / [PDF_URL]
 * tags get expanded into [SOURCE FROM ...] / [PDF SOURCE: ...] /
 * [YOUTUBE SOURCE] / [GITHUB SOURCE] blocks inline in the content.
 *
 * Consumer side (this file): both `researchTopic` and the three script
 * prompt builders (buildCinematic / buildDoc2Video / buildSmartFlow)
 * call `contentHasAttachedSources` to decide whether to inject the
 * `buildSourceGroundingDirective` block into their prompts.
 *
 * Why this exists: prior to 2026-05-25 the prompts treated source
 * blocks as "additional context" / "tone & style" — soft framing that
 * let the model skim past them and write from its training data or
 * web search. Published content drifted from facts that were sitting
 * verbatim in the user's attached PDF. The directive below tells the
 * model explicitly: these are GROUND TRUTH, read them before writing,
 * the sources win over web search and training-data priors.
 */

/** Markers that signal the user attached source material. There are
 *  two producer sides that this detector has to cover:
 *
 *  1. Frontend main-input flow — `src/lib/attachmentProcessor.ts`
 *     emits the raw `[FETCH_URL]` / `[PDF_URL]` / `[YOUTUBE_URL]` /
 *     `[GITHUB_URL]` tags that the worker's
 *     `processContentAttachments` then expands into
 *     `[SOURCE FROM ...]` / `[PDF SOURCE: ...]` / `[YOUTUBE SOURCE]` /
 *     `[GITHUB SOURCE]`. Same processor leaves `[SOURCE TEXT: ...]`,
 *     `[SOURCE FILE: ...]`, `[SOURCE IMAGE]`, and `[GOOGLE_DRIVE]`
 *     untouched (no expansion needed — already inline).
 *
 *  2. Autopost flow — `handleAutopostRun.ts:buildAutopostSourcesBlock`
 *     rebuilds the SAME tag set from persisted source_attachments
 *     JSONB so generateVideo.ts:215 catches the
 *     `--- ATTACHED SOURCES ---` header and runs the same expansion.
 *
 *  When ANY of the markers below appears in content, OR when the
 *  `--- ATTACHED SOURCES ---` section header itself is present, we
 *  treat the content as carrying attached sources and inject the
 *  grounding directive. The section header is a defense-in-depth
 *  fallback so a marker we forgot to list here still triggers the
 *  directive in production. */
const SOURCE_MARKERS = [
  "[SOURCE FROM ",     // Web page fetched from [FETCH_URL]
  "[PDF SOURCE:",      // PDF text extracted from [PDF_URL]
  "[YOUTUBE SOURCE]",  // YouTube metadata from [YOUTUBE_URL]
  "[GITHUB SOURCE]",   // README from [GITHUB_URL]
  "[SOURCE IMAGE]",    // Direct image attachment (multimodal grounding)
  "[SOURCE TEXT:",     // User-pasted plain text (frontend + autopost)
  "[SOURCE FILE:",     // Inline file content (frontend + autopost)
  "[GOOGLE_DRIVE]",    // Google Drive link reference
] as const;

/** True when the content string contains either the
 *  `--- ATTACHED SOURCES ---` section header OR at least one source
 *  marker from `SOURCE_MARKERS`. Used by every prompt builder to
 *  decide whether to inject the grounding directive and raise its
 *  truncation cap. */
export function contentHasAttachedSources(content: string): boolean {
  if (!content) return false;
  // Section header is the strongest signal — emitted by BOTH the
  // frontend `processAttachments()` (returns `\n\n--- ATTACHED SOURCES ---\n…`)
  // and the autopost `buildAutopostSourcesBlock()`. Detecting on this
  // first means we still fire the directive even if a future marker
  // type is added without updating SOURCE_MARKERS.
  if (content.includes("--- ATTACHED SOURCES ---")) return true;
  return SOURCE_MARKERS.some((m) => content.includes(m));
}

/** The directive block. Designed for high-authority placement:
 *  appended to the END of the system prompt (recency bias inside the
 *  system slot) and prefixed to the user message (first thing the
 *  model reads when it starts processing the user turn). Written in
 *  the same DO / DO NOT style used elsewhere in this codebase's
 *  high-stakes prompts (see `buildDirectivePrompt` in
 *  geminiFlashTTS.ts) — that style has been the most reliable way to
 *  keep this family of models on-task. */
export function buildSourceGroundingDirective(): string {
  return `
=== ATTACHED SOURCES — AUTHORITATIVE GROUND TRUTH ===

The user has attached source materials inline below, tagged with one of:
  [SOURCE FROM <url>]    — extracted web page text
  [PDF SOURCE: <url>]    — extracted PDF text
  [YOUTUBE SOURCE]       — YouTube video metadata
  [GITHUB SOURCE]        — README text
  [SOURCE IMAGE]         — attached reference image URL
  [SOURCE TEXT: <name>]  — user-pasted plain text
  [SOURCE FILE: <name>]  — inline file content
  [GOOGLE_DRIVE] <url>   — Google Drive reference

YOU MUST:
  • READ every attached source block IN FULL before writing any output.
  • TREAT facts inside these blocks as AUTHORITATIVE GROUND TRUTH.
  • USE the exact names, dates, numbers, quotes, and details that appear
    in the sources — do not paraphrase them into approximations.
  • If web-search results, your training data, or your own prior
    assumptions CONFLICT with what an attached source says, the
    ATTACHED SOURCE WINS. Always.
  • If sources contradict each other, prefer the most-specific source
    (PDF > web page > YouTube metadata > GitHub README).

YOU MUST NOT:
  • Skim past the source blocks and write from prior knowledge.
  • Substitute a more-familiar but inaccurate version of a fact
    (common-name swaps, year drift, role/title approximations).
  • Invent details that conflict with what the sources say.
  • Treat the sources as "optional inspiration" or "background flavor."
  • Omit a fact that the user clearly attached the source to convey.
`;
}
