/// <reference types="vitest/globals" />
import { validateGenerationAccess } from "@/lib/planLimits";

describe("validateGenerationAccess - edge cases", () => {
  it("blocks generation with 0 credits", () => {
    const r = validateGenerationAccess("starter", 0, "doc2video", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("Insufficient");
  });

  it("blocks cinematic on free plan when credits are insufficient", () => {
    const r = validateGenerationAccess("free", 10, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("Insufficient");
  });

  it("allows cinematic on starter with enough credits", () => {
    const r = validateGenerationAccess("starter", 12, "cinematic", "short", "landscape");
    expect(r.canGenerate).toBe(true);
  });

  it("blocks portrait format on free plan", () => {
    const r = validateGenerationAccess("free", 10, "doc2video", "short", "portrait");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("format");
  });

  it("blocks presentation length on free plan", () => {
    const r = validateGenerationAccess("free", 10, "doc2video", "presentation", "landscape");
    expect(r.canGenerate).toBe(false);
  });

  it("blocks brand mark on starter plan", () => {
    const r = validateGenerationAccess("starter", 10, "doc2video", "short", "landscape", true);
    expect(r.canGenerate).toBe(false);
    expect(r.requiredPlan).toBe("creator");
  });

  it("allows brand mark on creator plan", () => {
    const r = validateGenerationAccess("creator", 10, "doc2video", "short", "landscape", true);
    expect(r.canGenerate).toBe(true);
  });

  it("handles past_due subscription", () => {
    const r = validateGenerationAccess("creator", 100, "doc2video", "short", "landscape", false, false, "past_due");
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("overdue");
  });

  it("handles expired subscription end date", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const r = validateGenerationAccess("creator", 100, "doc2video", "short", "landscape", false, false, "active", past);
    expect(r.canGenerate).toBe(false);
    expect(r.error).toContain("expired");
  });

  it("allows active subscription with future end date", () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const r = validateGenerationAccess("creator", 100, "doc2video", "short", "landscape", false, false, "active", future);
    expect(r.canGenerate).toBe(true);
  });

  it("professional plan allows everything", () => {
    const r = validateGenerationAccess("professional", 100, "doc2video", "presentation", "portrait", true, true, "active");
    expect(r.canGenerate).toBe(true);
  });
});
