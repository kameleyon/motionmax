// Deno unit tests for the REAL customer-portal handler (Probe F-10-05 / B-NEW-20).
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "./index.ts";

// ─── Mock factories ───────────────────────────────────────────────────────────

interface SupaOpts {
  user?: { id: string; email: string } | null;
  authError?: { message: string } | null;
  /** Result of the dbSubscription single() lookup. */
  dbSubscription?: Record<string, unknown> | null;
  rateLimitRows?: unknown[];
}

function createSupaMock(opts: SupaOpts = {}) {
  const insertCalls: { table: string; data: unknown }[] = [];
  return {
    insertCalls,
    auth: {
      getUser: async () => ({
        data: { user: opts.user === undefined ? { id: "u1", email: "u1@example.com" } : opts.user },
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
      chain.single = async () =>
        table === "subscriptions"
          ? { data: opts.dbSubscription ?? null, error: null }
          : { data: null, error: null };
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.insert = async (data: unknown) => {
        insertCalls.push({ table, data });
        return { error: null };
      };
      return chain;
    },
  };
}

interface StripeOpts {
  customers?: Array<{ id: string }>;
  portalUrl?: string;
}

function createStripeMock(opts: StripeOpts = {}) {
  const portalSessions: Record<string, unknown>[] = [];
  return {
    portalSessions,
    customers: {
      list: async (_opts: unknown) => ({ data: opts.customers ?? [{ id: "cus_default" }] }),
    },
    billingPortal: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          portalSessions.push(params);
          return {
            id: "bps_test",
            url: opts.portalUrl ?? "https://billing.stripe.com/portal/test",
          };
        },
      },
    },
  };
}

function makeRequest(opts: { auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? "Bearer test-token");
  }
  return new Request("https://example.com/customer-portal", {
    method: "POST",
    headers,
  });
}

// Env helpers
const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY"] as const;
const ORIG: Record<string, string | undefined> = {};
function setEnv() {
  for (const k of ENV_KEYS) ORIG[k] = Deno.env.get(k);
  Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_xxx");
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    const v = ORIG[k];
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("happy path: returns Stripe billing-portal session URL", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock({
      customers: [{ id: "cus_active" }],
      portalUrl: "https://billing.stripe.com/portal/abc123",
    });

    const res = await handler(makeRequest(), { stripe, supabaseClient });

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.url, "https://billing.stripe.com/portal/abc123");

    // Stripe was asked to create a portal session for the right customer.
    assertEquals(stripe.portalSessions.length, 1);
    assertEquals(stripe.portalSessions[0].customer, "cus_active");
  } finally { restoreEnv(); }
});

Deno.test("returns 500 / generic error when Authorization header is missing", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock({ user: undefined });
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ auth: null }), { stripe, supabaseClient });

    // The handler throws "No authorization header provided" — generic catch arm.
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(typeof body.error, "string");
  } finally { restoreEnv(); }
});

Deno.test("returns 500 with user-facing message when JWT validation fails", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock({
      user: null,
      authError: { message: "JWT expired" },
    });
    const stripe = createStripeMock();

    const res = await handler(makeRequest(), { stripe, supabaseClient });

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "Authentication failed. Please sign in again.");
  } finally { restoreEnv(); }
});

Deno.test("user without Stripe customer ID gets clear error", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock();
    // stripe.customers.list returns an empty list — no customer found.
    const stripe = createStripeMock({ customers: [] });

    const res = await handler(makeRequest(), { stripe, supabaseClient });

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "No billing account found. Please contact support.");
    // No portal session was attempted.
    assertEquals(stripe.portalSessions.length, 0);
  } finally { restoreEnv(); }
});

Deno.test("manual / comp subscription returns 422 with MANUAL_SUBSCRIPTION error code", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock({
      dbSubscription: { is_manual_subscription: true, plan_name: "creator" },
    });
    const stripe = createStripeMock();

    const res = await handler(makeRequest(), { stripe, supabaseClient });

    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.error, "MANUAL_SUBSCRIPTION");
    // No Stripe portal session should have been attempted for a manual sub.
    assertEquals(stripe.portalSessions.length, 0);
  } finally { restoreEnv(); }
});

Deno.test("rate limit exceeded returns 429", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock({
      rateLimitRows: [
        { id: "1", created_at: new Date().toISOString() },
        { id: "2", created_at: new Date().toISOString() },
        { id: "3", created_at: new Date().toISOString() },
        { id: "4", created_at: new Date().toISOString() },
        { id: "5", created_at: new Date().toISOString() },
      ],
    });
    const stripe = createStripeMock();

    const res = await handler(makeRequest(), { stripe, supabaseClient });

    assertEquals(res.status, 429);
  } finally { restoreEnv(); }
});

Deno.test("portal session is created with return_url back to /billing", async () => {
  setEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const headers = new Headers({
      "content-type": "application/json",
      "Authorization": "Bearer test",
      "origin": "https://app.motionmax.io",
    });
    const req = new Request("https://example.com/customer-portal", { method: "POST", headers });

    const res = await handler(req, { stripe, supabaseClient });

    assertEquals(res.status, 200);
    assertEquals(stripe.portalSessions.length, 1);
    const params = stripe.portalSessions[0];
    assertEquals(params.return_url, "https://app.motionmax.io/billing");
  } finally { restoreEnv(); }
});
