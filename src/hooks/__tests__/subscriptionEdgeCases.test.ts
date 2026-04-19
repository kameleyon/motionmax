/// <reference types="vitest/globals" />
import { validateGenerationAccess } from "@/lib/planLimits";

// These tests belong here to document the credit/access rules that
// useWorkspaceSubscription.guardGeneration delegates to.
describe("validateGenerationAccess - planLimits rules", () => {
  it("blocks generation with 0 credits", () => {
    const r = validateGenerationAccess("creator", 0, "doc2video", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("Insufficient");
  });

  it("cinematic requires 750 credits for short (150s x 5x)", () => {
    const r = validateGenerationAccess("studio", 749, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(false);
  });

  it("allows cinematic with exactly 750 credits", () => {
    const r = validateGenerationAccess("studio", 750, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(true);
  });

  it("smartflow needs 75 credits (150s x 0.5x)", () => {
    const r = validateGenerationAccess("creator", 74, "smartflow", "short", "landscape");
    expect(r.canGenerate).toBe(false);
  });

  it("blocks portrait format on free plan", () => {
    const r = validateGenerationAccess("free", 1000, "doc2video", "short", "portrait");
    expect(r.canGenerate).toBe(false);
  });

  it("blocks brand mark on creator (studio only)", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", true);
    expect(r.canGenerate).toBe(false);
    expect(r.requiredPlan).toBe("studio");
  });

  it("allows brand mark on studio", () => {
    const r = validateGenerationAccess("studio", 3000, "doc2video", "short", "landscape", true);
    expect(r.canGenerate).toBe(true);
  });

  it("handles past_due subscription", () => {
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "past_due");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("overdue");
  });

  it("handles expired subscription end date", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "active", past);
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("expired");
  });

  it("allows active subscription with future end date", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const r = validateGenerationAccess("creator", 1000, "doc2video", "short", "landscape", false, false, "active", future);
    expect(r.canGenerate).toBe(true);
  });

  it("studio plan allows everything", () => {
    const r = validateGenerationAccess("studio", 5000, "doc2video", "short", "portrait", true, true, "active");
    expect(r.canGenerate).toBe(true);
  });
});
