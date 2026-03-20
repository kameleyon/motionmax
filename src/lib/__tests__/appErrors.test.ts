/// <reference types="vitest/globals" />
import {
  extractErrorMessage,
  classifyError,
  toSafeMessage,
} from "../appErrors";

describe("extractErrorMessage", () => {
  it("extracts message from Error object", () => {
    expect(extractErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("returns string errors as-is", () => {
    expect(extractErrorMessage("plain string")).toBe("plain string");
  });

  it("extracts message from object with message property", () => {
    expect(extractErrorMessage({ message: "obj error" })).toBe("obj error");
  });

  it("returns fallback for null/undefined", () => {
    expect(extractErrorMessage(null)).toBe("An unexpected error occurred");
    expect(extractErrorMessage(undefined)).toBe("An unexpected error occurred");
  });

  it("returns fallback for numbers", () => {
    expect(extractErrorMessage(42)).toBe("An unexpected error occurred");
  });
});

describe("classifyError", () => {
  it("classifies network errors", () => {
    const result = classifyError(new Error("Failed to fetch"));
    expect(result.category).toBe("network");
    expect(result.message).toContain("Connection lost");
  });

  it("classifies timeout errors as network", () => {
    const result = classifyError(new Error("Request timeout"));
    expect(result.category).toBe("network");
  });

  it("classifies auth errors from message patterns", () => {
    const result = classifyError(new Error("JWT expired"));
    expect(result.category).toBe("auth");
  });

  it("classifies invalid login credentials", () => {
    const result = classifyError(new Error("Invalid login credentials"));
    expect(result.category).toBe("auth");
    expect(result.message).toBe("Invalid email or password.");
  });

  it("classifies database constraint errors", () => {
    const result = classifyError(new Error("duplicate key value violates unique constraint"));
    expect(result.category).toBe("database");
    expect(result.message).toContain("conflicts");
  });

  it("classifies validation errors (passes through message)", () => {
    const result = classifyError(new Error("Email is required"));
    expect(result.category).toBe("validation");
    expect(result.message).toBe("Email is required");
  });

  it("classifies unknown errors safely", () => {
    const result = classifyError(new Error("some random error"));
    expect(result.category).toBe("unknown");
    expect(result.message).toBe("Something went wrong. Please try again.");
    expect(result.technical).toBe("some random error");
  });
});

describe("toSafeMessage", () => {
  it("returns user-friendly message for network errors", () => {
    expect(toSafeMessage(new Error("Failed to fetch"))).toContain("Connection lost");
  });

  it("returns safe message for unknown errors", () => {
    expect(toSafeMessage(null)).toBe("Something went wrong. Please try again.");
  });

  it("returns auth message for expired tokens", () => {
    const msg = toSafeMessage(new Error("JWT expired"));
    expect(msg).toContain("Session expired");
  });
});
