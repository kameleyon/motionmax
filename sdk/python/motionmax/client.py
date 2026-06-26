"""MotionMax API client (hand-scaffolded, stdlib-only).

See ``openapi/motionmax.v1.yaml`` for the authoritative contract. This module
will be regenerated from that spec at GA.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional

DEFAULT_BASE_URL = "https://app.motionmax.io/api/v1"

_TERMINAL_STATES = frozenset(
    {"succeeded", "failed", "cancelled", "expired"}
)


# ─────────────────────────────────────────────────────────────────────────────
# Typed views (lightweight — plain dataclasses over the frozen JSON shapes).
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class VideoResult:
    status: str
    video_url: Optional[str]
    duration_s: Optional[float]
    thumbnail_url: Optional[str]
    format: Optional[str]
    error: Optional[Dict[str, str]]

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "VideoResult":
        return cls(
            status=d.get("status"),
            video_url=d.get("video_url"),
            duration_s=d.get("duration_s"),
            thumbnail_url=d.get("thumbnail_url"),
            format=d.get("format"),
            error=d.get("error"),
        )


@dataclass
class ApiJobView:
    id: str
    object: str
    status: str
    mode: str
    created_at: str
    result: Optional[VideoResult]

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "ApiJobView":
        raw_result = d.get("result")
        return cls(
            id=d["id"],
            object=d.get("object", "video"),
            status=d["status"],
            mode=d.get("mode", ""),
            created_at=d.get("created_at", ""),
            result=VideoResult.from_json(raw_result) if raw_result else None,
        )


@dataclass
class VideoList:
    data: List[ApiJobView]
    next_cursor: Optional[str]

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "VideoList":
        return cls(
            data=[ApiJobView.from_json(item) for item in d.get("data", [])],
            next_cursor=d.get("next_cursor"),
        )


@dataclass
class UsageView:
    object: str
    account_id: str
    calls: int
    jobs: int
    # Provider cost (USD) attributed to this account in the window — not credits.
    total_cost_usd: float
    credits_balance: int
    since: Optional[str] = None
    # Present only when group_by was supplied.
    breakdown: Optional[List[Dict[str, Any]]] = None

    @classmethod
    def from_json(cls, d: Mapping[str, Any]) -> "UsageView":
        return cls(
            object=d.get("object", "usage"),
            account_id=d.get("account_id", ""),
            calls=d.get("calls", 0),
            jobs=d.get("jobs", 0),
            total_cost_usd=d.get("total_cost_usd", 0),
            credits_balance=d.get("credits_balance", 0),
            since=d.get("since"),
            breakdown=d.get("breakdown"),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────────────


class MotionMaxError(Exception):
    """Raised for any non-2xx response, carrying the frozen error envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: Optional[str] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        """True for codes safe to retry after a backoff."""
        return (
            self.status == 429
            or self.status >= 500
            or self.code == "moderation_unavailable"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Client
# ─────────────────────────────────────────────────────────────────────────────


class MotionMaxClient:
    """Synchronous client for the MotionMax ``/api/v1`` surface.

    Args:
        api_key: Your API key (``mm_live_…`` or ``mm_test_…``).
        base_url: Override the API base URL (defaults to production).
        timeout: Per-request socket timeout in seconds.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
    ) -> None:
        if not api_key:
            raise ValueError("MotionMaxClient: api_key is required.")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ── Public methods ────────────────────────────────────────────────────────

    def create_video(
        self,
        prompt: str,
        mode: str,
        *,
        length: Optional[str] = None,
        format: Optional[str] = None,
        voice: Optional[str] = None,
        language: Optional[str] = None,
        attachments: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
        callback_url: Optional[str] = None,
    ) -> ApiJobView:
        """Create a video-generation job (returns the 202 job view).

        Live keys require ``idempotency_key``.
        """
        body: Dict[str, Any] = {"prompt": prompt, "mode": mode}
        if length is not None:
            body["length"] = length
        if format is not None:
            body["format"] = format
        if voice is not None:
            body["voice"] = voice
        if language is not None:
            body["language"] = language
        if attachments is not None:
            body["attachments"] = attachments
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        if callback_url is not None:
            body["callback_url"] = callback_url

        headers: Dict[str, str] = {}
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key

        data = self._request("POST", "/videos", body=body, headers=headers)
        return ApiJobView.from_json(data)

    def get_video(self, video_id: str) -> ApiJobView:
        """Fetch a single job's status + result."""
        path = f"/videos/{urllib.parse.quote(video_id, safe='')}"
        return ApiJobView.from_json(self._request("GET", path))

    def list_videos(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> VideoList:
        """List this account's jobs (cursor-paginated, newest first)."""
        query: Dict[str, str] = {}
        if limit is not None:
            query["limit"] = str(limit)
        if cursor is not None:
            query["cursor"] = cursor
        return VideoList.from_json(self._request("GET", "/videos", query=query))

    def cancel_video(self, video_id: str) -> ApiJobView:
        """Cancel an in-flight job (idempotent for terminal jobs)."""
        path = f"/videos/{urllib.parse.quote(video_id, safe='')}/cancel"
        return ApiJobView.from_json(self._request("POST", path))

    def get_usage(
        self,
        since: Optional[str] = None,
        group_by: Optional[str] = None,
    ) -> UsageView:
        """Account credit balance + provider spend since ``since`` (ISO-8601,
        default 30 days ago). Pass ``group_by`` (provider|model|day) to also
        receive a ``breakdown`` list."""
        query: Dict[str, str] = {}
        if since is not None:
            query["since"] = since
        if group_by is not None:
            query["group_by"] = group_by
        return UsageView.from_json(self._request("GET", "/usage", query=query))

    def wait_for_video(
        self,
        video_id: str,
        *,
        interval_s: float = 3.0,
        timeout_s: float = 900.0,
    ) -> ApiJobView:
        """Poll ``get_video`` until the job reaches a terminal state.

        Keep ``interval_s`` comfortably above your tier's cadence so polling
        doesn't trip the rate limiter.
        """
        deadline = time.monotonic() + timeout_s
        while True:
            job = self.get_video(video_id)
            if job.status in _TERMINAL_STATES:
                return job
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"wait_for_video: timed out waiting for job {video_id}."
                )
            time.sleep(interval_s)

    # ── Internals ─────────────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, str]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)

        req_headers: Dict[str, str] = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        if headers:
            req_headers.update(headers)

        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            url, data=data, headers=req_headers, method=method
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {}
            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            retry_after_hdr = exc.headers.get("Retry-After") if exc.headers else None
            retry_after = (
                int(retry_after_hdr)
                if retry_after_hdr and retry_after_hdr.isdigit()
                else None
            )
            raise MotionMaxError(
                status=exc.code,
                code=err.get("code", "unknown_error"),
                message=err.get("message", f"HTTP {exc.code}"),
                request_id=err.get("request_id"),
                retry_after=retry_after,
            ) from exc
        except urllib.error.URLError as exc:
            raise MotionMaxError(
                status=0,
                code="network_error",
                message=str(exc.reason),
            ) from exc
