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
    // Real OpenRouter response shape (verified 2026-05-17 against live API):
    //   { id, status: "completed", unsigned_urls: [...], usage: { cost } }
    const submitJson = { id: "or-job-1", polling_url: "https://or.test/poll/or-job-1" };
    const pollJson  = {
      id: "or-job-1",
      status: "completed",
      unsigned_urls: ["https://or.test/out/or-job-1.mp4"],
      usage: { cost: 0.13 },
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
    // OpenRouter URLs need Bearer auth to download — service must surface this.
    expect(res.downloadAuthHeader).toBe("Bearer or_test_key");
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

  it("fires onSubmitted callback after successful POST", async () => {
    const submitJson = { id: "or-job-5", polling_url: "https://or.test/poll/or-job-5" };
    const pollJson   = {
      id: "or-job-5",
      status: "completed",
      unsigned_urls: ["https://or.test/out/or-job-5.mp4"],
      usage: { cost: 0.13 },
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pollJson,   text: async () => "" }) as never;

    const onSubmitted = vi.fn().mockResolvedValue(undefined);

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
      onSubmitted,
    });

    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledWith({
      providerJobId: "or-job-5",
      pollUrl: "https://or.test/poll/or-job-5",
      model: "bytedance/seedance-1-5-pro",
    });
  }, 15_000);

  it("does NOT throw when onSubmitted callback rejects", async () => {
    const submitJson = { id: "or-job-6", polling_url: "https://or.test/poll/or-job-6" };
    const pollJson   = {
      id: "or-job-6",
      status: "completed",
      unsigned_urls: ["https://or.test/out/or-job-6.mp4"],
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pollJson,   text: async () => "" }) as never;

    const onSubmitted = vi.fn().mockRejectedValue(new Error("DB outage"));

    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    const res = await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
      onSubmitted,
    });

    // Generation still completes; checkpoint failure is non-fatal.
    expect(res.videoUrl).toBe("https://or.test/out/or-job-6.mp4");
  }, 15_000);

  it("writes api_call_logs row on success with response.cost when present", async () => {
    const submitJson = { id: "or-job-7", polling_url: "https://or.test/poll/or-job-7" };
    const pollJson   = {
      id: "or-job-7",
      status: "completed",
      unsigned_urls: ["https://or.test/out/or-job-7.mp4"],
      usage: { cost: 0.13 },
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pollJson,   text: async () => "" }) as never;

    const { writeApiLog } = await import("../lib/logger.js");
    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
      userId: "user-99",
      generationId: "gen-99",
    });

    expect(writeApiLog).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter",
      model: "bytedance/seedance-1-5-pro",
      status: "success",
      cost: 0.13,
      userId: "user-99",
      generationId: "gen-99",
    }));
  }, 15_000);

  it("falls back to rate-card cost when response.cost is missing", async () => {
    const submitJson = { id: "or-job-8", polling_url: "https://or.test/poll/or-job-8" };
    const pollJson   = {
      id: "or-job-8",
      status: "completed",
      unsigned_urls: ["https://or.test/out/or-job-8.mp4"],
      // usage.cost intentionally omitted — verifies rate-card fallback
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => submitJson, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => pollJson,   text: async () => "" }) as never;

    const { writeApiLog } = await import("../lib/logger.js");
    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      duration: 10,
      resolution: "480p",
      pollMaxMs: 30_000,
    });

    // Rate-card fallback: 10s * $0.013/sec = $0.13
    expect(writeApiLog).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter",
      model: "bytedance/seedance-1-5-pro",
      status: "success",
      cost: expect.closeTo(0.13, 2),
    }));
  }, 15_000);

  it("writes api_call_logs row on error path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }) as never;

    const { writeApiLog } = await import("../lib/logger.js");
    const { generateOpenRouterVideo } = await import("./openrouterVideo.js");
    await generateOpenRouterVideo({
      model: "bytedance/seedance-1-5-pro",
      imageUrl: "https://cdn.test/a.jpg",
      prompt: "x",
      pollMaxMs: 30_000,
    });

    expect(writeApiLog).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter",
      model: "bytedance/seedance-1-5-pro",
      status: "error",
    }));
  });

  it("dumps the full error object when no .message or .failure_reason is present", async () => {
    // Real provider-rejection responses can have shapes like
    // { status: "failed", error: { code: "moderation_violation", type: "ContentFilter" } }
    // — without a top-level "message" field. The service must still
    // surface SOMETHING useful, not just "OpenRouter status=failed".
    const submitJson = { id: "or-job-9", polling_url: "https://or.test/poll/or-job-9" };
    const pollJson   = {
      id: "or-job-9",
      status: "failed",
      error: { code: "moderation_violation", type: "ContentFilter" },
    };

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
    // Must contain the JSON-dumped error so on-call can see the actual reason.
    expect(res.error).toMatch(/moderation_violation/);
  }, 15_000);
});
