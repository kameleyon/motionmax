// Deno unit tests for the REAL create-checkout handler (Probe F-10-05 / B-NEW-20).
//
// Covers the two new B-NEW-21 request shapes plus the legacy `priceId` shape:
//   1. { tier, cycle, multipack }                — subscription
//   2. { kind: 'topup', sku }                    — one-time credit pack
//   3. { priceId, mode }                         — legacy
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "./index.ts";

// ─── Mock factories ───────────────────────────────────────────────────────────

interface SupaOpts {
  user?: { id: string; email: string } | null;
  authError?: { message: string } | null;
  rateLimitRows?: unknown[];
  /** Captures `update(...).eq(...)` writes to `profiles`. */
  profileUpdateError?: { message: string } | null;
}

function createSupaMock(opts: SupaOpts = {}) {
  const insertCalls: { table: string; data: unknown }[] = [];
  const updateCalls: { table: string; data: unknown }[] = [];

  const supa = {
    insertCalls,
    updateCalls,
    auth: {
      getUser: async () => ({
        data: { user: opts.user === undefined ? { id: "u1", email: "u1@example.com" } : opts.user },
        error: opts.authError ?? null,
      }),
    },
    from(table: string) {
      const chain: Record<string, unknown> = {};
      // Tracks whether this chain instance is in "post-update" mode so that
      // `.eq(...)` can resolve as a write-completion Promise instead of
      // returning the chain. Rate-limit reads still need .eq() chainable.
      let isUpdateMode = false;

      chain.select = () => chain;
      chain.eq = () => {
        if (isUpdateMode) {
          return Promise.resolve({ error: opts.profileUpdateError ?? null });
        }
        return chain;
      };
      chain.gte = () => chain;
      chain.order = async () => {
        if (table === "rate_limits") {
          return { data: opts.rateLimitRows ?? [], error: null };
        }
        return { data: [], error: null };
      };
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.insert = async (data: unknown) => {
        insertCalls.push({ table, data });
        return { error: null };
      };
      chain.update = (data: unknown) => {
        updateCalls.push({ table, data });
        isUpdateMode = true;
        return chain;
      };
      return chain;
    },
  };
  return supa;
}

interface StripeOpts {
  /** Override the price returned by stripe.prices.retrieve. */
  price?: Record<string, unknown>;
  /** Override the Customer.list result. */
  customers?: Array<{ id: string }>;
  /** Override the session URL returned by checkout.sessions.create. */
  sessionUrl?: string;
}

function createStripeMock(opts: StripeOpts = {}) {
  const sessionsCreated: Record<string, unknown>[] = [];
  return {
    sessionsCreated,
    prices: {
      retrieve: async (id: string, _opts?: unknown) =>
        opts.price ?? {
          id,
          active: true,
          product: { id: "prod_UHakcDFbS7Vw7z", metadata: {} },
        },
    },
    customers: {
      list: async (_opts: unknown) => ({ data: opts.customers ?? [] }),
    },
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          sessionsCreated.push(params);
          return {
            id: "cs_test",
            url: opts.sessionUrl ?? "https://checkout.stripe.com/test-session",
          };
        },
      },
    },
  };
}

function makeRequest(body: unknown, opts: { auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? "Bearer test-token");
  }
  return new Request("https://example.com/create-checkout", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ─── Env helpers ──────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_MODE",
  "STRIPE_PRICE_CREATOR_MONTHLY_TEST",
  "STRIPE_PRICE_CREATOR_YEARLY_TEST",
  "STRIPE_PRICE_STUDIO_MONTHLY_TEST",
  "STRIPE_PRICE_TOPUP_QUICK_TEST",
  "STRIPE_PRICE_TOPUP_PLUS_TEST",
  "STRIPE_COUPON_CREATOR_PROMO_TEST",
  "STRIPE_COUPON_STUDIO_PROMO_TEST",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function setTestEnv() {
  for (const k of ENV_KEYS) ORIGINAL_ENV[k] = Deno.env.get(k);
  Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc");
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_xxx");
  Deno.env.set("STRIPE_MODE", "test");
  Deno.env.set("STRIPE_PRICE_CREATOR_MONTHLY_TEST", "price_creator_monthly");
  Deno.env.set("STRIPE_PRICE_CREATOR_YEARLY_TEST", "price_creator_yearly");
  Deno.env.set("STRIPE_PRICE_STUDIO_MONTHLY_TEST", "price_studio_monthly");
  Deno.env.set("STRIPE_PRICE_TOPUP_QUICK_TEST", "price_topup_quick");
  Deno.env.set("STRIPE_PRICE_TOPUP_PLUS_TEST", "price_topup_plus");
  Deno.env.set("STRIPE_COUPON_CREATOR_PROMO_TEST", "coupon_creator_promo");
  Deno.env.set("STRIPE_COUPON_STUDIO_PROMO_TEST", "coupon_studio_promo");
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

// A pass-through kill-switch override: never blocks.
const noKill = async () => null;

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("returns 500 with auth error when Authorization header is missing", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock({ user: undefined });
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ tier: "creator", cycle: "monthly" }, { auth: null }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 500);
    const body = await res.json();
    // The handler maps "No authorization header provided" through the generic
    // catch-all (it isn't a UserFacingError).
    assertEquals(typeof body.error, "string");
  } finally { restoreEnv(); }
});

Deno.test("happy path subscription: { tier:'creator', cycle:'monthly', multipack:1 } returns checkout URL", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ tier: "creator", cycle: "monthly", multipack: 1 }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.url, "https://checkout.stripe.com/test-session");
    assertEquals(stripe.sessionsCreated.length, 1);

    const params = stripe.sessionsCreated[0];
    assertEquals(params.mode, "subscription");
    const lineItems = params.line_items as Array<{ price: string; quantity: number }>;
    assertEquals(lineItems[0].price, "price_creator_monthly");
    assertEquals(lineItems[0].quantity, 1);

    // Promo coupon ATTACHES on monthly.
    const discounts = params.discounts as Array<{ coupon: string }> | undefined;
    assertEquals(discounts?.[0].coupon, "coupon_creator_promo");
  } finally { restoreEnv(); }
});

Deno.test("yearly subscription: does NOT attach the monthly promo coupon", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ tier: "creator", cycle: "yearly", multipack: 1 }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 200);
    const params = stripe.sessionsCreated[0];
    assertEquals(params.discounts, undefined);
  } finally { restoreEnv(); }
});

Deno.test("multipack quantity is propagated to Stripe line_items", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ tier: "creator", cycle: "monthly", multipack: 4 }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 200);
    const params = stripe.sessionsCreated[0];
    const lineItems = params.line_items as Array<{ price: string; quantity: number }>;
    assertEquals(lineItems[0].quantity, 4);
  } finally { restoreEnv(); }
});

Deno.test("multipack out of range (7) returns user-facing error", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ tier: "creator", cycle: "monthly", multipack: 7 }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "Multipack must be between 1 and 6.");
  } finally { restoreEnv(); }
});

Deno.test("happy path topup: { kind:'topup', sku:'quick' } resolves to topup price + payment mode", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock({
      price: {
        id: "price_topup_quick",
        active: true,
        product: { id: "prod_UHalTrTNeIhUNX", metadata: {} },
      },
    });

    const res = await handler(makeRequest({ kind: "topup", sku: "quick" }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 200);
    const params = stripe.sessionsCreated[0];
    assertEquals(params.mode, "payment");
    const lineItems = params.line_items as Array<{ price: string; quantity: number }>;
    assertEquals(lineItems[0].price, "price_topup_quick");
    // Top-ups never get the monthly promo coupon.
    assertEquals(params.discounts, undefined);
  } finally { restoreEnv(); }
});

Deno.test("topup with unknown sku returns user-facing error", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(makeRequest({ kind: "topup", sku: "phantom" }), {
      stripe,
      supabaseClient,
      rejectIfMaintenanceOrKilled: noKill,
    });

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error.includes("not configured"), true);
  } finally { restoreEnv(); }
});

Deno.test("EU cooling-off waiver: persists eu_cooling_off_waived_at on profiles BEFORE checkout", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(
      makeRequest({
        tier: "creator",
        cycle: "monthly",
        multipack: 1,
        eu_cooling_off_waived: true,
      }),
      { stripe, supabaseClient, rejectIfMaintenanceOrKilled: noKill },
    );

    assertEquals(res.status, 200);
    // The handler does .from('profiles').update({...}).eq('id', user.id).
    const profUpdate = supabaseClient.updateCalls.find((c) => c.table === "profiles");
    assertEquals(Boolean(profUpdate), true);
    const data = profUpdate?.data as Record<string, unknown>;
    assertEquals(typeof data.eu_cooling_off_waived_at, "string");
    // Sanity-check the timestamp is "recent" (parses + within 60s of now).
    const tsMs = new Date(data.eu_cooling_off_waived_at as string).getTime();
    assertEquals(Math.abs(tsMs - Date.now()) < 60_000, true);
  } finally { restoreEnv(); }
});

Deno.test("EU cooling-off NOT waived: profiles is not updated", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(
      makeRequest({ tier: "creator", cycle: "monthly", multipack: 1 /* no waiver flag */ }),
      { stripe, supabaseClient, rejectIfMaintenanceOrKilled: noKill },
    );

    assertEquals(res.status, 200);
    const profUpdate = supabaseClient.updateCalls.find((c) => c.table === "profiles");
    assertEquals(profUpdate, undefined);
  } finally { restoreEnv(); }
});

Deno.test("kill-switch active: handler returns the kill-switch's blocking response unchanged", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();
    const blockingRes = new Response(
      JSON.stringify({ error: "Payments paused" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );

    const res = await handler(
      makeRequest({ tier: "creator", cycle: "monthly", multipack: 1 }),
      {
        stripe,
        supabaseClient,
        rejectIfMaintenanceOrKilled: async () => blockingRes,
      },
    );

    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error, "Payments paused");
    // No checkout session was created.
    assertEquals(stripe.sessionsCreated.length, 0);
  } finally { restoreEnv(); }
});

Deno.test("rate limit exceeded returns 429", async () => {
  setTestEnv();
  try {
    // The rateLimit helper does .from('rate_limits').select('id, created_at')
    // .eq('key', ...).gte('created_at', ...).order('created_at', desc).
    // Pre-populate with maxRequests=5 rows to trip the limit.
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

    const res = await handler(
      makeRequest({ tier: "creator", cycle: "monthly", multipack: 1 }),
      { stripe, supabaseClient, rejectIfMaintenanceOrKilled: noKill },
    );

    assertEquals(res.status, 429);
  } finally { restoreEnv(); }
});

Deno.test("unknown subscription tier returns user-facing error", async () => {
  setTestEnv();
  try {
    const supabaseClient = createSupaMock();
    const stripe = createStripeMock();

    const res = await handler(
      makeRequest({ tier: "platinum", cycle: "monthly", multipack: 1 }),
      { stripe, supabaseClient, rejectIfMaintenanceOrKilled: noKill },
    );

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "Unknown subscription tier");
  } finally { restoreEnv(); }
});
