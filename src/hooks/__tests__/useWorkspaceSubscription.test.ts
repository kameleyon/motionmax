/// <reference types="vitest/globals" />
import { renderHook, act } from "@testing-library/react";
import { vi } from "vitest";

// ── hoisted mocks ──────────────────────────────────────────────────────────────
const { mockUseSubscription, mockToastError } = vi.hoisted(() => ({
  mockUseSubscription: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/hooks/useSubscription", () => ({
  useSubscription: mockUseSubscription,
  PLAN_LIMITS: {
    free: { maxDuration: 30, maxResolution: "720p", brandMark: false },
    creator: { maxDuration: 150, maxResolution: "1080p", brandMark: false },
    studio: { maxDuration: 300, maxResolution: "4K", brandMark: true },
  },
  validateGenerationAccess: vi.fn(
    (plan, credits, _type, _length, format, hasBrandMark, _custom, status) => {
      if (credits === 0) return { canGenerate: false, error: "Insufficient credits" };
      if (format === "portrait" && plan === "free")
        return { canGenerate: false, error: "Portrait requires Creator+" };
      if (hasBrandMark && plan !== "studio")
        return { canGenerate: false, error: "Custom brand requires Studio", requiredPlan: "studio" };
      if (status === "past_due") return { canGenerate: false, error: "Payment overdue", upgradeRequired: true };
      return { canGenerate: true };
    }
  ),
}));

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));

import { useWorkspaceSubscription } from "@/hooks/useWorkspaceSubscription";

function makeSubscription(overrides = {}) {
  return {
    plan: "creator" as const,
    creditsBalance: 500,
    subscriptionStatus: "active",
    subscriptionEnd: null,
    checkSubscription: vi.fn(),
    fetchError: null,
    ...overrides,
  };
}

describe("useWorkspaceSubscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSubscription.mockReturnValue(makeSubscription());
  });

  describe("initial state", () => {
    it("exposes plan, credits and limits from useSubscription", () => {
      const { result } = renderHook(() => useWorkspaceSubscription());
      expect(result.current.plan).toBe("creator");
      expect(result.current.creditsBalance).toBe(500);
      expect(result.current.limits).toBeDefined();
    });

    it("starts with all modals closed", () => {
      const { result } = renderHook(() => useWorkspaceSubscription());
      expect(result.current.modalState.showUpgradeModal).toBe(false);
      expect(result.current.modalState.showSuspendedModal).toBe(false);
    });
  });

  describe("guardGeneration", () => {
    it("returns true when generation is allowed", () => {
      const { result } = renderHook(() => useWorkspaceSubscription());
      let allowed: boolean;
      act(() => {
        allowed = result.current.guardGeneration({
          projectType: "doc2video",
          length: "short",
          format: "landscape",
        });
      });
      expect(allowed!).toBe(true);
      expect(result.current.modalState.showUpgradeModal).toBe(false);
    });

    it("shows upgrade modal and returns false when credits are 0", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ creditsBalance: 0 }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      let allowed: boolean;
      act(() => {
        allowed = result.current.guardGeneration({
          projectType: "doc2video",
          length: "short",
          format: "landscape",
        });
      });
      expect(allowed!).toBe(false);
      expect(result.current.modalState.showUpgradeModal).toBe(true);
      expect(result.current.modalState.upgradeReason).toContain("Insufficient");
    });

    it("fires toast.error when generation is blocked", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ creditsBalance: 0 }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      act(() => {
        result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "landscape" });
      });
      expect(mockToastError).toHaveBeenCalledWith("Cannot Generate", expect.objectContaining({ description: expect.any(String) }));
    });

    it("shows suspended modal (not upgrade modal) for past_due status", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ subscriptionStatus: "past_due" }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      let allowed: boolean;
      act(() => {
        allowed = result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "landscape" });
      });
      expect(allowed!).toBe(false);
      expect(result.current.modalState.showSuspendedModal).toBe(true);
      expect(result.current.modalState.suspendedStatus).toBe("past_due");
      expect(result.current.modalState.showUpgradeModal).toBe(false);
    });

    it("shows suspended modal for unpaid status", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ subscriptionStatus: "unpaid" }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      act(() => {
        result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "landscape" });
      });
      expect(result.current.modalState.showSuspendedModal).toBe(true);
      expect(result.current.modalState.suspendedStatus).toBe("unpaid");
    });

    it("blocks portrait on free plan via validateGenerationAccess", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ plan: "free", creditsBalance: 1000 }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      let allowed: boolean;
      act(() => {
        allowed = result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "portrait" });
      });
      expect(allowed!).toBe(false);
      expect(result.current.modalState.showUpgradeModal).toBe(true);
    });

    it("blocks custom brand mark on creator plan", () => {
      const { result } = renderHook(() => useWorkspaceSubscription());
      let allowed: boolean;
      act(() => {
        allowed = result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "landscape", hasBrandMark: true });
      });
      expect(allowed!).toBe(false);
      expect(result.current.modalState.showUpgradeModal).toBe(true);
    });
  });

  describe("modal controls", () => {
    it("closeUpgradeModal hides the upgrade modal", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ creditsBalance: 0 }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      act(() => {
        result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "landscape" });
      });
      expect(result.current.modalState.showUpgradeModal).toBe(true);
      act(() => {
        result.current.closeUpgradeModal();
      });
      expect(result.current.modalState.showUpgradeModal).toBe(false);
    });

    it("closeSuspendedModal hides the suspended modal", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ subscriptionStatus: "past_due" }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      act(() => {
        result.current.guardGeneration({ projectType: "doc2video", length: "short", format: "landscape" });
      });
      expect(result.current.modalState.showSuspendedModal).toBe(true);
      act(() => {
        result.current.closeSuspendedModal();
      });
      expect(result.current.modalState.showSuspendedModal).toBe(false);
    });
  });

  describe("passthrough fields", () => {
    it("exposes fetchError from useSubscription", () => {
      mockUseSubscription.mockReturnValue(makeSubscription({ fetchError: "Network error" }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      expect(result.current.fetchError).toBe("Network error");
    });

    it("exposes checkSubscription from useSubscription", async () => {
      const checkSubscription = vi.fn().mockResolvedValue(undefined);
      mockUseSubscription.mockReturnValue(makeSubscription({ checkSubscription }));
      const { result } = renderHook(() => useWorkspaceSubscription());
      await act(async () => {
        await result.current.checkSubscription();
      });
      expect(checkSubscription).toHaveBeenCalledOnce();
    });
  });
});
