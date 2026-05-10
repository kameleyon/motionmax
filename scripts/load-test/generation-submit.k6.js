/**
 * MotionMax — generation submit + queue claim-time load test
 * (Probe C-10-5).
 *
 * Profile: 50 RPS sustained for 5 minutes against `generate-video`.
 * Worker is expected to scale (Render autoscaler) to keep claim time
 * under the SLO. The interesting metric is NOT the edge function
 * latency — it's how long jobs sit in `pending` before a worker picks
 * them up.
 *
 * What this catches:
 *   - Worker scaling not triggered → claim_time grows unbounded.
 *   - Queue-depth backpressure (50 pending+processing → 429 from edge
 *     function) misconfigured → 429-storm with low concurrent jobs.
 *   - Credit-deduction RPC becoming the bottleneck under sustained
 *     load (one row lock contended across all VUs).
 *
 * USAGE
 *   k6 run scripts/load-test/generation-submit.k6.js
 *
 * REQUIRED ENV
 *   SUPABASE_URL          edge function host
 *   SUPABASE_ANON_KEY     anon key for that project
 *   TEST_USER_EMAIL       pre-seeded studio-plan account (lots of credits)
 *   TEST_USER_PASSWORD    its password
 *
 * OPTIONAL ENV
 *   TARGET_RPS            override 50
 *   DURATION_S            override 300 (5 min)
 *   CLAIM_OBSERVE_S       how long to poll for a worker to claim each
 *                         submitted job (default 30 s). Set 0 to skip.
 */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const SUPABASE_URL = __ENV.SUPABASE_URL;
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY;
const EMAIL = __ENV.TEST_USER_EMAIL;
const PASSWORD = __ENV.TEST_USER_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !EMAIL || !PASSWORD) {
  fail("Set SUPABASE_URL, SUPABASE_ANON_KEY, TEST_USER_EMAIL, TEST_USER_PASSWORD first.");
}

const isProdHost = !/test|staging|localhost|127\.0\.0\.1/i.test(SUPABASE_URL);
if (isProdHost) {
  fail(`Refusing to load-test what looks like prod: ${SUPABASE_URL}`);
}

const TARGET_RPS = parseInt(__ENV.TARGET_RPS || "50", 10);
const DURATION_S = parseInt(__ENV.DURATION_S || "300", 10);
const CLAIM_OBSERVE_S = parseInt(__ENV.CLAIM_OBSERVE_S || "30", 10);

// ── Metrics ───────────────────────────────────────────────────────────
const submitErrors = new Rate("submit_errors");
const submitLatency = new Trend("submit_latency_ms");
const claimTime = new Trend("claim_time_ms"); // pending → processing
const claimsObserved = new Counter("claims_observed");
const claimTimeouts = new Counter("claim_timeouts");
const queueBackpressureHits = new Rate("queue_backpressure_hits"); // 429 from edge

// ── Auth setup phase (k6 setup runs once, before scenarios) ──────────
export function setup() {
  // Authenticate ONCE; share the bearer across VUs. This is the
  // realistic pattern (a logged-in user submitting many gens).
  // Per-user rate limit (3/min) is irrelevant here — we use a single
  // user with admin/studio plan so the gate at /generate-video is the
  // queue-depth one, not the plan one.
  const res = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "content-type": "application/json",
      },
    },
  );
  if (res.status !== 200) {
    fail(`setup signin failed: ${res.status} ${res.body}`);
  }
  const { access_token } = JSON.parse(res.body);
  return { token: access_token };
}

export const options = {
  scenarios: {
    submit_burst: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: TARGET_RPS, duration: "30s" }, // ramp up
        { target: TARGET_RPS, duration: `${DURATION_S}s` }, // sustained
        { target: 0, duration: "30s" },
      ],
    },
  },
  thresholds: {
    "submit_errors": ["rate<0.05"],
    "submit_latency_ms": ["p(95)<1500"], // submit is heavy: credit check + insert
    "claim_time_ms": ["p(95)<10000"], // 10s claim-time SLO at sustained load
    "queue_backpressure_hits": ["rate<0.10"], // < 10 % 429s is healthy headroom
  },
};

export default function (data) {
  // Submit a small "smartflow short" gen — cheapest credit-wise. Using
  // the same shape across all VUs surfaces queue contention without
  // also stressing the LLM (which has its own provider limits).
  const payload = {
    projectType: "smartflow",
    content: `Load-test gen ${__VU}-${__ITER} — short script about coffee.`,
    format: "landscape",
    length: "short",
    style: "realistic",
  };

  const submitStart = Date.now();
  const submitRes = http.post(
    `${SUPABASE_URL}/functions/v1/generate-video`,
    JSON.stringify(payload),
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${data.token}`,
        "content-type": "application/json",
      },
      tags: { name: "generate-video-submit" },
    },
  );

  submitLatency.add(submitRes.timings.duration);

  // Accepted statuses:
  //   200 — job enqueued, body has jobId
  //   429 — queue depth limit hit (50 pending+processing) — healthy
  //          backpressure signal, not a failure unless it dominates
  //   402 — insufficient credits — should NOT happen if the test user
  //          is provisioned correctly; surfaces as an error so we know
  const ok = check(submitRes, {
    "submit returns 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
  submitErrors.add(!ok);
  queueBackpressureHits.add(submitRes.status === 429);

  if (submitRes.status !== 200) {
    return; // can't observe claim without a jobId
  }

  // ── Observe queue claim time ──────────────────────────────────────
  if (CLAIM_OBSERVE_S <= 0) return;

  let parsed;
  try {
    parsed = JSON.parse(submitRes.body);
  } catch {
    return; // body wasn't JSON — log via http_req_failed elsewhere
  }
  const jobId = parsed.jobId;
  if (!jobId) return;

  const observeStart = Date.now();
  let claimed = false;
  // Poll job status until status='processing' (claim observed) or timeout.
  // Poll cadence: every 1s — k6 absorbs the overhead since each VU is
  // independent.
  while (Date.now() - observeStart < CLAIM_OBSERVE_S * 1000) {
    sleep(1);
    const pollRes = http.get(
      `${SUPABASE_URL}/rest/v1/video_generation_jobs?id=eq.${jobId}&select=status,started_processing_at`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          authorization: `Bearer ${data.token}`,
        },
        tags: { name: "poll-job-status" },
      },
    );
    if (pollRes.status !== 200) continue;
    let rows;
    try {
      rows = JSON.parse(pollRes.body);
    } catch {
      continue;
    }
    const row = rows && rows[0];
    if (row && (row.status === "processing" || row.status === "completed" || row.status === "failed")) {
      claimTime.add(Date.now() - submitStart);
      claimsObserved.add(1);
      claimed = true;
      break;
    }
  }
  if (!claimed) claimTimeouts.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const text = [
    "─── generation-submit.k6.js summary ───────────────────────",
    `  submit p95:           ${(m.submit_latency_ms?.values?.["p(95)"] ?? 0).toFixed(0)} ms`,
    `  submit error rate:    ${((m.submit_errors?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    `  queue 429 rate:       ${((m.queue_backpressure_hits?.values?.rate ?? 0) * 100).toFixed(2)} %`,
    `  claim p95:            ${(m.claim_time_ms?.values?.["p(95)"] ?? 0).toFixed(0)} ms`,
    `  claims observed:      ${m.claims_observed?.values?.count ?? 0}`,
    `  claim timeouts:       ${m.claim_timeouts?.values?.count ?? 0}`,
    "───────────────────────────────────────────────────────────",
    "",
  ].join("\n");
  return {
    "stdout": text,
    "generation-submit-results.json": JSON.stringify(data, null, 2),
  };
}
