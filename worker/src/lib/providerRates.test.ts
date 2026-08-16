import { describe, it, expect } from "vitest";
import { openRouterVideoCostUsd, imageCostUsd, PROVIDER_RATES_USD } from "./providerRates.js";

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

describe("imageCostUsd — Nano-Banana Pro resolution tiers", () => {
  it("bills the 4K upres at $0.22, not the 1k rate", () => {
    expect(imageCostUsd("hypereal_nano_banana_pro", 1, "4k")).toBeCloseTo(0.22, 4);
  });

  it("leaves 1k and 2k on the base rate", () => {
    expect(imageCostUsd("hypereal_nano_banana_pro", 1, "1k")).toBeCloseTo(0.03, 4);
    expect(imageCostUsd("hypereal_nano_banana_pro", 1, "2k")).toBeCloseTo(0.03, 4);
  });

  it("defaults to the base rate so existing call sites are unchanged", () => {
    expect(imageCostUsd("hypereal_nano_banana_pro")).toBeCloseTo(0.03, 4);
    expect(imageCostUsd("hypereal_nano_banana_pro", 3)).toBeCloseTo(0.09, 4);
  });

  it("scales 4K cost by image count — a 10-scene export is $2.20", () => {
    expect(imageCostUsd("hypereal_nano_banana_pro", 10, "4k")).toBeCloseTo(2.20, 4);
  });

  it("ignores resolution for providers that aren't resolution-priced", () => {
    expect(imageCostUsd("hypereal_gpt_image2", 1, "4k")).toBeCloseTo(0.08, 4);
    expect(imageCostUsd("hypereal_image", 1, "4k")).toBeCloseTo(0.04, 4);
    expect(imageCostUsd("replicate_image", 1, "4k")).toBeCloseTo(0.05, 4);
  });

  it("keeps the 4K rate materially above the base rate — a flat card would understate spend", () => {
    const base = PROVIDER_RATES_USD.hypereal_nano_banana_pro.per_image;
    const uhd = PROVIDER_RATES_USD.hypereal_nano_banana_pro.per_image_4k;
    expect(uhd).toBeGreaterThan(base * 5);
  });
});
