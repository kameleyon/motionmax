import { describe, it, expect } from "vitest";
import { isTransientError } from "./retryClassifier.js";

describe("isTransientError — Supabase storage→DB connection blips", () => {
  // The exact production messages that were failing whole jobs (cinematic_video
  // upload + audio upload) before these patterns were added.
  it("classifies storage→DB connection timeouts as transient (retryable)", () => {
    for (const msg of [
      "Upload failed: The connection to the database timed out",
      "Audio upload failed: The connection to the database timed out",
      "The connection to the database timed out",
      "timeout exceeded when trying to connect",
      "remaining connection slots are reserved for non-replication superuser connections",
      "too many connections for role",
      "Max client connections reached",
    ]) {
      expect(isTransientError(new Error(msg))).toBe(true);
    }
  });

  it("still treats genuine permanent errors as NON-transient", () => {
    for (const msg of [
      "Invalid API key",
      "row violates row-level security policy",
      "duplicate key value violates unique constraint",
    ]) {
      expect(isTransientError(new Error(msg))).toBe(false);
    }
  });
});
