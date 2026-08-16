import { describe, it, expect, afterEach } from "vitest";
import { x264MemFlags, X264_MEM_FLAGS } from "./ffmpegCmd.js";

/** Read the value following a flag, e.g. threadsOf(["-threads","4"]) === "4". */
function valueAfter(flags: string[], flag: string): string | undefined {
  const i = flags.indexOf(flag);
  return i >= 0 ? flags[i + 1] : undefined;
}

describe("x264MemFlags", () => {
  afterEach(() => {
    delete process.env.X264_THREADS;
  });

  it("uses 2 threads at 1080p — the calibrated 1080p working set", () => {
    expect(valueAfter(x264MemFlags(1080), "-threads")).toBe("2");
  });

  it("defaults to 1080p behaviour when height is omitted", () => {
    expect(x264MemFlags()).toEqual(x264MemFlags(1080));
  });

  it("raises threads at 4K so per-scene encodes don't blow the timeout", () => {
    expect(valueAfter(x264MemFlags(2160), "-threads")).toBe("4");
  });

  it("keeps -x264-params threads in sync with the -threads flag", () => {
    for (const height of [1080, 2160]) {
      const flags = x264MemFlags(height);
      const threads = valueAfter(flags, "-threads");
      expect(valueAfter(flags, "-x264-params")).toBe(`rc-lookahead=0:threads=${threads}`);
    }
  });

  it("honours the X264_THREADS override at every resolution", () => {
    process.env.X264_THREADS = "8";
    expect(valueAfter(x264MemFlags(1080), "-threads")).toBe("8");
    expect(valueAfter(x264MemFlags(2160), "-threads")).toBe("8");
    expect(valueAfter(x264MemFlags(2160), "-x264-params")).toBe("rc-lookahead=0:threads=8");
  });

  it("ignores a non-numeric or non-positive override", () => {
    for (const bad of ["", "abc", "0", "-4"]) {
      process.env.X264_THREADS = bad;
      expect(valueAfter(x264MemFlags(1080), "-threads")).toBe("2");
    }
  });

  it("preserves the memory-safety flags that aren't thread-related", () => {
    const flags = x264MemFlags(2160);
    expect(valueAfter(flags, "-refs")).toBe("1");
    expect(valueAfter(flags, "-rc-lookahead")).toBe("0");
    expect(valueAfter(flags, "-bf")).toBe("0");
    expect(valueAfter(flags, "-g")).toBe("24");
  });

  it("keeps X264_MEM_FLAGS identical to the pre-4K flag set", () => {
    expect(X264_MEM_FLAGS).toEqual([
      "-threads", "2",
      "-refs", "1",
      "-rc-lookahead", "0",
      "-g", "24",
      "-bf", "0",
      "-x264-params", "rc-lookahead=0:threads=2",
    ]);
  });
});
