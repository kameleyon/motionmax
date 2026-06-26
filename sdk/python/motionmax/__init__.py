"""MotionMax API — Python client (hand-scaffolded).

A minimal client over the MotionMax ``/api/v1`` surface. It is intended to be
REGENERATED from ``openapi/motionmax.v1.yaml`` at GA; until then this scaffold
gives integrators an idiomatic starting point.

Depends only on the standard library (``urllib``), so it has zero install
footprint. Swap in ``requests``/``httpx`` if you prefer.
"""

from .client import (
    MotionMaxClient,
    MotionMaxError,
    ApiJobView,
    VideoResult,
    VideoList,
    UsageView,
)

__all__ = [
    "MotionMaxClient",
    "MotionMaxError",
    "ApiJobView",
    "VideoResult",
    "VideoList",
    "UsageView",
]

__version__ = "0.1.0"
