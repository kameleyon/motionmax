// Deno unit tests for the REAL export-my-data handler (Probe F-10-05 / B-NEW-20).
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "./index.ts";

// ─── Mock factories ───────────────────────────────────────────────────────────

interface UserSupaOpts {
  user?: { id: string; email: string } | null;
  authError?: { message: string } | null;
  // Returns the rate_limits rows for the SELECT query — `length` decides whether
  // the rate-limit check trips. Set to maxRequests (=1) to simulate over limit.
  rateLimitRows?: unknown[];
}

function createUserSupaMock(opts: UserSupaOpts = {}) {
  const insertCalls: { table: string; data: unknown }[] = [];
  return {
    insertCalls,
    auth: {
      getUser: async () => ({
        data: { user: opts.user === undefined ? { id: "user-x", email: "x@example.com" } : opts.user },
        error: opts.authError ?? null,
      }),
    },
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.gte = () => chain;
      chain.order = async () => {
        if (table === "rate_limits") {
          return { data: opts.rateLimitRows ?? [], error: null };
        }
        return { data: [], error: null };
      };
      chain.insert = async (data: unknown) => {
        insertCalls.push({ table, data });
        return { error: null };
      };
      return chain;
    },
  };
}

interface AdminSupaOpts {
  /** Per-table data the parallel Promise.all reads will return. */
  data?: Record<string, unknown>;
  /** Force every table to return a HUGE blob — for size-cap test. */
  forceLarge?: boolean;
}

function createAdminSupaMock(opts: AdminSupaOpts = {}) {
  const data = opts.data ?? {};
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const tableData = (data[table] ??
        (opts.forceLarge && (table === "projects" || table === "credit_transactions")
          ? Array.from({ length: 50_000 }, (_, i) => ({
              id: i,
              filler:
                "x".repeat(300) /* ~300 chars × 50k rows × 2 tables = ~30MB */,
            }))
          : null)) as unknown;

      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      // Resolve at the END of the chain. The real Supabase client awaits the
      // builder; we make every chain method return `chain` and resolve via
      // `then` on the chain itself so `await query` works.
      const result = Array.isArray(tableData)
        ? { data: tableData, error: null }
        : tableData
          ? { data: tableData, error: null }
          : { data: [], error: null };
      chain.maybeSingle = async () => ({
        data: Array.isArray(tableData) ? tableData[0] ?? null : tableData ?? null,
        error: null,
      });
      // Make the chain awaitable for `.from(t).select(*).eq(...)` patterns.
      (chain as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve(result);
      return chain;
    },
  };
}

function makeRequest(opts: { auth?: string | null; method?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? "Bearer test-token");
  }
  return new Request("https://example.com/export-my-data", {
    method: opts.method ?? "POST",
    headers,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("returns 401 when Authorization header is missing", async () => {
  const supabaseUser = createUserSupaMock();
  const supabaseAdmin = createAdminSupaMock();

  const res = await handler(makeRequest({ auth: null }), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 401);
});

Deno.test("returns 401 when JWT validation fails", async () => {
  const supabaseUser = createUserSupaMock({
    user: null,
    authError: { message: "JWT expired" },
  });
  const supabaseAdmin = createAdminSupaMock();

  const res = await handler(makeRequest(), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 401);
});

Deno.test("happy path: returns JSON blob with profile + projects + voices and key fields", async () => {
  const supabaseUser = createUserSupaMock({
    user: { id: "user-export", email: "exporter@example.com" },
  });
  const supabaseAdmin = createAdminSupaMock({
    data: {
      profiles: { id: "user-export", display_name: "Exporter", ai_training_opt_in: true, ai_training_opt_in_changed_at: "2026-05-01T00:00:00Z" },
      projects: [{ id: "proj-1", title: "First project" }],
      generations: [],
      subscriptions: [],
      user_credits: { balance: 100 },
      credit_transactions: [],
      generation_costs: [],
      video_generation_jobs: [],
      project_shares: [],
      user_voices: [{ id: "voice-1", name: "My Voice", provider: "elevenlabs", consent_given: true }],
      user_flags: [],
      scene_versions: [],
    },
  });

  const res = await handler(makeRequest(), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.user_id, "user-export");
  assertEquals(body.email, "exporter@example.com");
  assertEquals(body.ai_training_opt_in, true);
  assertEquals(body.ai_training_opt_in_changed_at, "2026-05-01T00:00:00Z");
  assertEquals(body.profile.id, "user-export");
  assertEquals(Array.isArray(body.projects), true);
  assertEquals(body.projects.length, 1);
  assertEquals(Array.isArray(body.user_voices), true);
  assertEquals(body.user_voices[0].name, "My Voice");
  // GDPR keys present even when arrays are empty
  assertEquals(Array.isArray(body.credit_transactions), true);
  assertEquals(Array.isArray(body.scene_versions), true);
});

Deno.test("Content-Disposition is attachment with user_id in filename", async () => {
  const supabaseUser = createUserSupaMock({
    user: { id: "user-disp", email: "disp@example.com" },
  });
  const supabaseAdmin = createAdminSupaMock();

  const res = await handler(makeRequest(), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 200);
  const cd = res.headers.get("Content-Disposition");
  assertEquals(cd?.includes("attachment"), true);
  assertEquals(cd?.includes("user-disp"), true);
});

Deno.test("rate-limit: returns 429 when user exceeds 1 export/hour", async () => {
  // Pre-existing rate_limits row → length >= maxRequests (1).
  const supabaseUser = createUserSupaMock({
    user: { id: "user-rl", email: "rl@example.com" },
    rateLimitRows: [{ id: "r1", created_at: new Date().toISOString() }],
  });
  const supabaseAdmin = createAdminSupaMock();

  const res = await handler(makeRequest(), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error, "Rate limit exceeded");
});

Deno.test("size-cap: returns 413 when exported JSON exceeds 10MB", async () => {
  const supabaseUser = createUserSupaMock({
    user: { id: "user-big", email: "big@example.com" },
  });
  const supabaseAdmin = createAdminSupaMock({ forceLarge: true });

  const res = await handler(makeRequest(), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 413);
  const body = await res.json();
  assertEquals(body.error, "Export too large");
});

Deno.test("ai_training_opt_in defaults to false when profile column is null", async () => {
  const supabaseUser = createUserSupaMock({
    user: { id: "user-default", email: "default@example.com" },
  });
  const supabaseAdmin = createAdminSupaMock({
    data: {
      profiles: { id: "user-default", display_name: "Default" },
      // no ai_training_opt_in field on the row
    },
  });

  const res = await handler(makeRequest(), { supabaseUser, supabaseAdmin });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ai_training_opt_in, false);
  assertEquals(body.ai_training_opt_in_changed_at, null);
});
