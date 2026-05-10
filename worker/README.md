# MotionMax Worker

The Node.js worker that runs all heavy MotionMax processing
(LLM calls, image generation, video generation, FFmpeg export).
Polls Supabase for `claim_pending_job`, processes one job at a
time, writes progress back via Supabase Realtime.

## Deploy target: Railway

The worker is deployed to **Railway**, not Render. Railway auto-deploys
on every push to `main` via its GitHub integration (configured in the
Railway dashboard, not in code).

### Manifests

Two files in this directory cooperate:

| File           | Owner    | Purpose                                                                |
| -------------- | -------- | ---------------------------------------------------------------------- |
| `railway.json` | Railway  | Service config: healthcheck path, restart policy, replica count        |
| `railpack.json`| Railpack | Builder spec: Node 24 runtime, system `ffmpeg`, start command          |

`railway.json` declares `"builder": "RAILPACK"`, which tells Railway to
read `railpack.json` for build details. The two files are complementary,
not competing — both are required.

### What was archived (2026-05-10)

`render.yaml` was moved to `archive/render.yaml.deprecated.2026-05-10`
during the Render → Railway migration. CI no longer pings the Render
deploy hook (see `.github/workflows/deploy-prod.yml`); the file is
intentionally inert. To revive Render as a fallback host, copy it back
and re-add the Render step.

## Required env vars (set in Railway dashboard)

The worker reads these at boot (see `worker/src/lib/supabase.ts`,
`worker/src/lib/encryption.ts`, `worker/src/index.ts`):

| Variable                       | Notes                                                |
| ------------------------------ | ---------------------------------------------------- |
| `SUPABASE_URL`                 | Full URL — `https://<ref>.supabase.co`               |
| `SUPABASE_PROJECT_REF`         | New (B-NEW-17): explicit project ref for staging swap; falls back to URL parse → prod hard-coded ref |
| `SUPABASE_SERVICE_ROLE_KEY`    | Required — worker bypasses RLS                       |
| `ENCRYPTION_KEY_V1`            | 32-byte base64 key for at-rest secret encryption     |
| `REDIS_URL`                    | Optional — distributed lock + concurrency throttle    |
| `OPENROUTER_API_KEY`           | Claude Sonnet 4.6                                    |
| `HYPEREAL_API_KEY`             | Image / video generation                             |
| `REPLICATE_API_KEY`            | Qwen3 / Chatterbox TTS                               |
| `ELEVENLABS_API_KEY`           | TTS + voice cloning                                  |
| `FISH_AUDIO_API_KEY`           | TTS (multi-language)                                 |
| `LEMONFOX_API_KEY`             | TTS (English)                                        |
| `GOOGLE_TTS_API_KEY`           | TTS (Haitian Creole)                                 |
| `SENTRY_DSN`                   | Owned by Cipher / B-NEW-19                            |
| `HEALTH_AUTH_TOKEN`            | Bearer for `/health` (see `src/index.ts`)             |
| `HEALTH_PORT`                  | Default `10000`                                       |
| `WORKER_CONCURRENCY`           | Per-instance LLM concurrency cap (see detectOptimalConcurrency) |
| `JOB_TIMEOUT_MS`               | Hard timeout per job                                  |
| `SHUTDOWN_DRAIN_TIMEOUT`       | Drain window on SIGTERM                               |
| `EXPORT_BATCH_SIZE`, `EXPORT_*`| FFmpeg export tuning knobs                            |

> The recent ENCRYPTION_KEY_V1 deploy failure was caused by a missing
> Railway env var, not a code regression — see incident postmortem.
> Always verify env-var presence in the Railway dashboard before
> promoting a deploy.

## Local dev

```bash
cd worker
npm ci
cp ../.env .env  # or wire up your own
npm run dev
```

The worker exits at boot if `SUPABASE_SERVICE_ROLE_KEY` is missing or
belongs to a different project than the URL — that's intentional. It's
better to fail loud than silently target the wrong DB.

## Scaling

Pre-2026-05-10 (Render): 1–8 instances, autoscaled on memory pressure
(`targetMemoryPercent: 40`). Settings preserved in the archived
`render.yaml`. On Railway, `numReplicas: 3` is set in `railway.json` as
a fixed-replica baseline; tune in the Railway dashboard or by editing
`railway.json` and committing.

Per-instance LLM concurrency is hard-capped at 8 by
`detectOptimalConcurrency` in `worker/src/index.ts`, so the 3-replica
default supports ~24 LLM jobs in flight.
