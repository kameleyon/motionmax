/**
 * Tests for the dedup helpers in handleGenerateTopics.
 *
 * The full handler hits Gemini + OpenRouter + Supabase logging, so it
 * isn't a clean unit test target. The pure helpers — `extractSubject`,
 * `normalizeSubject`, and `dedupeCandidates` — ARE the part the user's
 * complaint is about ("AI keeps proposing the same topic differently
 * written"), so they get the focused coverage instead.
 *
 * What's covered:
 *  - Subject extraction across the prompt-enforced separator styles
 *    (colon, em-dash with spaces, en-dash, plain hyphen with spaces)
 *  - Subject normalisation collapses casing + punctuation
 *  - Subject-based dedup catches "same subject, different angle" (the
 *    cardology failure mode that triggered this work)
 *  - It does NOT catch "different subjects, same template" — the case
 *    a pure word-similarity heuristic would false-positive on
 *  - Legacy string-only candidates fall back to extracted subjects
 *  - In-batch dedup catches the model proposing two same-subject
 *    titles in one response
 *  - Empty / blank candidates are silently skipped
 *  - The target count is respected
 *  - Non-Latin scripts compare correctly via the normaliser
 */

import { describe, it, expect } from "vitest";
import {
  dedupeCandidates,
  extractSubject,
  normalizeSubject,
  type TopicCandidate,
} from "./handleGenerateTopics.js";

describe("extractSubject", () => {
  it("returns the prefix before a colon", () => {
    expect(extractSubject("Queen of Clubs: How to win")).toBe("Queen of Clubs");
  });

  it("returns the prefix before an em-dash with spaces", () => {
    expect(extractSubject("Queen of Clubs — A path to power")).toBe("Queen of Clubs");
  });

  it("returns the prefix before an en-dash with spaces", () => {
    expect(extractSubject("Queen of Clubs – energy explained")).toBe("Queen of Clubs");
  });

  it("returns the prefix before a hyphen with spaces", () => {
    expect(extractSubject("Queen of Clubs - reversed meaning")).toBe("Queen of Clubs");
  });

  it("does NOT split on a hyphenated subject (no spaces around the dash)", () => {
    expect(extractSubject("Sub-zero: the coldest take")).toBe("Sub-zero");
  });

  it("falls back to the full title when no separator is present", () => {
    expect(extractSubject("Queen of Clubs reversed")).toBe("Queen of Clubs reversed");
  });

  it("trims surrounding whitespace", () => {
    expect(extractSubject("   Queen of Clubs : How to win   ")).toBe("Queen of Clubs");
  });
});

describe("normalizeSubject", () => {
  it("lowercases", () => {
    expect(normalizeSubject("Queen of Clubs")).toBe("queen of clubs");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(normalizeSubject("Queen — of -- Clubs!")).toBe("queen of clubs");
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeSubject("   ")).toBe("");
  });

  it("works on non-Latin scripts (Japanese)", () => {
    // Same subject phrase shown two different ways — the normaliser
    // should collapse both to the same key after stripping the spaces
    // and the colon.
    expect(normalizeSubject("クイーン・オブ・クラブ")).toBe(
      normalizeSubject("クイーン オブ クラブ"),
    );
  });
});

function obj(title: string, subject: string): TopicCandidate {
  return { title, subject };
}

describe("dedupeCandidates", () => {
  it("keeps all when no subjects collide", () => {
    const out = dedupeCandidates(
      [
        obj("Ace of Spades: Wins it all", "Ace of Spades"),
        obj("King of Hearts: Loves power", "King of Hearts"),
        obj("10 of Diamonds: Always shines", "10 of Diamonds"),
      ],
      [],
      5,
    );
    expect(out.kept.map((c) => c.title)).toEqual([
      "Ace of Spades: Wins it all",
      "King of Hearts: Loves power",
      "10 of Diamonds: Always shines",
    ]);
    expect(out.droppedCount).toBe(0);
  });

  it("drops candidates whose subject matches an existing pool entry", () => {
    // Existing pool: plain strings (the queue / skipped_topics arrive
    // without an explicit subject field). Subjects derived via
    // extractSubject.
    const out = dedupeCandidates(
      [
        obj("Queen of Clubs: A path to power", "Queen of Clubs"),
        obj("Queen of Clubs: Why she always wins", "Queen of Clubs"),
        obj("King of Diamonds: Read minds fast", "King of Diamonds"),
        obj("5 of Hearts: Heal everything", "5 of Hearts"),
      ],
      ["Queen of Clubs: How to win"],
      5,
    );
    expect(out.kept.map((c) => c.title)).toEqual([
      "King of Diamonds: Read minds fast",
      "5 of Hearts: Heal everything",
    ]);
    expect(out.droppedCount).toBe(2);
  });

  it("does NOT drop candidates that share template tokens with different subjects", () => {
    // The false-positive case word-set comparison would catch: same
    // "How to learn ___" template, but the subjects (Python, Java,
    // Rust) are all different. Subject-based dedup correctly accepts
    // all three.
    const out = dedupeCandidates(
      [
        obj("How to learn Python in 30 days", "Python"),
        obj("How to learn Java in 30 days", "Java"),
        obj("How to learn Rust in 30 days", "Rust"),
      ],
      ["How to learn Go in 30 days"],
      5,
    );
    expect(out.kept).toHaveLength(3);
    expect(out.droppedCount).toBe(0);
  });

  it("drops in-batch duplicates the model proposed in one call", () => {
    const out = dedupeCandidates(
      [
        obj("Queen of Clubs: How to win", "Queen of Clubs"),
        obj("Queen of Clubs: A path to victory", "Queen of Clubs"),
        obj("Jack of Spades: The trickster's gambit", "Jack of Spades"),
      ],
      [],
      5,
    );
    expect(out.kept.map((c) => c.title)).toEqual([
      "Queen of Clubs: How to win",
      "Jack of Spades: The trickster's gambit",
    ]);
    expect(out.droppedCount).toBe(1);
  });

  it("treats case + punctuation differences as the same subject", () => {
    const out = dedupeCandidates(
      [
        obj("queen of clubs: a different take", "queen of clubs"),
        obj("QUEEN OF CLUBS — reversed", "QUEEN OF CLUBS"),
      ],
      ["Queen of Clubs: How to win"],
      5,
    );
    expect(out.kept).toEqual([]);
    expect(out.droppedCount).toBe(2);
  });

  it("respects the target count even when more survivors exist", () => {
    const out = dedupeCandidates(
      [
        obj("Ace of Spades wins all", "Ace of Spades"),
        obj("King of Hearts loves power", "King of Hearts"),
        obj("10 of Diamonds shines", "10 of Diamonds"),
        obj("Jack of Clubs deceives", "Jack of Clubs"),
      ],
      [],
      2,
    );
    expect(out.kept).toHaveLength(2);
  });

  it("filters out empty / whitespace-only titles", () => {
    const out = dedupeCandidates(
      [
        obj("", ""),
        obj("   ", ""),
        obj("Ace of Spades wins all", "Ace of Spades"),
        obj("  King of Hearts loves power  ", "King of Hearts"),
      ],
      [],
      5,
    );
    expect(out.kept.map((c) => c.title)).toEqual([
      "Ace of Spades wins all",
      "King of Hearts loves power",
    ]);
    expect(out.droppedCount).toBe(0);
  });

  it("handles a totally exhausted candidate list without throwing", () => {
    // Every candidate's subject matches the existing pool — empty
    // output is correct; the caller decides how to render a short
    // return.
    const out = dedupeCandidates(
      [
        obj("Queen of Clubs: A different angle", "Queen of Clubs"),
        obj("Queen of Clubs reversed", "Queen of Clubs"),
        obj("Queen of Clubs energy explained", "Queen of Clubs"),
      ],
      ["Queen of Clubs: How to win"],
      5,
    );
    expect(out.kept).toEqual([]);
    expect(out.droppedCount).toBe(3);
  });

  it("derives subject from the title when the model omits the subject field", () => {
    // Older / fallback shape: subject string is empty, so we extract
    // it from the title prefix. Behaviour should match the explicit-
    // subject case above.
    const out = dedupeCandidates(
      [
        obj("Queen of Clubs: A path to power", ""),
        obj("King of Diamonds: Read minds fast", ""),
      ],
      ["Queen of Clubs: How to win"],
      5,
    );
    expect(out.kept.map((c) => c.title)).toEqual([
      "King of Diamonds: Read minds fast",
    ]);
    expect(out.droppedCount).toBe(1);
  });
});
