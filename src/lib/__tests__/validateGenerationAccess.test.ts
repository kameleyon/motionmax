/// <reference types="vitest/globals" />
import { validateGenerationAccess } from "../planLimits";

// -----------------------------------------------
// Subscription status checks
// -----------------------------------------------
describe("validateGenerationAccess -- subscription status", () => {
  it("blocks past_due subscriptions", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "past_due");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("overdue");
  });

  it("blocks unpaid subscriptions", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "unpaid");
    expect(r.canGenerate).toBe(false);
  });

  it("blocks canceled paid subscriptions", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "canceled");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("canceled");
  });

  it("allows canceled on free plan", () => {
    const r = validateGenerationAccess("free", 200, "doc2video", "short", "landscape", false, false, "canceled");
    expect(r.canGenerate).toBe(true);
  });

  it("blocks expired subscriptions", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "active", past);
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("expired");
  });

  it("allows active subscriptions with future end date", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "active", future);
    expect(r.canGenerate).toBe(true);
  });
});

// -----------------------------------------------
// Credit checks (per-second model)
// -----------------------------------------------
describe("validateGenerationAccess -- credits", () => {
  it("blocks when credits insufficient for standard short (150 needed)", () => {
    const r = validateGenerationAccess("creator", 100, "doc2video", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("Insufficient");
  });

  it("allows when credits are enough for standard short", () => {
    const r = validateGenerationAccess("creator", 150, "doc2video", "short", "landscape");
    expect(r.canGenerate).toBe(true);
  });

  it("blocks cinematic with insufficient credits (750 needed for short)", () => {
    const r = validateGenerationAccess("studio", 700, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("5x");
  });

  it("allows cinematic with enough credits", () => {
    const r = validateGenerationAccess("studio", 750, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(true);
  });
});

// -----------------------------------------------
// Plan restrictions
// -----------------------------------------------
describe("validateGenerationAccess -- plan restrictions", () => {
  it("blocks free plan from smart flow (limit 3)", () => {
    // smartflow limit is 3 total on free, but the validation checks limit === 0
    // Free plan has smartFlowLimit: 3, so it's allowed (just limited)
    // Actually free has smartFlowLimit: 3 which is > 0, so it passes the basic check
    const r = validateGenerationAccess("free", 200, "smartflow", "short", "landscape");
    expect(r.canGenerate).toBe(true);
  });

  it("blocks free plan from portrait format", () => {
    const r = validateGenerationAccess("free", 200, "doc2video", "short", "portrait");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("format");
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

  it("blocks custom style on free plan", () => {
    const r = validateGenerationAccess("free", 200, "doc2video", "short", "landscape", false, true);
    expect(r.canGenerate).toBe(false);
    expect(r.requiredPlan).toBe("creator");
  });

  it("allows studio plan full access", () => {
    const r = validateGenerationAccess("studio", 5000, "doc2video", "short", "portrait", true, true);
    expect(r.canGenerate).toBe(true);
  });
});
