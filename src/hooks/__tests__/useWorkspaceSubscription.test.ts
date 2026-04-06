/// <reference types="vitest/globals" />
import { validateGenerationAccess } from "@/lib/planLimits";

describe("useWorkspaceSubscription - guardGeneration logic", () => {
  it("delegates to validateGenerationAccess correctly for active subscription", () => {
    const result = validateGenerationAccess(
      "creator", 500, "doc2video", "short", "landscape",
      false, false, "active"
    );
    expect(result.canGenerate).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("blocks generation when subscription is not active", () => {
    const result = validateGenerationAccess(
      "creator", 500, "doc2video", "short", "landscape",
      false, false, "past_due"
    );
    expect(result.canGenerate).toBe(false);
    expect(result.upgradeRequired).toBe(true);
  });

  it("free plan users are not blocked by canceled status", () => {
    const result = validateGenerationAccess(
      "free", 200, "doc2video", "short", "landscape",
      false, false, "canceled"
    );
    expect(result.canGenerate).toBe(true);
  });
});
