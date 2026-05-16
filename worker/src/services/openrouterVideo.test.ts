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

  it("returns error on HTTP 4xx submit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({}),
      text: async () => `{"error":{"message":"bad model"}}`,
    }) as never;

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
    });

    expect(res.videoUrl).toBeNull();
    expect(res.error).toContain("400");
  });

  it("returns error on HTTP 5xx submit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 502,
      json: async () => ({}),
      text: async () => "bad gateway",
    }) as never;

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
    });

    expect(res.videoUrl).toBeNull();
    expect(res.error).toContain("502");
  });

  it("returns error when provider reports status=failed", async () => {
    const submitJson = { id: "or-job-2", polling_url: "https://or.test/poll/or-job-2" };
    const pollJson   = { id: "or-job-2", status: "failed", error: { message: "moderation" } };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pollJson,   text: async () => "" }) as never;

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
    });

    expect(res.videoUrl).toBeNull();
    expect(res.error).toContain("moderation");
  }, 15_000);

  it("returns error when poll exceeds pollMaxMs", async () => {
    const submitJson = { id: "or-job-3", polling_url: "https://or.test/poll/or-job-3" };
    const pendingJson = { id: "or-job-3", status: "processing" };

    // Submit OK then unlimited 'processing' poll responses.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson,  text: async () => "" })
      .mockImplementation(async () => ({ ok: true, status: 200, json: async () => pendingJson, text: async () => "" })) as never;

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 7_000,        // expires after ~1 poll cycle
    });

    expect(res.videoUrl).toBeNull();
    expect(res.error).toMatch(/timeout/i);
  }, 15_000);                  // give vitest extra time for the 7s poll cap

  it("returns abort error when signal aborts mid-poll", async () => {
    const submitJson  = { id: "or-job-4", polling_url: "https://or.test/poll/or-job-4" };
    const pendingJson = { id: "or-job-4", status: "processing" };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson,  text: async () => "" })
      .mockImplementation(async () => ({ ok: true, status: 200, json: async () => pendingJson, text: async () => "" })) as never;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);   // abort almost immediately

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
      signal: controller.signal,
    });

    expect(res.videoUrl).toBeNull();
    expect(res.error).toMatch(/abort/i);
  }, 15_000);

  it("returns error when OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
    });

    expect(res.videoUrl).toBeNull();
    expect(res.error).toContain("OPENROUTER_API_KEY");
  });
});
