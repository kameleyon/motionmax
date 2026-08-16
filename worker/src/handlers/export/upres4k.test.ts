import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/nanoBananaEdit.js", () => ({
  editImageWithNanoBanana: vi.fn(),
}));

import { upresScenesTo4K } from "./upres4k.js";
import { editImageWithNanoBanana } from "../../services/nanoBananaEdit.js";

const KEY = "test-hypereal-key";

describe("upresScenesTo4K", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(editImageWithNanoBanana).mockImplementation(
      async (url: string) => `${url}?upres=4k`,
    );
  });

  it("upscales every image-backed scene and reports the count", async () => {
    const result = await upresScenesTo4K(["a.png", "b.png"], "landscape", KEY);
    expect(result.urls).toEqual(["a.png?upres=4k", "b.png?upres=4k"]);
    expect(result.upscaled).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("always requests 4k resolution from the model", async () => {
    await upresScenesTo4K(["a.png"], "landscape", KEY);
    // Positional signature: (url, prompt, apiKey, aspectRatio, resolution, ...)
    expect(vi.mocked(editImageWithNanoBanana).mock.calls[0][4]).toBe("4k");
  });

  it("maps project format to the matching aspect ratio", async () => {
    await upresScenesTo4K(["a.png"], "portrait", KEY);
    expect(vi.mocked(editImageWithNanoBanana).mock.calls[0][3]).toBe("9:16");

    vi.clearAllMocks();
    vi.mocked(editImageWithNanoBanana).mockResolvedValue("x");
    await upresScenesTo4K(["a.png"], "square", KEY);
    expect(vi.mocked(editImageWithNanoBanana).mock.calls[0][3]).toBe("1:1");
  });

  it("falls back to the original URL when a single scene fails", async () => {
    vi.mocked(editImageWithNanoBanana).mockImplementation(async (url: string) => {
      if (url === "b.png") throw new Error("upstream 500");
      return `${url}?upres=4k`;
    });

    const result = await upresScenesTo4K(["a.png", "b.png", "c.png"], "landscape", KEY);
    expect(result.urls).toEqual(["a.png?upres=4k", "b.png", "c.png?upres=4k"]);
    expect(result.upscaled).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("never rejects, even when every call fails", async () => {
    vi.mocked(editImageWithNanoBanana).mockRejectedValue(new Error("provider down"));
    const result = await upresScenesTo4K(["a.png", "b.png"], "landscape", KEY);
    expect(result.urls).toEqual(["a.png", "b.png"]);
    expect(result.upscaled).toBe(0);
    expect(result.failed).toBe(2);
  });

  it("leaves video-backed and empty slots untouched and never pays for them", async () => {
    const result = await upresScenesTo4K(["a.png", "", null, undefined, "b.png"], "landscape", KEY);
    expect(result.urls).toEqual(["a.png?upres=4k", "", "", "", "b.png?upres=4k"]);
    expect(result.upscaled).toBe(2);
    expect(editImageWithNanoBanana).toHaveBeenCalledTimes(2);
  });

  it("skips the provider entirely when the API key is missing", async () => {
    const result = await upresScenesTo4K(["a.png"], "landscape", "");
    expect(editImageWithNanoBanana).not.toHaveBeenCalled();
    expect(result.urls).toEqual(["a.png"]);
    expect(result.upscaled).toBe(0);
  });

  it("makes no calls when there are no image-backed scenes", async () => {
    const result = await upresScenesTo4K(["", ""], "landscape", KEY);
    expect(editImageWithNanoBanana).not.toHaveBeenCalled();
    expect(result).toEqual({ urls: ["", ""], upscaled: 0, failed: 0 });
  });

  it("preserves scene order under concurrency", async () => {
    // Resolve in reverse order of invocation so a naive push-based
    // implementation would scramble the array.
    const delays: Record<string, number> = { "a.png": 30, "b.png": 20, "c.png": 10, "d.png": 0 };
    vi.mocked(editImageWithNanoBanana).mockImplementation(
      (url: string) =>
        new Promise((resolve) => setTimeout(() => resolve(`${url}?upres=4k`), delays[url] ?? 0)),
    );

    const result = await upresScenesTo4K(["a.png", "b.png", "c.png", "d.png"], "landscape", KEY);
    expect(result.urls).toEqual([
      "a.png?upres=4k", "b.png?upres=4k", "c.png?upres=4k", "d.png?upres=4k",
    ]);
  });

  it("caps in-flight calls at the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(editImageWithNanoBanana).mockImplementation(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return `${url}?upres=4k`;
    });

    await upresScenesTo4K(
      Array.from({ length: 9 }, (_, i) => `s${i}.png`),
      "landscape",
      KEY,
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("sends an instruction that introduces no scene content", async () => {
    await upresScenesTo4K(["a.png"], "landscape", KEY);
    const prompt = vi.mocked(editImageWithNanoBanana).mock.calls[0][1] as string;

    // The whole point of this module's prompt: it must describe an
    // operation, never a subject. Any noun here would render into every
    // 4K scene of every project.
    for (const leak of ["orangutan", "primate", "iron bars", "masonry", "forest", "city"]) {
      expect(prompt.toLowerCase()).not.toContain(leak);
    }
    expect(prompt).toMatch(/DO NOT CHANGE THE IMAGE/i);
    expect(prompt.toLowerCase()).toContain("preserve the composition");
  });

  it("threads attribution through to the provider for cost tracking", async () => {
    const attribution = { userId: "u1", generationId: "g1", jobId: "j1" };
    await upresScenesTo4K(["a.png"], "landscape", KEY, "proj-1", attribution);
    const call = vi.mocked(editImageWithNanoBanana).mock.calls[0];
    expect(call[5]).toBe("proj-1");
    expect(call[6]).toEqual(attribution);
  });
});
