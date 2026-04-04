/// <reference types="vitest/globals" />
import { classifyError, extractErrorMessage, toSafeMessage } from "../appErrors";

// ───────────────────────────────────────────────
// Auth error classification
// ───────────────────────────────────────────────
describe("classifyError — auth errors", () => {
  it("classifies JWT expired as auth", () => {
    const result = classifyError(new Error("JWT expired"));
    expect(result.category).toBe("auth");
  });

  it("classifies invalid token as auth", () => {
    const result = classifyError(new Error("Invalid login credentials"));
    expect(result.category).toBe("auth");
  });

  it("classifies session expired as auth", () => {
    const result = classifyError(new Error("session expired"));
    expect(result.category).toBe("auth");
  });
});

// ───────────────────────────────────────────────
// Network error classification
// ───────────────────────────────────────────────
describe("classifyError — network errors", () => {
  it("classifies Failed to fetch as network", () => {
    const result = classifyError(new Error("Failed to fetch"));
    expect(result.category).toBe("network");
  });

  it("classifies timeout as network", () => {
    const result = classifyError(new Error("Request timed out: timeout"));
    expect(result.category).toBe("network");
  });

  it("classifies ECONNREFUSED as network", () => {
    const result = classifyError(new Error("connect ECONNREFUSED"));
    expect(result.category).toBe("network");
  });
});

// ───────────────────────────────────────────────
// Safe message generation
// ───────────────────────────────────────────────
describe("toSafeMessage", () => {
  it("does not leak internal error details to users", () => {
    const msg = toSafeMessage(new Error("relation \"users\" does not exist"));
    // Should not contain SQL details
    expect(msg).not.toContain("relation");
    expect(msg).not.toContain("users");
  });

  it("returns a friendly message for network errors", () => {
    const msg = toSafeMessage(new Error("Failed to fetch"));
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.length).toBeLessThan(200);
  });
});

// ───────────────────────────────────────────────
// extractErrorMessage edge cases
// ───────────────────────────────────────────────
describe("extractErrorMessage — edge cases", () => {
  it("handles null", () => {
    const msg = extractErrorMessage(null);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("handles undefined", () => {
    const msg = extractErrorMessage(undefined);
    expect(typeof msg).toBe("string");
  });

  it("handles object with message property", () => {
    const msg = extractErrorMessage({ message: "custom error" });
    expect(msg).toBe("custom error");
  });

  it("handles plain object without message", () => {
    const err = { code: "PGRST301", details: "some detail" };
    const msg = extractErrorMessage(err);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("handles number input", () => {
    const msg = extractErrorMessage(42);
    expect(typeof msg).toBe("string");
  });
});
