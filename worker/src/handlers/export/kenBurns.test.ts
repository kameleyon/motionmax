import { describe, it, expect } from "vitest";
import { getTargetResolution } from "./kenBurns.js";

describe("getTargetResolution", () => {
  it("defaults to 1080p when is4K is omitted — existing call sites unchanged", () => {
    expect(getTargetResolution("landscape")).toEqual({ width: 1920, height: 1080 });
    expect(getTargetResolution("portrait")).toEqual({ width: 1080, height: 1920 });
    expect(getTargetResolution("square")).toEqual({ width: 1080, height: 1080 });
  });

  it("treats an unknown format as landscape", () => {
    expect(getTargetResolution("banana")).toEqual({ width: 1920, height: 1080 });
    expect(getTargetResolution("banana", true)).toEqual({ width: 3840, height: 2160 });
  });

  it("returns UHD dimensions when is4K is true", () => {
    expect(getTargetResolution("landscape", true)).toEqual({ width: 3840, height: 2160 });
    expect(getTargetResolution("portrait", true)).toEqual({ width: 2160, height: 3840 });
    expect(getTargetResolution("square", true)).toEqual({ width: 2160, height: 2160 });
  });

  it("stays 1080p when is4K is explicitly false", () => {
    expect(getTargetResolution("landscape", false)).toEqual({ width: 1920, height: 1080 });
  });

  it("preserves aspect ratio across the 4K jump", () => {
    for (const format of ["landscape", "portrait", "square"]) {
      const hd = getTargetResolution(format);
      const uhd = getTargetResolution(format, true);
      expect(uhd.width / uhd.height).toBeCloseTo(hd.width / hd.height, 5);
    }
  });

  it("doubles each axis, giving 4x the pixel count", () => {
    for (const format of ["landscape", "portrait", "square"]) {
      const hd = getTargetResolution(format);
      const uhd = getTargetResolution(format, true);
      expect(uhd.width).toBe(hd.width * 2);
      expect(uhd.height).toBe(hd.height * 2);
    }
  });

  it("keeps every dimension even — x264 yuv420p cannot encode odd dimensions", () => {
    for (const format of ["landscape", "portrait", "square"]) {
      for (const is4K of [false, true]) {
        const { width, height } = getTargetResolution(format, is4K);
        expect(width % 2).toBe(0);
        expect(height % 2).toBe(0);
      }
    }
  });
});
