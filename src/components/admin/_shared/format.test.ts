import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRel, money, money4, num, short, weekly } from "./format";

describe("formatRel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatRel(new Date(Date.now() - 30_000))).toBe("just now");
  });

  it("returns 'Nm ago' under an hour", () => {
    expect(formatRel(new Date(Date.now() - 5 * 60_000))).toBe("5m ago");
  });

  it("returns 'Nh ago' under a day", () => {
    expect(formatRel(new Date(Date.now() - 3 * 60 * 60_000))).toBe("3h ago");
  });

  it("returns 'Nd ago' under a week", () => {
    expect(formatRel(new Date(Date.now() - 4 * 24 * 60 * 60_000))).toBe("4d ago");
  });

  it("returns 'Mon DD' once a week or older", () => {
    // 2024-01-15 vs 2024-01-30 — 15 days back -> 'Jan 15'
    vi.setSystemTime(new Date("2024-01-30T12:00:00Z"));
    expect(formatRel(new Date("2024-01-15T12:00:00Z"))).toBe("Jan 15");
  });

  it("accepts ISO strings", () => {
    expect(formatRel(new Date(Date.now() - 30_000).toISOString())).toBe("just now");
  });
});

describe("money / money4 / num / short", () => {
  it("formats money to 2 decimals with thousands separator", () => {
    expect(money(28420)).toBe("$28,420.00");
    expect(money(0)).toBe("$0.00");
    expect(money(1234567.89)).toBe("$1,234,567.89");
  });

  it("formats money4 to 4 decimals", () => {
    expect(money4(0.01184)).toBe("$0.0118");
    expect(money4(0)).toBe("$0.0000");
  });

  it("num formats integers with separators", () => {
    expect(num(1_500_000)).toBe("1,500,000");
    expect(num(0)).toBe("0");
  });

  it("short collapses thousands and millions", () => {
    expect(short(1_500_000)).toBe("1.5M");
    expect(short(1_500)).toBe("1.5k");
    expect(short(142)).toBe("142");
    expect(short(0)).toBe("0");
  });
});

describe("weekly", () => {
  it("is deterministic for the same inputs", () => {
    expect(weekly(100)).toEqual(weekly(100));
  });

  it("respects len + base", () => {
    const w = weekly(1000, 0, 7);
    expect(w).toHaveLength(7);
    // jitter=0 -> every value is exactly base
    expect(w.every((v) => v === 1000)).toBe(true);
  });
});
