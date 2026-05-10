// Deno unit tests for cors.ts — origin allowlist and CORS header logic.
// See B-NEW-3 / Shield S-003: ACAO header MUST be omitted (not silently
// reflected to a "safe" origin) when the request origin is not allowed.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { getCorsHeaders, handleCorsPreflightRequest, isOriginAllowed } from "./cors.ts";

// ─── getCorsHeaders ───────────────────────────────────────────────────────────

Deno.test("getCorsHeaders: omits ACAO when no request origin is given", () => {
  const headers = getCorsHeaders(null);
  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  // Vary: Origin must always be set so caches don't mix responses.
  assertEquals(headers["Vary"], "Origin");
});

Deno.test("getCorsHeaders: reflects allowed origin from the dev allowlist", () => {
  const headers = getCorsHeaders("http://localhost:5173");
  assertEquals(headers["Access-Control-Allow-Origin"], "http://localhost:5173");
  assertEquals(headers["Vary"], "Origin");
});

Deno.test("getCorsHeaders: localhost:3000 is also in the dev allowlist", () => {
  const headers = getCorsHeaders("http://localhost:3000");
  assertEquals(headers["Access-Control-Allow-Origin"], "http://localhost:3000");
});

Deno.test("getCorsHeaders: rejects an unknown origin by omitting ACAO", () => {
  const headers = getCorsHeaders("https://evil.example.com");
  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  assertEquals(headers["Vary"], "Origin");
});

Deno.test("getCorsHeaders: allows valid Vercel preview subdomain", () => {
  const previewOrigin = "https://motionmax-pr-123.vercel.app";
  const headers = getCorsHeaders(previewOrigin);
  assertEquals(headers["Access-Control-Allow-Origin"], previewOrigin);
});

Deno.test("getCorsHeaders: rejects Vercel-looking origin without correct prefix", () => {
  const malicious = "https://notmotionmax-pr-1.vercel.app";
  const headers = getCorsHeaders(malicious);
  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
});

Deno.test("getCorsHeaders: always includes required CORS headers", () => {
  const headers = getCorsHeaders(null);
  assertNotEquals(headers["Access-Control-Allow-Headers"], undefined);
  assertNotEquals(headers["Access-Control-Allow-Methods"], undefined);
  assertEquals(headers["Access-Control-Max-Age"], "86400");
  assertEquals(headers["Vary"], "Origin");
});

// ─── isOriginAllowed ──────────────────────────────────────────────────────────

Deno.test("isOriginAllowed: dev defaults include localhost:8080, 5173, 3000", () => {
  assertEquals(isOriginAllowed("http://localhost:8080"), true);
  assertEquals(isOriginAllowed("http://localhost:5173"), true);
  assertEquals(isOriginAllowed("http://localhost:3000"), true);
});

Deno.test("isOriginAllowed: rejects empty / wildcard origins", () => {
  assertEquals(isOriginAllowed(""), false);
  assertEquals(isOriginAllowed("*"), false);
});

// ─── handleCorsPreflightRequest ───────────────────────────────────────────────

Deno.test("handleCorsPreflightRequest: returns 204 with CORS headers for allowed origin", async () => {
  const response = handleCorsPreflightRequest("http://localhost:5173");
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:5173");
  assertEquals(response.headers.get("Vary"), "Origin");
  // Body should be empty
  const text = await response.text();
  assertEquals(text, "");
});

Deno.test("handleCorsPreflightRequest: null origin returns 403 with ACAO omitted", () => {
  const response = handleCorsPreflightRequest(null);
  assertEquals(response.status, 403);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  assertEquals(response.headers.get("Vary"), "Origin");
});

Deno.test("handleCorsPreflightRequest: disallowed origin returns 403", () => {
  const response = handleCorsPreflightRequest("https://evil.example.com");
  assertEquals(response.status, 403);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
});
