// Deno unit tests for audioEngine.ts — pure text-processing and WAV utilities.
import { assertEquals, assertMatch, assert } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  sanitizeVoiceover,
  sanitizeForGeminiTTS,
  isHaitianCreole,
  pcmToWav,
} from "./audioEngine.ts";

// ─── sanitizeVoiceover ────────────────────────────────────────────────────────

Deno.test("sanitizeVoiceover: passes clean text through unchanged", () => {
  assertEquals(sanitizeVoiceover("Hello world."), "Hello world.");
});

Deno.test("sanitizeVoiceover: strips markdown bold/italic markers", () => {
  assertEquals(sanitizeVoiceover("**Bold** and _italic_ text"), "Bold and italic text");
});

Deno.test("sanitizeVoiceover: strips scene label prefixes", () => {
  assertEquals(sanitizeVoiceover("Scene 1: This is the content."), "This is the content.");
  assertEquals(sanitizeVoiceover("Hook: Grab attention here."), "Grab attention here.");
  assertEquals(sanitizeVoiceover("Narrator: The story begins."), "The story begins.");
});

Deno.test("sanitizeVoiceover: strips leading bracket tags from lines", () => {
  assertEquals(sanitizeVoiceover("[intro] Welcome to the show."), "Welcome to the show.");
});

Deno.test("sanitizeVoiceover: preserves allowed paralinguistic tags", () => {
  const result = sanitizeVoiceover("And then [sigh] she walked away.");
  assertMatch(result, /\[sigh\]/);
});

Deno.test("sanitizeVoiceover: removes unknown bracket tags", () => {
  const result = sanitizeVoiceover("This is [unknown-tag] removed.");
  assert(!result.includes("[unknown-tag]"), "Unknown tags should be stripped");
});

Deno.test("sanitizeVoiceover: joins multi-line text into single line", () => {
  const result = sanitizeVoiceover("Line one.\nLine two.\nLine three.");
  assert(!result.includes("\n"), "Output should have no newlines");
  assertMatch(result, /Line one\. Line two\. Line three\./);
});

Deno.test("sanitizeVoiceover: collapses multiple spaces", () => {
  assertEquals(sanitizeVoiceover("Too   many    spaces"), "Too many spaces");
});

Deno.test("sanitizeVoiceover: handles non-string input gracefully", () => {
  assertEquals(sanitizeVoiceover(null), "");
  assertEquals(sanitizeVoiceover(undefined), "");
  assertEquals(sanitizeVoiceover(42), "");
});

// ─── sanitizeForGeminiTTS ─────────────────────────────────────────────────────

Deno.test("sanitizeForGeminiTTS: adds trailing period when missing", () => {
  const result = sanitizeForGeminiTTS("This sentence has no period");
  assertMatch(result, /\.$/);
});

Deno.test("sanitizeForGeminiTTS: does not double-add period when already present", () => {
  const result = sanitizeForGeminiTTS("Already has a period.");
  assert(!result.endsWith(".."), "Should not have double period");
});

Deno.test("sanitizeForGeminiTTS: removes special chars that trigger content filters", () => {
  const result = sanitizeForGeminiTTS("Text with <angle> & brackets {curly}.");
  assert(!result.includes("<"), "Should strip angle bracket open");
  assert(!result.includes(">"), "Should strip angle bracket close");
  assert(!result.includes("{"), "Should strip curly brace open");
  assert(!result.includes("}"), "Should strip curly brace close");
});

Deno.test("sanitizeForGeminiTTS: preserves allowed paralinguistic tags through sanitization", () => {
  const result = sanitizeForGeminiTTS("She paused [sigh] and continued.");
  assertMatch(result, /\[sigh\]/);
});

Deno.test("sanitizeForGeminiTTS: strips disallowed bracket tags", () => {
  const result = sanitizeForGeminiTTS("The [REDACTED] content was gone.");
  assert(!result.includes("[REDACTED]"), "Non-allowed tags should be stripped");
});

Deno.test("sanitizeForGeminiTTS: handles empty string", () => {
  assertEquals(sanitizeForGeminiTTS(""), "");
});

// ─── isHaitianCreole ──────────────────────────────────────────────────────────

Deno.test("isHaitianCreole: identifies Haitian Creole text with 3+ indicators", () => {
  // "mwen", "ou", "li" are indicators
  assert(isHaitianCreole("Mwen renmen ou anpil, li konnen sa."));
});

Deno.test("isHaitianCreole: returns false for plain English", () => {
  assert(!isHaitianCreole("The quick brown fox jumps over the lazy dog."));
});

Deno.test("isHaitianCreole: returns false for text with fewer than 3 indicators", () => {
  // Only 2 matches — "mwen" and "ou" — not enough
  assert(!isHaitianCreole("Mwen ou bonsoir le monde."));
});

Deno.test("isHaitianCreole: recognizes explicit Creole identifier word", () => {
  assert(isHaitianCreole("Nou pale kreyol ayiti chak jou."));
});

Deno.test("isHaitianCreole: handles empty string", () => {
  assert(!isHaitianCreole(""));
});

// ─── pcmToWav ─────────────────────────────────────────────────────────────────

Deno.test("pcmToWav: output starts with RIFF/WAVE header", () => {
  const pcm = new Uint8Array(1000);
  const wav = pcmToWav(pcm);

  const dec = new TextDecoder();
  assertEquals(dec.decode(wav.slice(0, 4)), "RIFF");
  assertEquals(dec.decode(wav.slice(8, 12)), "WAVE");
  assertEquals(dec.decode(wav.slice(12, 16)), "fmt ");
  assertEquals(dec.decode(wav.slice(36, 40)), "data");
});

Deno.test("pcmToWav: output length equals header(44) + pcm length", () => {
  const pcm = new Uint8Array(800);
  const wav = pcmToWav(pcm);
  assertEquals(wav.length, 44 + 800);
});

Deno.test("pcmToWav: encodes sample rate correctly in header", () => {
  const pcm = new Uint8Array(100);
  const sampleRate = 16000;
  const wav = pcmToWav(pcm, sampleRate);

  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(24, true), sampleRate);
});

Deno.test("pcmToWav: handles empty PCM data", () => {
  const wav = pcmToWav(new Uint8Array(0));
  assertEquals(wav.length, 44); // header only
});
