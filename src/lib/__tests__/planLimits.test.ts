/// <reference types="vitest/globals" />
import {
  PLAN_LIMITS,
  getCreditsRequired,
  getMultiplier,
  getEstimatedSeconds,
  validateGenerationAccess,
} from "../planLimits";

// -----------------------------------------------
// getCreditsRequired (per-second model)
// -----------------------------------------------
describe("getCreditsRequired", () => {
  it("returns 150 credits for short standard video (150s x 1x)", () => {
    expect(getCreditsRequired("doc2video", "short")).toBe(150);
    expect(getCreditsRequired("storytelling", "short")).toBe(150);
  });

  it("returns 280 credits for brief standard video (280s x 1x)", () => {
    expect(getCreditsRequired("doc2video", "brief")).toBe(280);
  });

  it("returns 360 credits for presentation (360s x 1x)", () => {
    expect(getCreditsRequired("storytelling", "presentation")).toBe(360);
  });

  it("returns 75 credits for short smartflow (150s x 0.5x)", () => {
    expect(getCreditsRequired("smartflow", "short")).toBe(75);
  });

  it("returns 750 credits for short cinematic (150s x 5x)", () => {
    expect(getCreditsRequired("cinematic", "short")).toBe(750);
  });

  it("returns 1400 credits for brief cinematic (280s x 5x)", () => {
    expect(getCreditsRequired("cinematic", "brief")).toBe(1400);
  });
});

// -----------------------------------------------
// PLAN_LIMITS structure
// -----------------------------------------------
describe("PLAN_LIMITS", () => {
  it("free plan has 0 monthly credits", () => {
    expect(PLAN_LIMITS.free.creditsPerMonth).toBe(0);
  });

  it("creator plan has 500 monthly + 60 daily", () => {
    expect(PLAN_LIMITS.creator.creditsPerMonth).toBe(500);
    expect(PLAN_LIMITS.creator.dailyFreeCredits).toBe(60);
  });

  it("studio plan has 2500 monthly + 150 daily", () => {
    expect(PLAN_LIMITS.studio.creditsPerMonth).toBe(2500);
    expect(PLAN_LIMITS.studio.dailyFreeCredits).toBe(150);
  });

  it("free plan allows only landscape", () => {
    expect(PLAN_LIMITS.free.allowedFormats).toEqual(["landscape"]);
  });

  it("creator allows landscape + portrait", () => {
    expect(PLAN_LIMITS.creator.allowedFormats).toContain("portrait");
  });

  it("free plan has watermark", () => {
    expect(PLAN_LIMITS.free.watermark).toBe(true);
  });

  it("creator has no watermark", () => {
    expect(PLAN_LIMITS.creator.watermark).toBe(false);
  });

  it("only studio has brand kit", () => {
    expect(PLAN_LIMITS.free.allowBrandMark).toBe(false);
    expect(PLAN_LIMITS.creator.allowBrandMark).toBe(false);
    expect(PLAN_LIMITS.studio.allowBrandMark).toBe(true);
  });

  it("only studio has character consistency", () => {
    expect(PLAN_LIMITS.creator.allowCharacterConsistency).toBe(false);
    expect(PLAN_LIMITS.studio.allowCharacterConsistency).toBe(true);
  });

  it("only studio has priority rendering", () => {
    expect(PLAN_LIMITS.creator.priorityRendering).toBe(false);
    expect(PLAN_LIMITS.studio.priorityRendering).toBe(true);
  });
});

// -----------------------------------------------
// Multipliers and seconds
// -----------------------------------------------
describe("getMultiplier", () => {
  it("standard products are 1x", () => {
    expect(getMultiplier("doc2video")).toBe(1);
    expect(getMultiplier("storytelling")).toBe(1);
  });

  it("smartflow is 0.5x", () => {
    expect(getMultiplier("smartflow")).toBe(0.5);
  });

  it("cinematic is 5x", () => {
    expect(getMultiplier("cinematic")).toBe(5);
  });
});

describe("getEstimatedSeconds", () => {
  it("short is 150 seconds", () => {
    expect(getEstimatedSeconds("short")).toBe(150);
  });

  it("brief is 280 seconds", () => {
    expect(getEstimatedSeconds("brief")).toBe(280);
  });
});

// -----------------------------------------------
// validateGenerationAccess
// -----------------------------------------------
describe("validateGenerationAccess", () => {
  it("blocks when credits insufficient", () => {
    const r = validateGenerationAccess("creator", 100, "doc2video", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("Insufficient");
  });

  it("allows when credits sufficient", () => {
    const r = validateGenerationAccess("creator", 200, "doc2video", "short", "landscape");
    expect(r.canGenerate).toBe(true);
  });

  it("blocks free plan from portrait format", () => {
    const r = validateGenerationAccess("free", 1000, "doc2video", "short", "portrait");
    expect(r.canGenerate).toBe(false);
  });

  it("blocks brand mark on creator plan", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", true);
    expect(r.canGenerate).toBe(false);
    expect(r.requiredPlan).toBe("studio");
  });

  it("allows brand mark on studio plan", () => {
    const r = validateGenerationAccess("studio", 3000, "doc2video", "short", "landscape", true);
    expect(r.canGenerate).toBe(true);
  });

  it("blocks past_due subscriptions", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "past_due");
    expect(r.canGenerate).toBe(false);
  });

  it("shows multiplier in error message", () => {
    const r = validateGenerationAccess("creator", 100, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("5x");
  });
});
