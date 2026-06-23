import { describe, it, expect } from "vitest";
import { buildWebhookEvent, isPrivateIp, signWebhook } from "./webhookDelivery.js";

describe("buildWebhookEvent — public status from event type only (B3)", () => {
  it("succeeded → 'succeeded', ignoring any internal status in the result", () => {
    const ev = buildWebhookEvent({ id: "j1" }, "video.succeeded", {
      status: "complete", // internal token must NOT leak
      video_url: "https://x/v.mp4",
    });
    expect(ev.data.status).toBe("succeeded");
    expect(ev.type).toBe("video.succeeded");
    expect(ev.data.video_url).toBe("https://x/v.mp4");
  });

  it("failed → 'failed', ignoring internal status", () => {
    const ev = buildWebhookEvent({ id: "j2" }, "video.failed", {
      status: "generating",
      error: { code: "content_policy", message: "blocked" },
    });
    expect(ev.data.status).toBe("failed");
    expect(ev.data.error).toEqual({ code: "content_policy", message: "blocked" });
  });
});

describe("isPrivateIp — SSRF classifier (B5 core)", () => {
  it("flags private/loopback/link-local/metadata/CGNAT ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12::3",
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows public IPs", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe("signWebhook — stable HMAC-SHA256 hex", () => {
  it("is deterministic for the same secret+body and changes with either", () => {
    const a = signWebhook("secret", "{}");
    expect(a).toBe(signWebhook("secret", "{}"));
    expect(a).not.toBe(signWebhook("secret2", "{}"));
    expect(a).not.toBe(signWebhook("secret", "{ }"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
