/**
 * MotionMax API — TypeScript client (hand-scaffolded).
 *
 * A minimal, dependency-free client over the MotionMax /api/v1 surface. It is
 * NOT part of the api/ or worker/ TypeScript projects (it is excluded from those
 * tsconfigs), and is intended to be REGENERATED from openapi/motionmax.v1.yaml at
 * GA. Until then this scaffold gives integrators a typed starting point.
 *
 * Runtime: anything with a global `fetch` (Node >= 18, Deno, browsers, edge).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types (kept in sync with api/v1/_shared/contract.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type PublicJobState =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type VideoMode = "doc2video" | "smartflow" | "cinematic";
export type VideoLength = "short" | "brief" | "presentation";

export interface CreateVideoRequest {
  prompt: string;
  mode: VideoMode;
  length?: VideoLength;
  format?: string;
  voice?: string;
  language?: string;
  attachments?: string[];
  idempotency_key?: string;
  callback_url?: string;
}

export interface VideoResult {
  status: PublicJobState;
  video_url: string | null;
  duration_s: number | null;
  thumbnail_url: string | null;
  format: string | null;
  error: { code: string; message: string } | null;
}

export interface ApiJobView {
  id: string;
  object: "video";
  status: PublicJobState;
  mode: VideoMode | string;
  created_at: string;
  result: VideoResult | null;
}

export interface VideoList {
  data: ApiJobView[];
  next_cursor: string | null;
}

export interface UsageBreakdownRow {
  label: string;
  calls: number;
  spend: number;
  avg_ms: number;
}

export interface UsageView {
  object: "usage";
  account_id: string;
  /** Start of the window the figures cover (null if unbounded). */
  since: string | null;
  calls: number;
  jobs: number;
  /** Provider cost (USD) attributed to this account in the window. */
  total_cost_usd: number;
  credits_balance: number;
  /** Present only when `groupBy` was supplied. */
  breakdown?: UsageBreakdownRow[];
}

export interface ListVideosParams {
  limit?: number;
  cursor?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown for any non-2xx response, carrying the frozen error envelope. */
export class MotionMaxError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** Seconds to wait before retrying, when present (429). */
  readonly retryAfter: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string | null,
    retryAfter: number | null,
  ) {
    super(message);
    this.name = "MotionMaxError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }

  /** True for codes safe to retry after a backoff. */
  get retryable(): boolean {
    return (
      this.status === 429 ||
      this.status >= 500 ||
      this.code === "moderation_unavailable"
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export interface MotionMaxClientOptions {
  /** Your API key (mm_live_… or mm_test_…). */
  apiKey: string;
  /** Override the base URL. Defaults to production. */
  baseUrl?: string;
  /** Custom fetch (e.g. a polyfill or instrumented fetch). */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://app.motionmax.io/api/v1";

export class MotionMaxClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MotionMaxClientOptions) {
    if (!options.apiKey) {
      throw new Error("MotionMaxClient: apiKey is required.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!f) {
      throw new Error(
        "MotionMaxClient: no global fetch found; pass options.fetch.",
      );
    }
    this.fetchImpl = f;
  }

  /** Create a video-generation job. Returns the 202 job view. */
  async createVideo(
    body: CreateVideoRequest,
    opts?: { idempotencyKey?: string },
  ): Promise<ApiJobView> {
    const headers: Record<string, string> = {};
    // Live keys require an idempotency key; allow passing it as an option that
    // also satisfies the body field if the caller didn't set one.
    const idem = opts?.idempotencyKey ?? body.idempotency_key;
    if (idem) headers["Idempotency-Key"] = idem;
    return this.request<ApiJobView>("POST", "/videos", { body, headers });
  }

  /** Fetch a single job's status + result. */
  async getVideo(id: string): Promise<ApiJobView> {
    return this.request<ApiJobView>("GET", `/videos/${encodeURIComponent(id)}`);
  }

  /** List this account's jobs (cursor-paginated, newest first). */
  async listVideos(params?: ListVideosParams): Promise<VideoList> {
    const query: Record<string, string> = {};
    if (params?.limit !== undefined) query.limit = String(params.limit);
    if (params?.cursor) query.cursor = params.cursor;
    return this.request<VideoList>("GET", "/videos", { query });
  }

  /** Cancel an in-flight job (idempotent for terminal jobs). */
  async cancelVideo(id: string): Promise<ApiJobView> {
    return this.request<ApiJobView>(
      "POST",
      `/videos/${encodeURIComponent(id)}/cancel`,
    );
  }

  /**
   * Account credit balance + provider spend since `since` (ISO-8601, default
   * 30 days ago). Pass `groupBy` to also receive a `breakdown` array.
   */
  async getUsage(params?: {
    since?: string;
    groupBy?: "provider" | "model" | "day";
  }): Promise<UsageView> {
    const query: Record<string, string> = {};
    if (params?.since) query.since = params.since;
    if (params?.groupBy) query.group_by = params.groupBy;
    return this.request<UsageView>("GET", "/usage", { query });
  }

  /**
   * Convenience: poll getVideo until the job reaches a terminal state or the
   * timeout elapses. Honors no rate limit of its own — keep `intervalMs`
   * comfortably above your tier's cadence.
   */
  async waitForVideo(
    id: string,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<ApiJobView> {
    const interval = opts?.intervalMs ?? 3000;
    const deadline = Date.now() + (opts?.timeoutMs ?? 15 * 60 * 1000);
    const terminal = new Set<PublicJobState>([
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ]);
    for (;;) {
      const job = await this.getVideo(id);
      if (terminal.has(job.status)) return job;
      if (Date.now() >= deadline) {
        throw new Error(`waitForVideo: timed out waiting for job ${id}.`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts?.query && Object.keys(opts.query).length > 0) {
      url += `?${new URLSearchParams(opts.query).toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...opts?.headers,
    };
    let bodyInit: string | undefined;
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(url, { method, headers, body: bodyInit });

    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;

    if (!res.ok) {
      const env = json as
        | { error?: { code?: string; message?: string; request_id?: string } }
        | null;
      const code = env?.error?.code ?? "unknown_error";
      const message = env?.error?.message ?? `HTTP ${res.status}`;
      const requestId = env?.error?.request_id ?? null;
      const ra = res.headers.get("Retry-After");
      throw new MotionMaxError(
        res.status,
        code,
        message,
        requestId,
        ra ? Number(ra) : null,
      );
    }

    return json as T;
  }
}

export default MotionMaxClient;
