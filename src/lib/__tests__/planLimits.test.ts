/// <reference types="vitest/globals" />
import {
  PLAN_LIMITS,
  CREDIT_COSTS,
  getCreditsRequired,
  validateGenerationAccess,
} from "../planLimits";

// ───────────────────────────────────────────────
// getCreditsRequired
// ───────────────────────────────────────────────
describe("getCreditsRequired", () => {
  it("returns 1 credit for short videos", () => {
    expect(getCreditsRequired("doc2video", "short")).toBe(1);
    expect(getCreditsRequired("storytelling", "short")).toBe(1);
  });

  it("returns 2 credits for brief videos", () => {
    expect(getCreditsRequired("doc2video", "brief")).toBe(2);
  });

  it("returns 4 credits for presentation videos", () => {
    expect(getCreditsRequired("storytelling", "presentation")).toBe(4);
  });

  it("returns 1 credit for smartflow (infographic)", () => {
    expect(getCreditsRequired("smartflow", "short")).toBe(1);
    expect(getCreditsRequired("smartflow", "anything")).toBe(1);
  });

  it("returns 12 credits for cinematic", () => {
    expect(getCreditsRequired("cinematic", "brief")).toBe(12);
  });

  it("throws on invalid video length", () => {
    expect(() => getCreditsRequired("doc2video", "invalid-length")).toThrow(
      'Invalid video length "invalid-length"'
    );
  });
});

// ───────────────────────────────────────────────
// PLAN_LIMITS structure
// ───────────────────────────────────────────────
describe("PLAN_LIMITS", () => {
  it("free plan has 10 credits", () => {
    expect(PLAN_LIMITS.free.creditsPerMonth).toBe(10);
  });

  it("free plan allows only landscape and square", () => {
    expect(PLAN_LIMITS.free.allowedFormats).toEqual(["landscape", "square"]);
  });

  it("free plan disallows portrait format", () => {
    expect(PLAN_LIMITS.free.allowedFormats).not.toContain("portrait");
  });

  it("starter plan allows portrait format", () => {
    expect(PLAN_LIMITS.starter.allowedFormats).toContain("portrait");
  });

  it("creator plan allows brand mark", () => {
    expect(PLAN_LIMITS.creator.allowBrandMark).toBe(true);
  });

  it("free plan disallows brand mark", () => {
    expect(PLAN_LIMITS.free.allowBrandMark).toBe(false);
  });

  it("free plan disallows custom styles", () => {
    expect(PLAN_LIMITS.free.allowCustomStyle).toBe(false);
  });

  it("professional plan allows voice cloning", () => {
    expect(PLAN_LIMITS.professional.allowVoiceCloning).toBe(true);
  });
});

// ───────────────────────────────────────────────
// validateGenerationAccess
// ───────────────────────────────────────────────
describe("validateGenerationAccess", () => {
  it("allows generation when plan, credits, format, length are valid", () => {
    const result = validateGenerationAccess("starter", 30, "doc2video", "short", "landscape");
    expect(result.canGenerate).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("blocks free users from portrait format", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "short", "portrait");
    expect(result.canGenerate).toBe(false);
    expect(result.upgradeRequired).toBe(true);
    expect(result.requiredPlan).toBe("starter");
  });

  it("blocks generation when credits are insufficient", () => {
    const result = validateGenerationAccess("starter", 0, "doc2video", "short", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("Insufficient credits");
  });

  it("blocks free users from brief length", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "brief", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.upgradeRequired).toBe(true);
  });

  it("blocks free users from presentation length", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "presentation", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.upgradeRequired).toBe(true);
    expect(result.requiredPlan).toBe("creator");
  });

  it("blocks brand mark on free plan", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "short", "landscape", true);
    expect(result.canGenerate).toBe(false);
    expect(result.requiredPlan).toBe("creator");
  });

  it("allows brand mark on creator plan", () => {
    const result = validateGenerationAccess("creator", 100, "doc2video", "short", "landscape", true);
    expect(result.canGenerate).toBe(true);
  });

  it("blocks custom style on starter plan", () => {
    const result = validateGenerationAccess("starter", 30, "doc2video", "short", "landscape", false, true);
    expect(result.canGenerate).toBe(false);
    expect(result.requiredPlan).toBe("creator");
  });

  it("blocks smartflow infographics on free plan", () => {
    const result = validateGenerationAccess("free", 10, "smartflow", "short", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.requiredPlan).toBe("starter");
  });

  it("allows smartflow on starter plan", () => {
    const result = validateGenerationAccess("starter", 30, "smartflow", "short", "landscape");
    expect(result.canGenerate).toBe(true);
  });

  it("blocks generation with past_due subscription", () => {
    const result = validateGenerationAccess(
      "creator", 100, "doc2video", "short", "landscape",
      false, false, "past_due"
    );
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("overdue");
  });

  it("blocks generation with canceled non-free subscription", () => {
    const result = validateGenerationAccess(
      "creator", 100, "doc2video", "short", "landscape",
      false, false, "canceled"
    );
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("canceled");
  });

  it("handles enterprise plan with full access", () => {
    const result = validateGenerationAccess(
      "enterprise", 999, "cinematic", "presentation", "portrait",
      true, true
    );
    expect(result.canGenerate).toBe(true);
  });
});

// ───────────────────────────────────────────────
// CREDIT_COSTS consistency
// ───────────────────────────────────────────────
describe("CREDIT_COSTS", () => {
  it("has all expected cost categories", () => {
    expect(CREDIT_COSTS).toHaveProperty("short");
    expect(CREDIT_COSTS).toHaveProperty("brief");
    expect(CREDIT_COSTS).toHaveProperty("presentation");
    expect(CREDIT_COSTS).toHaveProperty("smartflow");
    expect(CREDIT_COSTS).toHaveProperty("cinematic");
  });

  it("costs increase with video length", () => {
    expect(CREDIT_COSTS.short).toBeLessThan(CREDIT_COSTS.brief);
    expect(CREDIT_COSTS.brief).toBeLessThan(CREDIT_COSTS.presentation);
  });

  it("cinematic is the most expensive", () => {
    expect(CREDIT_COSTS.cinematic).toBeGreaterThan(CREDIT_COSTS.presentation);
  });
});
