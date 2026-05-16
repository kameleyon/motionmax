import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenRouterVideoResult } from "./openrouterVideo.js";

// Module-level mocks — keep tests hermetic, no network.
vi.mock("../lib/logger.js", () => ({
  writeApiLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./openrouter.js", () => ({
  acquireOpenRouter: vi.fn().mockResolvedValue(undefined),
  releaseOpenRouter: vi.fn(),
}));

const originalFetch = globalThis.fetch;

describe("generateOpenRouterVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENROUTER_API_KEY = "or_test_key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns videoUrl when submit succeeds and poll reports completed", async () => {
    // Submit response, then poll response with terminal status.
    const submitJson = { id: "or-job-1", polling_url: "https://or.test/poll/or-job-1" };
    const pollJson  = {
      id: "or-job-1",
      status: "completed",
      output: { video: { url: "https://or.test/out/or-job-1.mp4" } },
      cost: 0.13,
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pollJson,   text: async () => "" }) as never;

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res: OpenRouterVideoResult = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/first.jpg",
      endImageUrl: "https://cdn.test/last.jpg",
      prompt: "test prompt",
      duration: 10,
      resolution: "480p",
      pollMaxMs: 30_000,    // short cap so the loop exits fast even on bug
    });

    expect(res.videoUrl).toBe("https://or.test/out/or-job-1.mp4");
    expect(res.error).toBeUndefined();
    expect(res.cost).toBe(0.13);
    expect(res.provider).toBe("openrouter");
    expect(res.model).toBe("bytedance/seedance-1-5-pro");
  }, 15_000);
});
