/**
 * Tests for the constant-time string compare used by the health server's
 * Bearer-token auth. Closes Cipher §6 C-6-8 (timing-oracle on
 * HEALTH_AUTH_TOKEN).
 *
 * What we actually verify:
 *   1. Equal strings compare equal.
 *   2. Different strings of the same length compare unequal.
 *   3. Strings of different lengths compare unequal WITHOUT throwing
 *      (the previous `crypto.timingSafeEqual` direct call would throw on
 *      length mismatch — `safeEq` must paper over that).
 *   4. Edge cases: empty strings, single-byte differences at start vs end.
 *
 * We intentionally do NOT try to measure wall-clock timing here. Microbench
 * timing variance on Node makes that test flaky and the property we care
 * about — "no early-exit on first differing byte" — is guaranteed by
 * `crypto.timingSafeEqual` itself; we just need to confirm `safeEq` routes
 * through it for all input shapes.
 */

import { describe, it, expect } from "vitest";
import { safeEq } from "./healthServer.js";

describe("safeEq (constant-time compare for HEALTH_AUTH_TOKEN)", () => {
  it("returns true for identical non-empty strings", () => {
    const token = "9f8e7d6c5b4a39281706a5b4c3d2e1f0";
    expect(safeEq(token, token)).toBe(true);
  });

  it("returns true for identical empty strings", () => {
    expect(safeEq("", "")).toBe(true);
  });

  it("returns false for same-length strings with a single-byte difference", () => {
    const a = "9f8e7d6c5b4a39281706a5b4c3d2e1f0";
    const b = "9f8e7d6c5b4a39281706a5b4c3d2e1f1"; // last byte differs
    expect(safeEq(a, b)).toBe(false);
  });

  it("returns false for same-length strings differing at the first byte", () => {
    const a = "Af8e7d6c5b4a39281706a5b4c3d2e1f0";
    const b = "Bf8e7d6c5b4a39281706a5b4c3d2e1f0"; // first byte differs
    expect(safeEq(a, b)).toBe(false);
  });

  it("returns false WITHOUT throwing when lengths differ (provided shorter)", () => {
    const expected = "9f8e7d6c5b4a39281706a5b4c3d2e1f0";
    const provided = "9f8e7d6c5b4a39281706"; // truncated
    expect(() => safeEq(provided, expected)).not.toThrow();
    expect(safeEq(provided, expected)).toBe(false);
  });

  it("returns false WITHOUT throwing when lengths differ (provided longer)", () => {
    const expected = "short";
    const provided = "shortandthensome";
    expect(() => safeEq(provided, expected)).not.toThrow();
    expect(safeEq(provided, expected)).toBe(false);
  });

  it("handles unicode without throwing (utf8 byte-length basis)", () => {
    // "café" is 5 utf8 bytes; "cafe" is 4. They must compare unequal and
    // not throw because the buffer cast normalises both sides.
    expect(safeEq("café", "cafe")).toBe(false);
    expect(safeEq("café", "café")).toBe(true);
  });

  it("rejects an attacker-supplied empty token", () => {
    const expected = "9f8e7d6c5b4a39281706a5b4c3d2e1f0";
    expect(safeEq("", expected)).toBe(false);
  });
});
