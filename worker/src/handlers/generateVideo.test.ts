/**
 * Tests for the generate video handler (worker/src/handlers/generateVideo.ts).
 *
 * Covers:
 *  1. LLM (OpenRouter/Hypereal) failure → handler throws, credits are refunded
 *     by the processJob wrapper in index.ts.
 *  2. DB project insert failure → handler throws.
 *  3. DB generation insert failure → handler throws.
 *  4. Successful execution → returns a result with projectId and generationId.
 *
 * Note on credit deduction: MotionMax deducts credits on the frontend before
 * enqueuing a job. The worker's generateVideo handler never deducts credits
 * itself; it throws on any failure so that the processJob wrapper in index.ts
 * can call refundCreditsOnFailure. The refund contract is tested separately in
 * refundCreditsOnFailure.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// OpenRouter LLM service: default returns a valid JSON script string.
vi.mock("../services/openrouter.js", () => ({
  buildDoc2VideoPrompt: vi.fn().mockReturnValue({
    system: "You are a video script writer",
    user: "Write a script about dogs",
    maxTokens: 2000,
  }),
  buildSmartFlowPrompt: vi.fn().mockReturnValue({
    system: "You are a smartflow writer",
    user: "Write a script",
    maxTokens: 2000,
  }),
  buildCinematicPrompt: vi.fn().mockReturnValue({
    system: "You are a cinematic writer",
    user: "Write a cinematic script",
    maxTokens: 2000,
  }),
  callOpenRouterLLM: vi.fn(),
  callLLMWithFallback: vi.fn().mockResolvedValue(
    JSON.stringify({
      title: "Test Video",
      scenes: [
        { number: 1, voiceover: "Welcome to our video about technology.", visualPrompt: "A futuristic cityscape" },
        { number: 2, voiceover: "Today we explore innovation.", visualPrompt: "Engineers working on computers" },
      ],
    })
  ),
}));

// Prompts service
vi.mock("../services/prompts.js", () => ({
  getStylePrompt: vi.fn().mockReturnValue("realistic style, cinematic lighting"),
  extractJsonFromLLMResponse: vi.fn().mockImplementation((text: string) => JSON.parse(text)),
}));

// Research topic: returns empty string (no extra context injected)
vi.mock("../services/researchTopic.js", () => ({
  researchTopic: vi.fn().mockResolvedValue(""),
}));

// Attachment processing: pass-through
vi.mock("../services/processAttachments.js", () => ({
  processContentAttachments: vi.fn().mockImplementation((content: string) => Promise.resolve(content)),
}));

// Scene post-processor: minimal transform
vi.mock("./sceneProcessor.js", () => ({
  postProcessScenes: vi.fn().mockImplementation((parsed: any) => ({
    scenes: (parsed.scenes || []).map((s: any, i: number) => ({
      number: i + 1,
      voiceover: s.voiceover || "",
      visualPrompt: s.visualPrompt || "",
      duration: 11,
      imageCount: 1,
    })),
    totalImages: (parsed.scenes || []).length,
    title: parsed.title || "Untitled",
  })),
}));

// ── Fluent Supabase chain builder ─────────────────────────────────────────────

function makeSuccessChain(returnData: unknown) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: returnData, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: returnData, error: null }),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return chain;
}

function makeErrorChain(errorMessage: string) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: { message: errorMessage } }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: errorMessage } }),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return chain;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    projectType: "doc2video",
    content: "A short video about technology trends in 2025.",
    format: "landscape",
    length: "brief",
    style: "realistic",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleGenerateVideo", () => {
  beforeEach(async () => {
    // clearAllMocks resets call history but PRESERVES mock implementations.
    // resetAllMocks would wipe the implementations set in vi.mock() factories,
    // causing prompt builders to return undefined and crash on .maxTokens access.
    vi.clearAllMocks();

    // Re-establish the default resolved values that clearAllMocks may reset.
    const { callLLMWithFallback, buildDoc2VideoPrompt, buildSmartFlowPrompt, buildCinematicPrompt } =
      await import("../services/openrouter.js");

    vi.mocked(callLLMWithFallback).mockResolvedValue(
      JSON.stringify({
        title: "Default Test Video",
        scenes: [
          { number: 1, voiceover: "Default voiceover text.", visualPrompt: "Default visual prompt" },
        ],
      })
    );
    vi.mocked(buildDoc2VideoPrompt).mockReturnValue({ system: "sys", user: "usr", maxTokens: 2000 });
    vi.mocked(buildSmartFlowPrompt).mockReturnValue({ system: "sys", user: "usr", maxTokens: 2000 });
    vi.mocked(buildCinematicPrompt).mockReturnValue({ system: "sys", user: "usr", maxTokens: 2000 });

    const { extractJsonFromLLMResponse } = await import("../services/prompts.js");
    vi.mocked(extractJsonFromLLMResponse).mockImplementation((text: string) => JSON.parse(text));

    const { postProcessScenes } = await import("./sceneProcessor.js");
    vi.mocked(postProcessScenes).mockImplementation((parsed: any) => ({
      scenes: (parsed.scenes || []).map((s: any, i: number) => ({
        number: i + 1,
        voiceover: s.voiceover || "",
        visualPrompt: s.visualPrompt || "",
        duration: 11,
        imageCount: 1,
      })),
      totalImages: (parsed.scenes || []).length,
      title: parsed.title || "Untitled",
    }));

    const { writeSystemLog } = await import("../lib/logger.js");
    vi.mocked(writeSystemLog).mockResolvedValue(undefined);

    const { researchTopic } = await import("../services/researchTopic.js");
    vi.mocked(researchTopic).mockResolvedValue("");
  });

  // ── 1. LLM failure → handler throws ──────────────────────────────────────────
  describe("LLM failure", () => {
    it("should throw when callLLMWithFallback rejects (simulating LLM outage)", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockRejectedValue(
        new Error("Both OpenRouter and Hypereal failed")
      );

      // DB progress updates succeed (jobs table)
      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(
        makeSuccessChain(null) as any
      );

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await expect(
        handleGenerateVideo("job-llm-fail", makePayload(), "user-llm")
      ).rejects.toThrow("Both OpenRouter and Hypereal failed");
    });

    it("should throw when LLM times out", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockRejectedValue(
        new Error("OpenRouter request timed out after 120s (model: gemini-2.0-flash, maxTokens: 2000)")
      );

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(makeSuccessChain(null) as any);

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await expect(
        handleGenerateVideo("job-llm-timeout", makePayload(), "user-timeout")
      ).rejects.toThrow(/timed out/i);
    });

    it("should throw when LLM returns non-parseable JSON", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue("this is not json at all ```");

      // extractJsonFromLLMResponse throws on bad JSON
      const { extractJsonFromLLMResponse } = await import("../services/prompts.js");
      vi.mocked(extractJsonFromLLMResponse).mockImplementation(() => {
        throw new Error("Failed to extract JSON from LLM response");
      });

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(makeSuccessChain(null) as any);

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await expect(
        handleGenerateVideo("job-bad-json", makePayload(), "user-json")
      ).rejects.toThrow(/JSON/i);
    });

    it("should throw when LLM returns empty scenes array and all transform paths fail", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({ title: "Empty", scenes: [] })
      );

      // postProcessScenes receives empty scenes — simulate downstream transform
      // raising an error when no content is usable.
      const { postProcessScenes } = await import("./sceneProcessor.js");
      vi.mocked(postProcessScenes).mockImplementation(() => {
        throw new Error("LLM returned no usable content for doc2video script");
      });

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockReturnValue(makeSuccessChain(null) as any);

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await expect(
        handleGenerateVideo("job-empty-scenes", makePayload(), "user-empty")
      ).rejects.toThrow(/no usable content/i);
    });
  });

  // ── 2. DB project insert failure → handler throws ─────────────────────────
  describe("project insert failure", () => {
    it("should throw when projects insert fails", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "Test",
          scenes: [{ number: 1, voiceover: "Hello", visualPrompt: "Wide shot of city" }],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      let callCount = 0;
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") {
          // projects insert fails
          return makeErrorChain("duplicate key value violates unique constraint") as any;
        }
        // video_generation_jobs progress updates succeed
        return makeSuccessChain(null) as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await expect(
        handleGenerateVideo("job-proj-fail", makePayload(), "user-proj")
      ).rejects.toThrow(/Failed to create project/);
    });
  });

  // ── 3. DB generation insert failure → handler throws ─────────────────────
  describe("generation insert failure", () => {
    it("should throw when generations insert fails after successful project insert", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "Test",
          scenes: [{ number: 1, voiceover: "Hello world", visualPrompt: "A bright landscape" }],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") {
          return makeSuccessChain({ id: "proj-new-uuid-123" }) as any;
        }
        if (table === "generations") {
          return makeErrorChain("foreign key constraint violation") as any;
        }
        // video_generation_jobs progress updates
        return makeSuccessChain(null) as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await expect(
        handleGenerateVideo("job-gen-fail", makePayload(), "user-gen")
      ).rejects.toThrow(/Failed to create generation/);
    });
  });

  // ── 4. Successful execution ────────────────────────────────────────────────
  describe("successful generation", () => {
    it("should return projectId and generationId on success", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "Tech Trends 2025",
          scenes: [
            { number: 1, voiceover: "The future is now.", visualPrompt: "A futuristic cityscape at night" },
            { number: 2, voiceover: "AI is transforming industries.", visualPrompt: "Data flowing through circuits" },
          ],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") {
          return makeSuccessChain({ id: "proj-success-uuid" }) as any;
        }
        if (table === "generations") {
          return makeSuccessChain({ id: "gen-success-uuid" }) as any;
        }
        // video_generation_jobs updates
        return makeSuccessChain(null) as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      const result = await handleGenerateVideo("job-success", makePayload(), "user-success");

      expect(result).toMatchObject({
        success: true,
        projectId: "proj-success-uuid",
        generationId: "gen-success-uuid",
      });
      expect(result.scenes).toBeDefined();
      expect(Array.isArray(result.scenes)).toBe(true);
    });

    it("should work when userId is undefined (anonymous generation)", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "Anon Video",
          scenes: [{ number: 1, voiceover: "Hello anon", visualPrompt: "Open road" }],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") return makeSuccessChain({ id: "proj-anon" }) as any;
        if (table === "generations") return makeSuccessChain({ id: "gen-anon" }) as any;
        return makeSuccessChain(null) as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      const result = await handleGenerateVideo("job-anon", makePayload(), undefined);

      expect(result).toMatchObject({ success: true, projectId: "proj-anon" });
    });

    it("should write job progress updates during generation", async () => {
      const { callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "Progress Test",
          scenes: [{ number: 1, voiceover: "Testing progress", visualPrompt: "Timer on screen" }],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      const updateChain = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ error: null }),
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { id: "proj-progress" }, error: null }),
      };

      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") return makeSuccessChain({ id: "proj-progress" }) as any;
        if (table === "generations") return makeSuccessChain({ id: "gen-progress" }) as any;
        return updateChain as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await handleGenerateVideo("job-progress", makePayload(), "user-progress");

      // video_generation_jobs must have been updated (progress tracking)
      const jobUpdateCalls = vi.mocked(supabase.from).mock.calls.filter(
        ([t]) => t === "video_generation_jobs"
      );
      expect(jobUpdateCalls.length).toBeGreaterThan(0);
    });
  });

  // ── 5. Smartflow project type ─────────────────────────────────────────────
  describe("smartflow project type", () => {
    it("should build smartflow prompt for smartflow projectType", async () => {
      const { buildSmartFlowPrompt, callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "SmartFlow Deck",
          scenes: [{ number: 1, voiceover: "Slide one content", visualPrompt: "Infographic design" }],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") return makeSuccessChain({ id: "proj-sf" }) as any;
        if (table === "generations") return makeSuccessChain({ id: "gen-sf" }) as any;
        return makeSuccessChain(null) as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await handleGenerateVideo(
        "job-smartflow",
        makePayload({ projectType: "smartflow" }),
        "user-sf"
      );

      expect(buildSmartFlowPrompt).toHaveBeenCalledOnce();
    });
  });

  // ── 6. Cinematic project type ─────────────────────────────────────────────
  describe("cinematic project type", () => {
    it("should build cinematic prompt for cinematic projectType", async () => {
      const { buildCinematicPrompt, callLLMWithFallback } = await import("../services/openrouter.js");
      vi.mocked(callLLMWithFallback).mockResolvedValue(
        JSON.stringify({
          title: "Epic Cinematic",
          scenes: [{ number: 1, voiceover: "An epic tale begins.", visualPrompt: "Mountain range at sunrise" }],
        })
      );

      const { supabase } = await import("../lib/supabase.js");
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "projects") return makeSuccessChain({ id: "proj-cin" }) as any;
        if (table === "generations") return makeSuccessChain({ id: "gen-cin" }) as any;
        return makeSuccessChain(null) as any;
      });

      const { handleGenerateVideo } = await import("./generateVideo.js");
      await handleGenerateVideo(
        "job-cinematic",
        makePayload({ projectType: "cinematic" }),
        "user-cin"
      );

      expect(buildCinematicPrompt).toHaveBeenCalledOnce();
    });
  });
});
