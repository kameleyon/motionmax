import { describe, it, expect } from "vitest";
import { openRouterVideoCostUsd, PROVIDER_RATES_USD } from "./providerRates.js";

describe("openRouterVideoCostUsd", () => {
  it("computes Seedance 1.5 Pro 480p cost as $0.13 for 10s", () => {
    const cost = openRouterVideoCostUsd("bytedance/seedance-1-5-pro", "480p", 10);
    expect(cost).toBeCloseTo(0.13, 2);
  });

  it("computes Seedance 1.5 Pro 720p cost as $0.26 for 10s", () => {
    const cost = openRouterVideoCostUsd("bytedance/seedance-1-5-pro", "720p", 10);
    expect(cost).toBeCloseTo(0.26, 2);
  });

  it("computes Seedance 1.5 Pro 1080p cost as $0.58 for 10s", () => {
    const cost = openRouterVideoCostUsd("bytedance/seedance-1-5-pro", "1080p", 10);
    expect(cost).toBeCloseTo(0.58, 2);
  });

  it("computes Kling Video O1 cost as $1.12 for 10s (resolution-free)", () => {
    expect(openRouterVideoCostUsd("kwaivgi/kling-video-o1", "480p",  10)).toBeCloseTo(1.12, 2);
    expect(openRouterVideoCostUsd("kwaivgi/kling-video-o1", "720p",  10)).toBeCloseTo(1.12, 2);
    expect(openRouterVideoCostUsd("kwaivgi/kling-video-o1", "1080p", 10)).toBeCloseTo(1.12, 2);
  });

  it("clamps negative seconds to zero", () => {
    expect(openRouterVideoCostUsd("bytedance/seedance-1-5-pro", "480p", -3)).toBe(0);
  });

  it("exposes the new keys on PROVIDER_RATES_USD", () => {
    expect(PROVIDER_RATES_USD.openrouter_seedance_1_5_pro).toBeDefined();
    expect(PROVIDER_RATES_USD.openrouter_kling_video_o1).toBeDefined();
  });
});
