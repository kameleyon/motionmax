# MotionMax TypeScript SDK

> **Hand-scaffolded.** This client was written by hand to give integrators a
> typed starting point. At GA it will be **regenerated from
> [`openapi/motionmax.v1.yaml`](../../openapi/motionmax.v1.yaml)** — treat the
> generated client as the source of truth once it lands, and avoid heavy
> customization here that a regeneration would overwrite.

A minimal, dependency-free client for the MotionMax `/api/v1` surface. Runs
anywhere with a global `fetch` (Node ≥ 18, Deno, edge runtimes, browsers).

## Install

This scaffold is not yet published. Vendor it or build locally:

```bash
cd sdk/typescript
npm install
npm run build
```

## Usage

```ts
import { MotionMaxClient } from "@motionmax/sdk";

const mm = new MotionMaxClient({ apiKey: process.env.MM_API_KEY! });

// Create (live keys require an idempotency key)
const job = await mm.createVideo(
  { prompt: "A 60s explainer on photosynthesis.", mode: "doc2video", length: "short" },
  { idempotencyKey: "req-2026-06-26-abc123" },
);

// Poll to completion
const done = await mm.waitForVideo(job.id, { intervalMs: 3000 });
if (done.status === "succeeded") {
  console.log(done.result?.video_url);
}

// Other methods
await mm.getVideo(job.id);
await mm.listVideos({ limit: 20 });
await mm.cancelVideo(job.id);
await mm.getUsage();                         // last 30 days
await mm.getUsage({ groupBy: "provider" });  // with a spend breakdown
```

## Error handling

Non-2xx responses throw `MotionMaxError` carrying the frozen envelope:

```ts
import { MotionMaxError } from "@motionmax/sdk";

try {
  await mm.createVideo(req, { idempotencyKey: idem });
} catch (e) {
  if (e instanceof MotionMaxError) {
    console.error(e.code, e.message, e.requestId);
    if (e.retryable) {
      // back off (e.retryAfter seconds when present) and retry with the SAME
      // idempotency key
    }
  }
}
```

## Notes

- Key management (`/keys`) is intentionally **not** in this client — it is
  authenticated by a session JWT, not an API key. Manage keys from the dashboard.
- See the docs: [quickstart](../../docs/api/quickstart.md),
  [errors](../../docs/api/errors.md), [rate limits](../../docs/api/rate-limits.md),
  [webhooks](../../docs/api/webhooks.md).
