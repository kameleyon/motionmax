// Deno unit tests for cors.ts — origin allowlist and CORS header logic.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { getCorsHeaders, handleCorsPreflightRequest } from "./cors.ts";

// ─── getCorsHeaders ───────────────────────────────────────────────────────────

Deno.test("getCorsHeaders: returns production origin when no request origin is given", () => {
  const headers = getCorsHeaders(null);
  assertEquals(headers["Access-Control-Allow-Origin"], "https://motionmax.io");
});

Deno.test("getCorsHeaders: reflects allowed origin from the allowlist", () => {
  const headers = getCorsHeaders("http://localhost:5173");
  assertEquals(headers["Access-Control-Allow-Origin"], "http://localhost:5173");
});

Deno.test("getCorsHeaders: rejects an unknown origin and falls back to production", () => {
  const headers = getCorsHeaders("https://evil.example.com");
  assertEquals(headers["Access-Control-Allow-Origin"], "https://motionmax.io");
});

Deno.test("getCorsHeaders: allows valid Vercel preview subdomain", () => {
  const previewOrigin = "https://motionmax-pr-123.vercel.app";
  const headers = getCorsHeaders(previewOrigin);
  assertEquals(headers["Access-Control-Allow-Origin"], previewOrigin);
});

Deno.test("getCorsHeaders: rejects Vercel-looking origin without correct prefix", () => {
  const malicious = "https://notmotionmax-pr-1.vercel.app";
  const headers = getCorsHeaders(malicious);
  assertEquals(headers["Access-Control-Allow-Origin"], "https://motionmax.io");
});

Deno.test("getCorsHeaders: uses ALLOWED_ORIGIN env var when set (for preview envs)", () => {
  Deno.env.set("ALLOWED_ORIGIN", "https://staging.motionmax.io");
  try {
    const headers = getCorsHeaders("https://evil.example.com");
    assertEquals(headers["Access-Control-Allow-Origin"], "https://staging.motionmax.io");
  } finally {
    Deno.env.delete("ALLOWED_ORIGIN");
  }
});

Deno.test("getCorsHeaders: ignores wildcard ALLOWED_ORIGIN env var, falls through to origin validation", () => {
  Deno.env.set("ALLOWED_ORIGIN", "*");
  try {
    const headers = getCorsHeaders("http://localhost:5173");
    // Wildcard env var is rejected; allowed origin reflects the allowlist match
    assertEquals(headers["Access-Control-Allow-Origin"], "http://localhost:5173");
  } finally {
    Deno.env.delete("ALLOWED_ORIGIN");
  }
});

Deno.test("getCorsHeaders: always includes required CORS headers", () => {
  const headers = getCorsHeaders(null);
  assertNotEquals(headers["Access-Control-Allow-Headers"], undefined);
  assertNotEquals(headers["Access-Control-Allow-Methods"], undefined);
  assertEquals(headers["Access-Control-Max-Age"], "86400");
});

// ─── handleCorsPreflightRequest ───────────────────────────────────────────────

Deno.test("handleCorsPreflightRequest: returns 204 with CORS headers", async () => {
  const response = handleCorsPreflightRequest("http://localhost:5173");
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173");
  // Body should be empty
  const text = await response.text();
  assertEquals(text, "");
});

Deno.test("handleCorsPreflightRequest: null origin gets production default", () => {
  const response = handleCorsPreflightRequest(null);
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "https://motionmax.io");
});
