/**
 * Tests for handleCinematicVideo — the worker-side cinematic video handler
 * (Probe C-10-3 PART C step 11).
 *
 * Coverage:
 *  1. Kill-switch armed (`pause_video`) → handler fail-fasts with the
 *     admin-set message before any provider submit.
 *  2. Missing required fields in payload → throws (no generationId, no
 *     scenes row, scene index out of range).
 *  3. Generation lookup returns null → throws ("Generation not found").
 *  4. The handler does NOT swallow Hypereal failures — they bubble out
 *     so the dispatcher's refundCreditsOnFailure path runs.
 *
 * Design note: the handler is monolithic and pulls supabase + Hypereal
 * services from module-level singletons. We mock those at the module
 * boundary via vi.mock so the real handler code path runs end-to-end
 * against a controllable mock — no network, no real DB. This mirrors
 * the pattern used by refundCreditsOnFailure.test.ts and
 * generateVideo.test.ts.
 *
 * What's intentionally NOT covered here (and why):
 *  - Full successful generation path: requires mocking Replicate / Hypereal
 *    + checkpoint write + scene persistence + image generation. The cost-
 *    benefit is poor — the handler is 800 lines of orchestration and the
 *    real value is in the failure modes above, which is where credits
 *    leak. The happy path is covered by the E2E generation tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../lib/supabase.js", () => {
  const supabase = {
    from: vi.fn(),
    rpc: vi.fn(),
  };
  return { supabase };
});

vi.mock("../lib/logger.js", () => ({
  writeSystemLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/audit.js", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  auditError: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/sceneUpdate.js", () => ({
  updateSceneField: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/retryClassifier.js", () => ({
  retryDbRead: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => {
    // Pass-through: just call the underlying read once. The real version
    // adds retry-on-transient — orthogonal to the contract under test.
    return await fn();
  }),
}));

vi.mock("../lib/checkpoint.js", () => ({
  saveCheckpoint: vi.fn().mockResolvedValue(undefined),
  readCheckpointKey: vi.fn().mockResolvedValue(undefined),
  clearCheckpointKey: vi.fn().mockResolvedValue(undefined),
  CheckpointReadError: class CheckpointReadError extends Error {},
}));

// Kill-switch flag — overridden per-test to flip pause_video.
const isKillSwitchArmedMock = vi.fn().mockResolvedValue(false);
vi.mock("../lib/featureFlags.js", () => ({
  isKillSwitchArmed: isKillSwitchArmedMock,
}));

// Hypereal service stubs — handler imports a bag of generators + polls.
// Default: all return success. Individual tests override these to
// simulate failure modes.
vi.mock("../services/hypereal.js", () => ({
  generateKlingV3ProI2V: vi.fn().mockResolvedValue({ jobId: "hy-kling-1" }),
  generateKlingV3ProVideo: vi.fn().mockResolvedValue("https://hypereal.test/clip.mp4"),
  pollHyperealJob: vi.fn().mockResolvedValue({
    status: "completed",
    videoUrl: "https://hypereal.test/clip.mp4",
  }),
}));

vi.mock("../services/openrouterVideo.js", () => ({
  generateOpenRouterVideo: vi.fn().mockResolvedValue({
    videoUrl: "https://or.test/out.mp4",
    provider: "openrouter",
    model: "bytedance/seedance-1-5-pro",
    durationSeconds: 10,
    cost: 0.13,
  }),
}));

vi.mock("../services/atlasCloudSeedance.js", () => ({
  generateAtlasCloudSeedance: vi.fn().mockResolvedValue({
    videoUrl: "https://atlas.test/out.mp4",
    provider: "atlascloud",
    model: "bytedance/seedance-2.0/image-to-video",
  }),
}));

vi.mock("../services/imageGenerator.js", () => ({
  generateImage: vi.fn().mockResolvedValue("https://cdn.test/image.jpg"),
}));

vi.mock("../services/prompts.js", () => ({
  getStylePrompt: vi.fn().mockReturnValue("cinematic, realistic"),
  getStyleNegativePrompt: vi.fn().mockReturnValue(""),
}));

// ── Fluent supabase chain builder ─────────────────────────────────────

function makeChain(rows: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockResolvedValue({ error: null });
  chain.single = vi.fn().mockResolvedValue({ data: rows, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: rows, error: null });
  return chain;
}

function makeErrorChain(message: string) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message } });
  chain.single = vi.fn().mockResolvedValue({ data: null, error: { message } });
  return chain;
}

// ── Fixtures ──────────────────────────────────────────────────────────

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    generationId: "gen-test-123",
    projectId: "proj-test-456",
    sceneIndex: 0,
    regenerate: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("handleCinematicVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isKillSwitchArmedMock.mockResolvedValue(false);
    // Default: HYPEREALIMAGE_API_KEY set so the prompt-only failure paths
    // run. Video generation reads HYPEREALIMAGE (split landed 2026-05-14);
    // HYPEREAL_API_KEY remains the key for image/audio/LLM paths.
    process.env.HYPEREALIMAGE_API_KEY = "hy_test_key";
    process.env.HYPEREAL_API_KEY = "hy_test_key";
  });

  // ── 1. Kill-switch ────────────────────────────────────────────────
  describe("kill-switch (pause_video)", () => {
    it("throws immediately when pause_video kill-switch is armed", async () => {
      isKillSwitchArmedMock.mockResolvedValue(true);

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await expect(
        handleCinematicVideo("job-1", makePayload(), "user-1"),
      ).rejects.toThrow(/paused by an administrator|pause_video/i);
    });

    it("does NOT submit to Hypereal when kill-switch trips", async () => {
      isKillSwitchArmedMock.mockResolvedValue(true);

      const { generateKlingV3ProI2V } = await import("../services/hypereal.js");
      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");

      await expect(
        handleCinematicVideo("job-2", makePayload(), "user-2"),
      ).rejects.toThrow();

      expect(generateKlingV3ProI2V).not.toHaveBeenCalled();
    });
  });

  // ── 2. Missing / malformed input ──────────────────────────────────
  describe("missing required fields", () => {
    it("throws when the generation row is not found in DB", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeErrorChain("not found") as never,
      );

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await expect(
        handleCinematicVideo("job-3", makePayload(), "user-3"),
      ).rejects.toThrow(/Generation not found/i);
    });

    it("throws when scenes column is null", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeChain({ scenes: null }) as never,
      );

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await expect(
        handleCinematicVideo("job-4", makePayload(), "user-4"),
      ).rejects.toThrow(/no scenes/i);
    });

    it("throws when scenes is an empty array", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeChain({ scenes: [] }) as never,
      );

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await expect(
        handleCinematicVideo("job-5", makePayload(), "user-5"),
      ).rejects.toThrow(/no scenes/i);
    });

    it("throws when sceneIndex is out of range", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeChain({ scenes: [{ number: 1, voiceover: "v" }] }) as never,
      );

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await expect(
        handleCinematicVideo(
          "job-6",
          makePayload({ sceneIndex: 5 }),
          "user-6",
        ),
      ).rejects.toThrow(/Scene 5 not found/i);
    });
  });

  // ── 3. Provider failures bubble out (so refund path runs) ─────────
  describe("provider failure surfacing", () => {
    it("throws when HYPEREALIMAGE_API_KEY is not configured", async () => {
      // Provide enough fixture data that the handler gets past scenes
      // validation and project lookup, then hits the API-key check.
      const scenes = [
        { number: 1, voiceover: "v", visualPrompt: "p", imageUrl: "https://cdn.test/s0.jpg" },
        { number: 2, voiceover: "v2", visualPrompt: "p2", imageUrl: "https://cdn.test/s1.jpg" },
      ];

      const { supabase } = await import("../lib/supabase.js");
      // Two from() calls in flight: generations lookup, then project lookup.
      // Build a small router so both resolve to sensible rows.
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "generations") return makeChain({ scenes }) as never;
        if (table === "projects") return makeChain({
          format: "landscape",
          style: "realistic",
          custom_style: null,
          character_description: "",
          voice_inclination: "en",
          character_images: [],
        }) as never;
        return makeChain(null) as never;
      });

      // Wipe the video-specific API key so the handler aborts before
      // trying Hypereal. HYPEREAL_API_KEY stays set (image fallback would
      // otherwise short-circuit before we hit the video key check).
      delete process.env.HYPEREALIMAGE_API_KEY;

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await expect(
        handleCinematicVideo("job-7", makePayload(), "user-7"),
      ).rejects.toThrow(/HYPEREALIMAGE_API_KEY/i);
    });
  });

  describe("cross-provider checkpoint scrub", () => {
    it("scrubs stale OpenRouter Seedance checkpoint instead of resuming via Hypereal", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeChain({ scenes: [{ imageUrl: "https://cdn.test/img.jpg", visualPrompt: "x" }] }) as never,
      );

      const { readCheckpointKey, clearCheckpointKey } = await import("../lib/checkpoint.js");
      vi.mocked(readCheckpointKey).mockResolvedValue({
        stage: "polling",
        providerJobId: "or-stale-1",
        pollUrl: "https://openrouter.ai/api/v1/videos/or-stale-1",
        model: "bytedance/seedance-1-5-pro",
      });

      const { pollHyperealJob } = await import("../services/hypereal.js");

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await handleCinematicVideo("job-scrub-1", makePayload({ sceneIndex: 0 }), "user-1").catch(() => {});

      expect(pollHyperealJob).not.toHaveBeenCalled();
      expect(clearCheckpointKey).toHaveBeenCalledWith("job-scrub-1", expect.stringContaining("scene_"));
    });

    it("scrubs stale OpenRouter Kling O1 checkpoint instead of resuming via Hypereal", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeChain({ scenes: [{ imageUrl: "https://cdn.test/img.jpg", visualPrompt: "x" }] }) as never,
      );

      const { readCheckpointKey, clearCheckpointKey } = await import("../lib/checkpoint.js");
      vi.mocked(readCheckpointKey).mockResolvedValue({
        stage: "polling",
        providerJobId: "or-stale-2",
        pollUrl: "https://openrouter.ai/api/v1/videos/or-stale-2",
        model: "kwaivgi/kling-video-o1",
      });

      const { pollHyperealJob } = await import("../services/hypereal.js");

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await handleCinematicVideo("job-scrub-2", makePayload({ sceneIndex: 0 }), "user-1").catch(() => {});

      expect(pollHyperealJob).not.toHaveBeenCalled();
      expect(clearCheckpointKey).toHaveBeenCalledWith("job-scrub-2", expect.stringContaining("scene_"));
    });
  });

  describe("provider chain — rung 1 (OpenRouter Seedance 1.5 Pro)", () => {
    it("uses rung 1 result when OpenRouter Seedance succeeds; does NOT call AtlasCloud", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "generations") {
          return makeChain({ scenes: [{ imageUrl: "https://cdn.test/img.jpg", visualPrompt: "x" }] }) as never;
        }
        if (table === "projects") {
          return makeChain({ format: "landscape", style: "realistic", custom_style: "", character_description: "", voice_inclination: "en", character_images: [] }) as never;
        }
        if (table === "video_generation_jobs") {
          return makeChain({ status: "processing", error_message: null }) as never;
        }
        return makeChain({}) as never;
      });

      const { generateOpenRouterVideo } = await import("../services/openrouterVideo.js");
      const { generateAtlasCloudSeedance } = await import("../services/atlasCloudSeedance.js");

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await handleCinematicVideo("job-rung1-success", makePayload({ sceneIndex: 0 }), "user-1").catch(() => {});

      expect(generateOpenRouterVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "bytedance/seedance-1-5-pro",
          resolution: "480p",
          duration: 10,
          pollMaxMs: 4 * 60 * 1000,
        }),
      );
      expect(generateAtlasCloudSeedance).not.toHaveBeenCalled();
    });

    it("cascades to AtlasCloud when OpenRouter Seedance returns null videoUrl", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "generations") {
          return makeChain({ scenes: [{ imageUrl: "https://cdn.test/img.jpg", visualPrompt: "x" }] }) as never;
        }
        if (table === "projects") {
          return makeChain({ format: "landscape", style: "realistic" }) as never;
        }
        if (table === "video_generation_jobs") {
          return makeChain({ status: "processing", error_message: null }) as never;
        }
        return makeChain({}) as never;
      });

      const { generateOpenRouterVideo } = await import("../services/openrouterVideo.js");
      vi.mocked(generateOpenRouterVideo).mockResolvedValueOnce({
        videoUrl: null, provider: "openrouter", model: "bytedance/seedance-1-5-pro",
        error: "submit 502",
      });

      const { generateAtlasCloudSeedance } = await import("../services/atlasCloudSeedance.js");

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await handleCinematicVideo("job-rung1-fail", makePayload({ sceneIndex: 0 }), "user-1").catch(() => {});

      expect(generateOpenRouterVideo).toHaveBeenCalled();
      expect(generateAtlasCloudSeedance).toHaveBeenCalled();
    });
  });

  describe("provider chain — rung 3 (OpenRouter Kling Video O1)", () => {
    it("cascades through rung 1 -> 2 -> 3 when both upstream rungs fail", async () => {
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "generations") {
          return makeChain({ scenes: [{ imageUrl: "https://cdn.test/img.jpg", visualPrompt: "x" }] }) as never;
        }
        if (table === "projects") {
          return makeChain({ format: "landscape", style: "realistic" }) as never;
        }
        if (table === "video_generation_jobs") {
          return makeChain({ status: "processing", error_message: null }) as never;
        }
        return makeChain({}) as never;
      });

      const { generateOpenRouterVideo } = await import("../services/openrouterVideo.js");
      // First call (rung 1) fails; second call (rung 3) succeeds.
      vi.mocked(generateOpenRouterVideo)
        .mockResolvedValueOnce({
          videoUrl: null, provider: "openrouter", model: "bytedance/seedance-1-5-pro",
          error: "rung 1 submit 502",
        })
        .mockResolvedValueOnce({
          videoUrl: "https://or.test/kling-o1.mp4",
          provider: "openrouter", model: "kwaivgi/kling-video-o1",
          durationSeconds: 10, cost: 1.12,
        });

      const { generateAtlasCloudSeedance } = await import("../services/atlasCloudSeedance.js");
      vi.mocked(generateAtlasCloudSeedance).mockResolvedValueOnce({
        videoUrl: null, provider: "atlascloud", model: "bytedance/seedance-2.0/image-to-video",
        error: "atlas timed out",
      });

      const { generateKlingV3ProVideo } = await import("../services/hypereal.js");

      const { handleCinematicVideo } = await import("./handleCinematicVideo.js");
      await handleCinematicVideo("job-rung3", makePayload({ sceneIndex: 0 }), "user-1").catch(() => {});

      // Rung 1 + rung 3 both called on OpenRouter; AtlasCloud called once; Hypereal Kling NOT called.
      expect(vi.mocked(generateOpenRouterVideo).mock.calls).toHaveLength(2);
      expect(vi.mocked(generateOpenRouterVideo).mock.calls[1][0]).toEqual(
        expect.objectContaining({
          model: "kwaivgi/kling-video-o1",
          resolution: "480p",
          duration: 10,
          pollMaxMs: 4 * 60 * 1000,
        }),
      );
      expect(generateAtlasCloudSeedance).toHaveBeenCalledTimes(1);
      expect(generateKlingV3ProVideo).not.toHaveBeenCalled();
    });
  });
});
