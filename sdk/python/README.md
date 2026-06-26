# MotionMax Python SDK

> **Hand-scaffolded.** This client was written by hand to give integrators an
> idiomatic starting point. At GA it will be **regenerated from
> [`openapi/motionmax.v1.yaml`](../../openapi/motionmax.v1.yaml)** — treat the
> generated client as the source of truth once it lands.

A minimal, **standard-library-only** client for the MotionMax `/api/v1` surface
(no `requests`/`httpx` dependency). Python ≥ 3.8.

## Install

Not yet published. Vendor it or install locally:

```bash
cd sdk/python
pip install -e .
```

## Usage

```python
import os
from motionmax import MotionMaxClient, MotionMaxError

mm = MotionMaxClient(api_key=os.environ["MM_API_KEY"])

# Create (live keys require an idempotency key)
job = mm.create_video(
    prompt="A 60s explainer on photosynthesis.",
    mode="doc2video",
    length="short",
    idempotency_key="req-2026-06-26-abc123",
)

# Poll to completion
done = mm.wait_for_video(job.id, interval_s=3.0)
if done.status == "succeeded" and done.result:
    print(done.result.video_url)

# Other methods
mm.get_video(job.id)
mm.list_videos(limit=20)
mm.cancel_video(job.id)
mm.get_usage()                       # last 30 days
mm.get_usage(group_by="provider")    # with a spend breakdown
```

## Error handling

Non-2xx responses raise `MotionMaxError` carrying the frozen envelope:

```python
try:
    mm.create_video(prompt=p, mode="doc2video", idempotency_key=idem)
except MotionMaxError as e:
    print(e.code, e.message, e.request_id)
    if e.retryable:
        # back off (e.retry_after seconds when present) and retry with the SAME
        # idempotency key
        ...
```

## Notes

- Key management (`/keys`) is intentionally **not** in this client — it is
  authenticated by a session JWT, not an API key. Manage keys from the dashboard.
- See the docs: [quickstart](../../docs/api/quickstart.md),
  [errors](../../docs/api/errors.md), [rate limits](../../docs/api/rate-limits.md),
  [webhooks](../../docs/api/webhooks.md).
