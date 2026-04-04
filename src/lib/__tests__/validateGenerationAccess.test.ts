/// <reference types="vitest/globals" />
import { validateGenerationAccess } from "../planLimits";

// ───────────────────────────────────────────────
// Subscription status checks
// ───────────────────────────────────────────────
describe("validateGenerationAccess — subscription status", () => {
  const base = {
    creditsBalance: 100,
    projectType: "doc2video" as const,
    length: "short",
    format: "landscape",
  };

  it("blocks past_due subscriptions", () => {
    const result = validateGenerationAccess("starter", base.creditsBalance, base.projectType, base.length, base.format, false, false, "past_due");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("overdue");
  });

  it("blocks unpaid subscriptions", () => {
    const result = validateGenerationAccess("creator", base.creditsBalance, base.projectType, base.length, base.format, false, false, "unpaid");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("overdue");
  });

  it("blocks canceled paid subscriptions", () => {
    const result = validateGenerationAccess("creator", base.creditsBalance, base.projectType, base.length, base.format, false, false, "canceled");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("canceled");
  });

  it("allows canceled on free plan (free doesn't need subscription)", () => {
    const result = validateGenerationAccess("free", 10, base.projectType, base.length, base.format, false, false, "canceled");
    expect(result.canGenerate).toBe(true);
  });

  it("blocks expired subscriptions", () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const result = validateGenerationAccess("starter", base.creditsBalance, base.projectType, base.length, base.format, false, false, "active", pastDate);
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("allows active subscriptions with future end date", () => {
    const futureDate = new Date(Date.now() + 86400000 * 30).toISOString(); // 30 days out
    const result = validateGenerationAccess("starter", base.creditsBalance, base.projectType, base.length, base.format, false, false, "active", futureDate);
    expect(result.canGenerate).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Credit checks
// ───────────────────────────────────────────────
describe("validateGenerationAccess — credits", () => {
  it("blocks when credits are insufficient", () => {
    const result = validateGenerationAccess("starter", 0, "doc2video", "short", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("Insufficient credits");
  });

  it("allows when credits are exactly enough", () => {
    // short = 1 credit
    const result = validateGenerationAccess("starter", 1, "doc2video", "short", "landscape");
    expect(result.canGenerate).toBe(true);
  });

  it("blocks cinematic with insufficient credits (12 required)", () => {
    const result = validateGenerationAccess("professional", 11, "cinematic", "brief", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("12");
  });

  it("allows cinematic with enough credits", () => {
    const result = validateGenerationAccess("professional", 12, "cinematic", "brief", "landscape");
    expect(result.canGenerate).toBe(true);
  });
});

// ───────────────────────────────────────────────
// Plan restrictions
// ───────────────────────────────────────────────
describe("validateGenerationAccess — plan restrictions", () => {
  it("blocks free plan from infographics", () => {
    const result = validateGenerationAccess("free", 10, "smartflow", "short", "landscape");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("Infographics");
    expect(result.requiredPlan).toBe("starter");
  });

  it("allows starter plan to create infographics", () => {
    const result = validateGenerationAccess("starter", 10, "smartflow", "short", "landscape");
    expect(result.canGenerate).toBe(true);
  });

  it("blocks free plan from portrait format", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "short", "portrait");
    expect(result.canGenerate).toBe(false);
    expect(result.error).toContain("format");
  });

  it("blocks free plan from presentation length", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "presentation", "landscape");
    expect(result.canGenerate).toBe(false);
  });

  it("blocks brand mark on free plan", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "short", "landscape", true);
    expect(result.canGenerate).toBe(false);
    expect(result.requiredPlan).toBe("creator");
  });

  it("blocks custom style on free plan", () => {
    const result = validateGenerationAccess("free", 10, "doc2video", "short", "landscape", false, true);
    expect(result.canGenerate).toBe(false);
    expect(result.requiredPlan).toBe("creator");
  });

  it("allows professional plan full access", () => {
    const result = validateGenerationAccess("professional", 100, "doc2video", "presentation", "portrait", true, true);
    expect(result.canGenerate).toBe(true);
  });
});
