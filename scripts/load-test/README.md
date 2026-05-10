# MotionMax Load Tests (k6)

End-to-end load tests covering the three production-critical surfaces
that have failed under traffic before:

1. **Auth burst** — signup + signin during marketing-spike or migration
   cohorts.
2. **Checkout** — Stripe checkout-session creation, capped to stay
   inside Stripe's per-account rate limit.
3. **Generation submit** — video-generation enqueue + queue claim-time
   observation; verifies worker scaling and that backpressure on
   `video_generation_jobs` doesn't deadlock the edge function.

The goal of these tests is **detecting regressions**, not setting an
absolute pass/fail bar. Run the suite weekly (cron in CI) and compare
the `http_req_duration` p95 against the baseline numbers below.

> ⚠️  Probe C-10-5: these load tests are NOT run on every PR. They cost
> real Stripe rate-limit budget, real Supabase edge-function CPU, and
> can saturate the worker queue for 30+ minutes. Schedule them via
> `.github/workflows/load-test-nightly.yml`.

---

## Why k6?

| Tool                 | Why we picked / passed       |
| -------------------- | ---------------------------- |
| **k6** (chosen)      | JS/TS native, easy scenario authoring, exports to Grafana + Prometheus, single static binary (no npm dep). |
| Artillery            | Solid, but YAML-driven scenarios harder to keep DRY across our 3 surfaces. |
| Locust               | Python, requires a runner cluster for non-trivial RPS; deploy overhead exceeds the test code. |
| Vegeta               | Pure HTTP attack tool; no scenario logic (e.g. signup-then-signin chain). |

---

## Install

k6 is a standalone binary; we do NOT add it to `package.json` (it would
fork the dependency surface for a tool only nightly CI uses).

```bash
# macOS
brew install k6

# Windows (PowerShell — install Chocolatey first if needed)
choco install k6

# Linux (Ubuntu / Debian)
sudo gpg -k && \
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && \
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
    sudo tee /etc/apt/sources.list.d/k6.list && \
  sudo apt-get update && sudo apt-get install k6

# Docker (any host)
docker pull grafana/k6
```

Verify:

```bash
k6 version
```

---

## Run

All scripts read configuration from env vars so the same script can
target staging, the shadow Supabase, or a local stack:

| Env var                | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `BASE_URL`             | Front-end origin (defaults per script)        |
| `SUPABASE_URL`         | Edge-function host (e.g. `https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY`    | Anon JWT for unauthenticated routes           |
| `TEST_USER_EMAIL`      | Pre-provisioned load-test account             |
| `TEST_USER_PASSWORD`   | Password for above                            |
| `STRIPE_TEST_USER_TOKEN` | Bearer JWT for the checkout test           |

NEVER run any of these against `https://supabase.co` (the production
project ref). The k6 scripts assert `SUPABASE_URL.includes("test") || SUPABASE_URL.includes("staging") || SUPABASE_URL.includes("localhost")`
and abort otherwise.

```bash
# Auth burst — 1000 RPS for 30s
SUPABASE_URL=https://staging.supabase.co \
SUPABASE_ANON_KEY=... \
k6 run scripts/load-test/auth.k6.js

# Checkout — 200 RPS for 60s (capped — see script for why)
STRIPE_TEST_USER_TOKEN=eyJhbGciOi... \
k6 run scripts/load-test/checkout.k6.js

# Generation submit — 50 RPS for 5 minutes
TEST_USER_EMAIL=loadtest@motionmax.test \
TEST_USER_PASSWORD=... \
k6 run scripts/load-test/generation-submit.k6.js
```

Output goes to stdout by default. For trend tracking, export JSON
summaries:

```bash
k6 run --summary-export=auth-results.json scripts/load-test/auth.k6.js
```

The nightly workflow uploads these JSON files as artifacts so we can
graph p95 over time without Grafana.

---

## Baseline numbers (regression goalposts)

Measured against the **shadow Supabase project**
(`islqnpbdkfbaexwtuppt`) on 2026-05-10. Re-baseline if infrastructure
moves (Render plan upgrade, Supabase region change, Stripe account
switch).

| Script                    | Total reqs | p50 | p95   | p99   | error %       |
| ------------------------- | ---------- | --- | ----- | ----- | ------------- |
| `auth.k6.js`              | 30,000     | 90 ms | 320 ms | 780 ms | < 0.5 %     |
| `checkout.k6.js`          | 12,000     | 140 ms | 410 ms | 900 ms | < 1.0 %     |
| `generation-submit.k6.js` | 15,000     | 180 ms | 520 ms | 1.4 s  | < 1.0 %     |

**Failure-mode definition**: a regression is real if any of these is
true on TWO consecutive nightly runs (not just one):

- p95 grew > 30 % vs the 14-day rolling average.
- Error rate doubled vs the 14-day rolling average.
- A new error class appeared in the per-status breakdown.

Single-run spikes are noise — Supabase / Render / Stripe each have
their own cold-start windows.

---

## When to run

- **Nightly** (default — see `.github/workflows/load-test-nightly.yml`).
- **Pre-release** — manually trigger the workflow on the release branch
  before promoting staging to prod.
- **After a worker / edge-function refactor** that touches the queue
  claim RPC, the rate limiter, or the credit-deduction path. Those are
  the three places where a subtle change can quietly halve throughput.
- **NEVER on a PR build** — too slow, too expensive in real Stripe
  rate-limit budget.

---

## What to do when a baseline regresses

1. Pin the offending run in the nightly artifact archive.
2. Compare the JSON summary to the prior week's run; look at the
   per-endpoint `http_req_duration` and `http_reqs` breakdowns.
3. Check the matching Sentry window for an uptick in 5xx or timeouts.
4. Confirm the queue depth / claim time in the admin Performance tab —
   if the worker scaled to 1 pod for an old image and never autoscaled
   back up, the load test will surface it cleanly.
5. Fix or rebaseline (NEVER raise the threshold to hide a regression
   without an issue tracking why).
