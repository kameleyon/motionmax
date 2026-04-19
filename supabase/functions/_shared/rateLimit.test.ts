// Deno unit tests for rateLimit.ts — rate limiting logic and fail-closed behavior.
import { assertEquals, assertMatch } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { checkRateLimit, getRateLimitHeaders, PRIVILEGED_ROUTES } from "./rateLimit.ts";

// ─── Supabase mock factory ─────────────────────────────────────────────────────

interface FromResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

function makeSupabaseMock(opts: {
  selectResult?: FromResult;
  insertFail?: boolean;
} = {}) {
  const calls: { table: string; op: string }[] = [];

  const supabase = {
    from: (table: string) => ({
      select: (_fields: string) => ({
        eq: (_col: string, _val: unknown) => ({
          gte: (_col2: string, _val2: unknown) => ({
            order: (_col3: string, _opts: unknown) =>
              Promise.resolve(
                opts.selectResult ?? { data: [], error: null }
              ),
          }),
        }),
      }),
      insert: (row: unknown) => {
        calls.push({ table, op: "insert" });
        void row;
        return Promise.resolve(opts.insertFail
          ? { error: { message: "insert failed" } }
          : { error: null });
      },
    }),
    calls,
  };

  // deno-lint-ignore no-explicit-any
  return supabase as any;
}

// ─── PRIVILEGED_ROUTES ────────────────────────────────────────────────────────

Deno.test("PRIVILEGED_ROUTES: includes financial and destructive routes", () => {
  const required = [
    "create-checkout",
    "customer-portal",
    "delete-account",
    "generate-video",
    "generate-cinematic",
    "clone-voice",
  ];
  for (const route of required) {
    assertEquals(
      PRIVILEGED_ROUTES.includes(route),
      true,
      `Expected ${route} in PRIVILEGED_ROUTES`,
    );
  }
});

// ─── checkRateLimit — allowed path ───────────────────────────────────────────

Deno.test("checkRateLimit: allows request when under the limit", async () => {
  const mock = makeSupabaseMock({ selectResult: { data: [], error: null } });
  const result = await checkRateLimit(mock, {
    key: "test-endpoint",
    maxRequests: 10,
    windowSeconds: 60,
    userId: "user-1",
    ip: "1.2.3.4",
  });

  assertEquals(result.allowed, true);
  assertEquals(result.remaining, 9);
});

Deno.test("checkRateLimit: tracks composite user+ip key", async () => {
  const mock = makeSupabaseMock({ selectResult: { data: [], error: null } });
  await checkRateLimit(mock, {
    key: "export-data",
    maxRequests: 5,
    windowSeconds: 300,
    userId: "u1",
    ip: "10.0.0.1",
  });
  assertEquals(mock.calls.filter((c: { table: string; op: string }) => c.op === "insert").length, 1);
});

Deno.test("checkRateLimit: blocks when request count equals maxRequests", async () => {
  const now = new Date().toISOString();
  const existingRequests = Array.from({ length: 5 }, (_, i) => ({
    id: `req-${i}`,
    created_at: now,
  }));
  const mock = makeSupabaseMock({
    selectResult: { data: existingRequests, error: null },
  });

  const result = await checkRateLimit(mock, {
    key: "test-endpoint",
    maxRequests: 5,
    windowSeconds: 60,
    userId: "user-limited",
  });

  assertEquals(result.allowed, false);
  assertEquals(result.remaining, 0);
});

// ─── checkRateLimit — fail-closed for privileged routes ──────────────────────

Deno.test("checkRateLimit: fail-closed on DB error for privileged route", async () => {
  const mock = makeSupabaseMock({
    selectResult: { data: null, error: { message: "connection refused" } },
  });

  const result = await checkRateLimit(mock, {
    key: "create-checkout",
    maxRequests: 20,
    windowSeconds: 60,
    userId: "user-1",
  });

  assertEquals(result.allowed, false);
  assertMatch(result.error ?? "", /unavailable/i);
});

Deno.test("checkRateLimit: fail-open on DB error for non-privileged route", async () => {
  const mock = makeSupabaseMock({
    selectResult: { data: null, error: { message: "connection refused" } },
  });

  const result = await checkRateLimit(mock, {
    key: "some-public-endpoint",
    maxRequests: 20,
    windowSeconds: 60,
    userId: "user-1",
    privileged: false,
  });

  assertEquals(result.allowed, true);
});

// ─── getRateLimitHeaders ──────────────────────────────────────────────────────

Deno.test("getRateLimitHeaders: returns standard rate limit headers", () => {
  const resetAt = new Date(Date.now() + 60_000);
  const headers = getRateLimitHeaders({
    allowed: true,
    remaining: 4,
    resetAt,
  });

  assertEquals(headers["X-RateLimit-Remaining"], "4");
  assertEquals(headers["X-RateLimit-Reset"], resetAt.toISOString());
  assertMatch(headers["X-RateLimit-Limit"], /^\d+$/);
});

Deno.test("getRateLimitHeaders: remaining=0 when request was denied", () => {
  const headers = getRateLimitHeaders({
    allowed: false,
    remaining: 0,
    resetAt: new Date(),
  });
  assertEquals(headers["X-RateLimit-Remaining"], "0");
});
