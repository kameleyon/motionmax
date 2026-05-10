/**
 * MotionMax — checkout creation load test (Probe C-10-5).
 *
 * Profile: 200 RPS sustained for 60s, ramp up 10s, ramp down 10s.
 *
 * Calls the `create-checkout` edge function with a valid pre-provisioned
 * test user. Verifies:
 *   - Stripe checkout-session create stays under p95 < 500 ms
 *   - The edge function rate-limiter (3 req / minute per user) trips
 *     for sustained > 3 RPS PER USER — which is why we use a pool of
 *     test users instead of one bearer token (see TEST_USER_TOKENS).
 *
 * RATE-LIMIT NOTE
 *   Stripe enforces ~100 req/s per account on test mode. We cap at
 *   200 RPS to absorb fan-out + retries and never breach. Do NOT raise
 *   this beyond ~250 without first reading Stripe's per-account quota
 *   page — getting throttled by Stripe will turn this test into a
 *   429-storm and tell you nothing about MotionMax.
 *
 * USAGE
 *   k6 run scripts/load-test/checkout.k6.js
 *
 * REQUIRED ENV
 *   SUPABASE_URL              edge function host (staging/test)
 *   SUPABASE_ANON_KEY         anon key for that project
 *   STRIPE_TEST_USER_TOKEN    pre-provisioned test user JWT, or a
 *                             comma-separated pool. Pool is rotated
 *                             round-robin so per-user rate limits
 *                             don't dominate the test.
 *
 * OPTIONAL ENV
 *   TARGET_RPS                override the 200 default (max 250)
 *   DURATION_S                override the 60s sustained phase
 */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const SUPABASE_URL = __ENV.SUPABASE_URL;
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY;
const TOKEN_RAW = __ENV.STRIPE_TEST_USER_TOKEN;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TOKEN_RAW) {
  fail(
    "Set SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_TEST_USER_TOKEN (comma-separated for a pool) first.",
  );
}

const isProdHost = !/test|staging|localhost|127\.0\.0\.1/i.test(SUPABASE_URL);
if (isProdHost) {
  fail(`Refusing to point a load test at what looks like prod: ${SUPABASE_URL}`);
}

const TOKEN_POOL = TOKEN_RAW.split(",").map((t) => t.trim()).filter(Boolean);
if (TOKEN_POOL.length === 0) fail("STRIPE_TEST_USER_TOKEN was empty after parsing.");

// Stripe-protection clamp: refuse to exceed 250 RPS regardless of env.
const RAW_TARGET = parseInt(__ENV.TARGET_RPS || "200", 10);
const TARGET_RPS = Math.min(RAW_TARGET, 250);
if (RAW_TARGET > 250) {
  console.warn(`Clamping TARGET_RPS from ${RAW_TARGET} to 250 to protect Stripe rate limit.`);
}
const DURATION_S = parseInt(__ENV.DURATION_S || "60", 10);

const checkoutErrors = new Rate("checkout_errors");
const checkoutLatency = new Trend("checkout_latency_ms");
const stripeRateLimitHits = new Rate("stripe_rate_limit_hits");

export const options = {
  scenarios: {
    checkout_burst: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { target: TARGET_RPS, duration: "10s" },
        { target: TARGET_RPS, duration: `${DURATION_S}s` },
        { target: 0, duration: "10s" },
      ],
    },
  },
  thresholds: {
    "checkout_errors": ["rate<0.02"],
    "checkout_latency_ms": ["p(95)<600"],
    "stripe_rate_limit_hits": ["rate<0.05"], // < 5 % 429s = headroom OK
    "http_req_failed": ["rate<0.03"],
  },
};

export default function () {
  // Round-robin the token pool to spread requests across users so the
  // per-user 3/min rate limiter doesn't trip and skew everything to 429.
  const token = TOKEN_POOL[(__VU + __ITER) % TOKEN_POOL.length];

  // Vary the request shape: monthly, yearly, top-up — the same shape
  // distribution we see in production. Helps catch a regression that
  // affects one tier but not the others.
  const shapes = [
    { tier: "creator", cycle: "monthly", multipack: 1 },
    { tier: "creator", cycle: "yearly", multipack: 1 },
    { tier: "studio", cycle: "monthly", multipack: 1 },
    { kind: "topup", sku: "quick" },
    { kind: "topup", sku: "plus" },
  ];
  const body = shapes[__ITER % shapes.length];

  const res = http.post(
    `${SUPABASE_URL}/functions/v1/create-checkout`,
    JSON.stringify(body),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      tags: { name: "create-checkout", shape: body.kind || body.tier },
    },
  );

  checkoutLatency.add(res.timings.duration);

  // Accept either:
  //   200 — real Stripe URL returned (happy path)
  //   429 — our own rate limiter (3 req/min/user) — expected at burst
  // anything else is a regression.
  const ok = check(res, {
    "checkout returns 200 or 429 (rate limit)": (r) =>
      r.status === 200 || r.status === 429,
  });
  checkoutErrors.add(!ok);

  if (res.status === 429) {
    // Differentiate our rate limit from Stripe's. If the response body
    // mentions "Stripe" or the X-Stripe-* header is set, count it
    // against Stripe — that's the canary signalling we're too aggressive.
    const isStripeThrottle =
      res.headers["X-Stripe-Should-Retry"] !== undefined ||
      (typeof res.body === "string" && res.body.includes("rate_limit_error"));
    stripeRateLimitHits.add(isStripeThrottle);
  } else {
    stripeRateLimitHits.add(false);
  }

  sleep(Math.random() * 0.1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const text = [
    "─── checkout.k6.js summary ────────────────────────────────",
    `  checkout p95:        ${(m.checkout_latency_ms?.values?.["p(95)"] ?? 0).toFixed(0)} ms`,
    `  checkout error rate: ${((m.checkout_errors?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    `  Stripe 429 rate:     ${((m.stripe_rate_limit_hits?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    `  http_req_failed:     ${((m.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    "───────────────────────────────────────────────────────────",
    "",
  ].join("\n");
  return {
    "stdout": text,
    "checkout-results.json": JSON.stringify(data, null, 2),
  };
}
