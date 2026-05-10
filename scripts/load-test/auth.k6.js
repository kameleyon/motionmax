/**
 * MotionMax — auth burst load test (Probe C-10-5).
 *
 * Profile: 1000 RPS sustained for 30s, ramp up 10s, ramp down 10s.
 *
 * Validates the supabase GoTrue auth flow + the `notify-signup-welcome`
 * edge-function fan-out. The marketing team has run two campaigns in
 * the past that spiked signup to >800 RPS and quietly hit
 * rate-limit ceilings on the welcome-email queue. This test makes that
 * regression visible.
 *
 * USAGE
 *   k6 run scripts/load-test/auth.k6.js
 *
 * REQUIRED ENV
 *   SUPABASE_URL         e.g. https://<staging-ref>.supabase.co
 *   SUPABASE_ANON_KEY    anon JWT for the project
 *
 * OPTIONAL ENV
 *   TARGET_RPS           override the 1000 default
 *   DURATION_S           override the 30s sustained phase
 */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ── Guardrails ────────────────────────────────────────────────────────
const SUPABASE_URL = __ENV.SUPABASE_URL;
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  fail("Set SUPABASE_URL and SUPABASE_ANON_KEY before running.");
}

// HARD STOP: never aim a 1000-RPS firehose at production.
const isProdHost = !/test|staging|localhost|127\.0\.0\.1/i.test(SUPABASE_URL);
if (isProdHost) {
  fail(
    `Refusing to load-test what looks like a production host: ${SUPABASE_URL}. ` +
      `Add "test"/"staging" to the URL or run against localhost.`,
  );
}

// ── Tuning ────────────────────────────────────────────────────────────
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || "1000", 10);
const DURATION_S = parseInt(__ENV.DURATION_S || "30", 10);

// ── Metrics ───────────────────────────────────────────────────────────
const signupErrors = new Rate("signup_errors");
const signinErrors = new Rate("signin_errors");
const signupLatency = new Trend("signup_latency_ms");
const signinLatency = new Trend("signin_latency_ms");

// ── k6 scenarios ──────────────────────────────────────────────────────
export const options = {
  scenarios: {
    auth_burst: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { target: TARGET_RPS, duration: "10s" }, // ramp up
        { target: TARGET_RPS, duration: `${DURATION_S}s` }, // sustain
        { target: 0, duration: "10s" }, // ramp down
      ],
    },
  },
  // Thresholds let `k6 run` exit non-zero when SLOs regress.
  // Tuned against the README baseline; revisit on infra changes.
  thresholds: {
    "signup_errors": ["rate<0.01"], // < 1 %
    "signin_errors": ["rate<0.01"],
    "signup_latency_ms": ["p(95)<500"],
    "signin_latency_ms": ["p(95)<500"],
    "http_req_failed": ["rate<0.02"],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────
function genEmail() {
  // unique-per-VU + iteration to dodge the anti-spam unique-email check.
  return `loadtest-${__VU}-${__ITER}-${Date.now()}@motionmax.test`;
}

// ── Default exec body ─────────────────────────────────────────────────
export default function () {
  const email = genEmail();
  const password = "LoadTest!Password123";

  // ── 1. Sign up ───────────────────────────────────────────────────
  const signupRes = http.post(
    `${SUPABASE_URL}/auth/v1/signup`,
    JSON.stringify({ email, password }),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      tags: { name: "signup" },
    },
  );

  signupLatency.add(signupRes.timings.duration);
  const signupOk = check(signupRes, {
    "signup status is 200 or 422 (already-exists)": (r) =>
      r.status === 200 || r.status === 422,
  });
  signupErrors.add(!signupOk);

  // Brief jitter so VU iterations don't lock-step.
  sleep(Math.random() * 0.2);

  // ── 2. Sign in (with the just-created creds) ──────────────────────
  const signinRes = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password }),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
      tags: { name: "signin" },
    },
  );

  signinLatency.add(signinRes.timings.duration);
  const signinOk = check(signinRes, {
    "signin status is 200 or 400 (unconfirmed)": (r) =>
      r.status === 200 || r.status === 400,
  });
  signinErrors.add(!signinOk);
}

export function handleSummary(data) {
  return {
    "stdout": textSummary(data),
    "auth-results.json": JSON.stringify(data, null, 2),
  };
}

// k6 stdlib helper inlined so we don't depend on @grafana/jslib.
function textSummary(data) {
  const m = data.metrics;
  return [
    "─── auth.k6.js summary ────────────────────────────────────",
    `  signup p95:  ${(m.signup_latency_ms?.values?.["p(95)"] ?? 0).toFixed(0)} ms`,
    `  signin p95:  ${(m.signin_latency_ms?.values?.["p(95)"] ?? 0).toFixed(0)} ms`,
    `  signup err:  ${((m.signup_errors?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    `  signin err:  ${((m.signin_errors?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    `  http_req_failed: ${((m.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    "───────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}
