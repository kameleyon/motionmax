import { describe, it, expect } from "vitest";
import {
  normalizeSuccessResult,
  normalizeFailureError,
  isProviderPolicyRejection,
} from "./apiResultNormalize.js";

// These tests lock the GET-vs-webhook contract parity (Phase 2 B2/B4): the
// webhook `data`/`error` MUST mirror api/v1/videos/[id]/index.ts. If the GET
// handler's fallbacks or policy signatures change, these break — by design.

describe("normalizeSuccessResult — mirrors GET buildResult fallbacks", () => {
  it("prefers canonical url, then video_url, then finalUrl", () => {
    expect(normalizeSuccessResult({ url: "a", video_url: "b", finalUrl: "c" }).video_url).toBe("a");
    expect(normalizeSuccessResult({ video_url: "b", finalUrl: "c" }).video_url).toBe("b");
    expect(normalizeSuccessResult({ finalUrl: "c" }).video_url).toBe("c");
  });

  it("falls back across duration variants (duration_s → duration → durationSeconds)", () => {
    expect(normalizeSuccessResult({ duration_s: 10, duration: 20 }).duration_s).toBe(10);
    expect(normalizeSuccessResult({ duration: 20, durationSeconds: 30 }).duration_s).toBe(20);
    expect(normalizeSuccessResult({ durationSeconds: 30 }).duration_s).toBe(30);
  });

  it("falls back across thumbnail variants and reads format", () => {
    expect(normalizeSuccessResult({ thumbnail_url: "t", thumbnailUrl: "u" }).thumbnail_url).toBe("t");
    expect(normalizeSuccessResult({ thumbnailUrl: "u" }).thumbnail_url).toBe("u");
    expect(normalizeSuccessResult({ format: "16:9" }).format).toBe("16:9");
  });

  it("returns nulls (never undefined) when fields are absent, status always 'succeeded'", () => {
    const r = normalizeSuccessResult({});
    expect(r).toEqual({
      status: "succeeded",
      video_url: null,
      duration_s: null,
      thumbnail_url: null,
      format: null,
      error: null,
    });
  });

  it("ignores wrong-typed values (number url, string duration)", () => {
    const r = normalizeSuccessResult({ url: 123, duration_s: "10" } as Record<string, unknown>);
    expect(r.video_url).toBeNull();
    expect(r.duration_s).toBeNull();
  });
});

describe("normalizeFailureError — mirrors GET failed-branch normalization", () => {
  it("collapses provider content-policy rejections to a stable code + generic message", () => {
    const e = normalizeFailureError("Provider returned E005: blocked");
    expect(e.code).toBe("content_policy");
    expect(e.message).not.toMatch(/E005/); // never leak the raw provider token
  });

  it("detects the common policy phrasings", () => {
    for (const msg of [
      "E005",
      "content policy violation",
      "policy_violation",
      "safety filter triggered",
      "moderation rejected",
      "prohibited content",
      "flagged as unsafe",
    ]) {
      expect(isProviderPolicyRejection(msg)).toBe(true);
    }
  });

  it("passes through a generic failure message for non-policy errors", () => {
    const e = normalizeFailureError("ffmpeg exited with code 1");
    expect(e.code).toBe("generation_failed");
    expect(e.message).toBe("ffmpeg exited with code 1");
  });

  it("uses a default message when none is stored", () => {
    expect(normalizeFailureError(null)).toEqual({
      code: "generation_failed",
      message: "Video generation failed.",
    });
  });
});
