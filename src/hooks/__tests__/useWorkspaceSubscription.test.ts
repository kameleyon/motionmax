/// <reference types="vitest/globals" />
/**
 * useWorkspaceSubscription hook tests
 *
 * Since useWorkspaceSubscription is a React hook that depends on Supabase context,
 * we test the underlying pure function (validateGenerationAccess from planLimits)
 * which contains all the business logic.
 *
 * See subscriptionEdgeCases.test.ts for comprehensive edge-case coverage.
 */
import { validateGenerationAccess } from "@/lib/planLimits";

describe("useWorkspaceSubscription - guardGeneration logic", () => {
  it("delegates to validateGenerationAccess correctly for active subscription", () => {
    const result = validateGenerationAccess(
      "starter",
      30,
      "doc2video",
      "short",
      "landscape",
      false,
      false,
      "active"
    );
    expect(result.canGenerate).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("blocks generation when subscription is not active", () => {
    const result = validateGenerationAccess(
      "starter",
      30,
      "doc2video",
      "short",
      "landscape",
      false,
      false,
      "past_due"
    );
    expect(result.canGenerate).toBe(false);
    expect(result.upgradeRequired).toBe(true);
  });

  it("free plan users are not blocked by canceled status", () => {
    const result = validateGenerationAccess(
      "free",
      10,
      "doc2video",
      "short",
      "landscape",
      false,
      false,
      "canceled"
    );
    expect(result.canGenerate).toBe(true);
  });
});
