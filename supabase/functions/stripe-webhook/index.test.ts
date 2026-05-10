// Deno unit tests for the REAL stripe-webhook handler in ./index.ts.
//
// Probe F-10-03 (B-NEW-20) fix: this file used to define a `webhookHandler`
// factory that mirrored the production switch arms. A developer could
// silently break the deployed handler without breaking these tests because
// nothing in this file ever imported `./index.ts`. We now import the real
// `handler` and inject mocked Stripe + Supabase clients via the
// `WebhookDeps` parameter that index.ts now accepts.
//
// The deployed `serve(handler)` call is gated behind `import.meta.main` so
// tests can `import { handler } from "./index.ts"` without booting an
// HTTP listener.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "./index.ts";

// ─── Supabase mock factory ────────────────────────────────────────────────────

interface TableConfig {
  single?: { data: unknown; error: unknown };
  maybeSingle?: { data: unknown; error: unknown };
  insertError?: { code?: string; message: string } | null;
}

function createSupaMock(opts: {
  webhookEventsExisting?: { data: { event_id: string } | null; error: unknown };
  tables?: Record<string, TableConfig>;
  rpc?: { error: unknown; data: unknown };
} = {}) {
  const insertCalls: { table: string; data: unknown }[] = [];
  const updateCalls: { table: string; data: unknown }[] = [];
  const upsertCalls: { table: string; data: unknown; opts: unknown }[] = [];
  const rpcCalls: { fn: string; params: unknown }[] = [];
  const selectCalls: { table: string; columns: string }[] = [];

  return {
    insertCalls,
    updateCalls,
    upsertCalls,
    rpcCalls,
    selectCalls,
    auth: {
      admin: {
        getUserById: async (_id: string) => ({
          data: { user: { id: _id, email: `${_id}@example.com` } },
          error: null,
        }),
      },
    },
    from(table: string) {
      const tableConfig: TableConfig = opts.tables?.[table] ?? {};
      const chain: Record<string, unknown> = {};

      const makeChain = (): typeof chain => {
        chain.select = (cols = "*") => {
          selectCalls.push({ table, columns: String(cols) });
          return chain;
        };
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.limit = () => chain;
        chain.single = async () =>
          tableConfig.single ?? { data: null, error: null };
        chain.maybeSingle = async () => {
          if (table === "webhook_events") {
            return opts.webhookEventsExisting ?? { data: null, error: null };
          }
          return tableConfig.maybeSingle ?? { data: null, error: null };
        };
        chain.insert = async (data: unknown) => {
          insertCalls.push({ table, data });
          return { error: tableConfig.insertError ?? null };
        };
        chain.update = (data: unknown) => {
          updateCalls.push({ table, data });
          return chain;
        };
        chain.upsert = async (data: unknown, opts2: unknown) => {
          upsertCalls.push({ table, data, opts: opts2 });
          return { error: null };
        };
        return chain;
      };

      return makeChain();
    },
    rpc: async (fn: string, params: unknown) => {
      rpcCalls.push({ fn, params });
      return opts.rpc ?? { error: null, data: null };
    },
  };
}

// ─── Stripe mock factory ──────────────────────────────────────────────────────

function createStripeMock(opts: {
  constructEventResult?: unknown;
  constructEventThrows?: boolean;
  lineItems?: unknown[];
  subscription?: unknown;
} = {}) {
  return {
    webhooks: {
      constructEventAsync: async (_body: string, _sig: string, _secret: string) => {
        if (opts.constructEventThrows) throw new Error("Invalid signature");
        return opts.constructEventResult ?? null;
      },
    },
    checkout: {
      sessions: {
        listLineItems: async (_sessionId: string, _opts?: unknown) => ({
          data: opts.lineItems ?? [],
        }),
      },
    },
    subscriptions: {
      retrieve: async (_id: string) => opts.subscription ?? null,
    },
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

function setTestEnv(overrides: Partial<Record<typeof ENV_KEYS[number], string>> = {}) {
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = Deno.env.get(key);
  }
  Deno.env.set("STRIPE_SECRET_KEY", overrides.STRIPE_SECRET_KEY ?? "sk_test_xxx");
  if (overrides.STRIPE_WEBHOOK_SECRET === undefined && !("STRIPE_WEBHOOK_SECRET" in overrides)) {
    Deno.env.set("STRIPE_WEBHOOK_SECRET", "whsec_test_xxx");
  } else if (overrides.STRIPE_WEBHOOK_SECRET) {
    Deno.env.set("STRIPE_WEBHOOK_SECRET", overrides.STRIPE_WEBHOOK_SECRET);
  } else {
    Deno.env.delete("STRIPE_WEBHOOK_SECRET");
  }
  Deno.env.set("SUPABASE_URL", overrides.SUPABASE_URL ?? "https://test.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", overrides.SUPABASE_SERVICE_ROLE_KEY ?? "svc_role_key");
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const orig = ORIGINAL_ENV[key];
    if (orig === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, orig);
    }
  }
}

function makeRequest(
  body: string,
  signature: string | null = "t=123,v1=abc",
  method = "POST",
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);
  return new Request("https://example.com/stripe-webhook", {
    method,
    headers,
    body,
  });
}

function makeEvent(type: string, obj: Record<string, unknown> = {}) {
  return { id: `evt_test_${Date.now()}_${Math.random()}`, type, data: { object: obj } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
//
// Each test:
//   1. setTestEnv() — make Deno.env.get(...) return predictable values.
//   2. Build mock Stripe + Supabase clients.
//   3. Call handler(req, { stripe, supabaseAdmin }) — REAL handler logic.
//   4. Assert on the recorded RPC / insert / update calls.

Deno.test("returns 400 when stripe-signature header is missing", async () => {
  setTestEnv();
  try {
    const stripe = createStripeMock();
    const supa = createSupaMock();

    const res = await handler(makeRequest('{"type":"test"}', null), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "No signature provided");
  } finally { restoreEnv(); }
});

Deno.test("returns 400 when signature verification fails", async () => {
  setTestEnv();
  try {
    const stripe = createStripeMock({ constructEventThrows: true });
    const supa = createSupaMock();

    const res = await handler(makeRequest('{"type":"test"}', "bad-sig"), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "Signature verification failed");
  } finally { restoreEnv(); }
});

Deno.test("returns 500 when webhook secret is not configured", async () => {
  // Force STRIPE_WEBHOOK_SECRET to be unset.
  for (const key of ENV_KEYS) ORIGINAL_ENV[key] = Deno.env.get(key);
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_xxx");
  Deno.env.delete("STRIPE_WEBHOOK_SECRET");
  Deno.env.set("SUPABASE_URL", "https://test.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "svc_role_key");
  try {
    const stripe = createStripeMock();
    const supa = createSupaMock();

    const res = await handler(makeRequest('{"type":"test"}'), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "Webhook secret not configured");
  } finally { restoreEnv(); }
});

Deno.test("returns 200 with duplicate flag when webhook_events row already exists", async () => {
  setTestEnv();
  try {
    const event = makeEvent("checkout.session.completed");
    const stripe = createStripeMock({ constructEventResult: event });
    // Simulate the SELECT-first idempotency check finding an existing row.
    const supa = createSupaMock({
      webhookEventsExisting: { data: { event_id: event.id }, error: null },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.duplicate, true);
    // No handler arms ran because we short-circuited on duplicate.
    assertEquals(supa.rpcCalls.length, 0);
  } finally { restoreEnv(); }
});

Deno.test("checkout.session.completed (payment): calls increment_user_credits RPC", async () => {
  setTestEnv();
  try {
    const productId = "prod_UHalTrTNeIhUNX"; // 300 credits in creditPackProducts
    const event = makeEvent("checkout.session.completed", {
      mode: "payment",
      metadata: { user_id: "user-abc" },
      payment_intent: "pi_test",
      id: "cs_test",
      customer: "cus_test",
      amount_total: 1500,
      currency: "usd",
    });

    const stripe = createStripeMock({
      constructEventResult: event,
      lineItems: [{ price: { product: productId } }],
    });
    const supa = createSupaMock({
      tables: {
        credit_transactions: {
          // No prior transaction with this payment_intent_id.
          maybeSingle: { data: null, error: null },
        },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const incRpc = supa.rpcCalls.find((c) => c.fn === "increment_user_credits");
    assertEquals(Boolean(incRpc), true);
    assertEquals((incRpc?.params as Record<string, unknown>).p_credits, 300);
    assertEquals((incRpc?.params as Record<string, unknown>).p_user_id, "user-abc");

    const txInsert = supa.insertCalls.find((c) => c.table === "credit_transactions");
    assertEquals((txInsert?.data as Record<string, unknown>)?.amount, 300);
    assertEquals((txInsert?.data as Record<string, unknown>)?.transaction_type, "purchase");
  } finally { restoreEnv(); }
});

Deno.test("checkout.session.completed (subscription): upserts subscription row with plan_name=creator", async () => {
  setTestEnv();
  try {
    const productId = "prod_UHakcDFbS7Vw7z"; // creator plan
    const now = Math.floor(Date.now() / 1000);
    const event = makeEvent("checkout.session.completed", {
      mode: "subscription",
      metadata: { user_id: "user-sub" },
      subscription: "sub_test",
      customer: "cus_sub",
      amount_total: 2900,
    });

    const stripe = createStripeMock({
      constructEventResult: event,
      subscription: {
        items: { data: [{ price: { product: productId } }] },
        current_period_start: now,
        current_period_end: now + 2592000,
        cancel_at_period_end: false,
        status: "active",
      },
    });
    const supa = createSupaMock();

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    // Real handler uses upsert with onConflict: "user_id".
    const subUpsert = supa.upsertCalls.find((c) => c.table === "subscriptions");
    assertEquals(Boolean(subUpsert), true);
    assertEquals((subUpsert?.data as Record<string, unknown>)?.plan_name, "creator");
    assertEquals((subUpsert?.data as Record<string, unknown>)?.status, "active");
    assertEquals((subUpsert?.opts as { onConflict?: string })?.onConflict, "user_id");
  } finally { restoreEnv(); }
});

Deno.test("invoice.paid: grants monthly credits for active creator subscription", async () => {
  setTestEnv();
  try {
    const event = makeEvent("invoice.paid", {
      subscription: "sub_test",
      customer: "cus_creator",
      lines: { data: [] },
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock({
      tables: {
        subscriptions: {
          single: { data: { user_id: "user-creator", plan_name: "creator" }, error: null },
        },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const incRpc = supa.rpcCalls.find((c) => c.fn === "increment_user_credits");
    assertEquals(Boolean(incRpc), true);
    // creator monthlyCredits = 500
    assertEquals((incRpc?.params as Record<string, unknown>).p_credits, 500);

    const renewal = supa.insertCalls.find((c) => c.table === "credit_transactions");
    assertEquals((renewal?.data as Record<string, unknown>)?.transaction_type, "monthly_renewal");
  } finally { restoreEnv(); }
});

Deno.test("invoice.paid: grants 2500 credits for studio plan renewal", async () => {
  setTestEnv();
  try {
    const event = makeEvent("invoice.paid", {
      subscription: "sub_studio",
      customer: "cus_studio",
      lines: { data: [] },
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock({
      tables: {
        subscriptions: {
          single: { data: { user_id: "user-studio", plan_name: "studio" }, error: null },
        },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const incRpc = supa.rpcCalls.find((c) => c.fn === "increment_user_credits");
    assertEquals((incRpc?.params as Record<string, unknown>).p_credits, 2500);
  } finally { restoreEnv(); }
});

Deno.test("invoice.paid: skips credit grant for non-subscription invoices", async () => {
  setTestEnv();
  try {
    const event = makeEvent("invoice.paid", {
      subscription: null,
      customer: "cus_onetime",
      lines: { data: [] },
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock();

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const incRpc = supa.rpcCalls.find((c) => c.fn === "increment_user_credits");
    assertEquals(incRpc, undefined);
  } finally { restoreEnv(); }
});

Deno.test("charge.refunded: calls deduct_credits_securely with the original purchase amount", async () => {
  setTestEnv();
  try {
    const event = makeEvent("charge.refunded", {
      id: "ch_test",
      customer: "cus_refund",
      amount_refunded: 999,
      payment_intent: "pi_refund",
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock({
      tables: {
        subscriptions: {
          single: { data: { user_id: "user-refund" }, error: null },
        },
        credit_transactions: {
          maybeSingle: { data: { amount: 300 }, error: null },
        },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const dedRpc = supa.rpcCalls.find((c) => c.fn === "deduct_credits_securely");
    assertEquals(Boolean(dedRpc), true);
    assertEquals((dedRpc?.params as Record<string, unknown>).p_amount, 300);
    assertEquals(
      (dedRpc?.params as Record<string, unknown>).p_transaction_type,
      "refund_clawback",
    );
  } finally { restoreEnv(); }
});

Deno.test("charge.refunded: skips clawback when no subscription found", async () => {
  setTestEnv();
  try {
    const event = makeEvent("charge.refunded", {
      id: "ch_unknown",
      customer: "cus_unknown",
      payment_intent: "pi_unknown",
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock({
      tables: {
        subscriptions: { single: { data: null, error: null } },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const dedRpc = supa.rpcCalls.find((c) => c.fn === "deduct_credits_securely");
    assertEquals(dedRpc, undefined);
  } finally { restoreEnv(); }
});

Deno.test("invoice.payment_failed: marks active subscription as past_due", async () => {
  setTestEnv();
  try {
    const event = makeEvent("invoice.payment_failed", {
      id: "inv_fail",
      customer: "cus_failing",
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock({
      tables: {
        subscriptions: {
          single: { data: { user_id: "user-fail", status: "active" }, error: null },
        },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const updated = supa.updateCalls.find(
      (c) => c.table === "subscriptions" && (c.data as Record<string, unknown>).status === "past_due",
    );
    assertEquals(Boolean(updated), true);
  } finally { restoreEnv(); }
});

Deno.test("invoice.payment_failed: skips update when subscription already past_due", async () => {
  setTestEnv();
  try {
    const event = makeEvent("invoice.payment_failed", {
      id: "inv_already",
      customer: "cus_already",
    });

    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock({
      tables: {
        subscriptions: {
          single: { data: { user_id: "user-already", status: "past_due" }, error: null },
        },
      },
    });

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const updated = supa.updateCalls.find(
      (c) => c.table === "subscriptions" && (c.data as Record<string, unknown>).status === "past_due",
    );
    assertEquals(updated, undefined);
  } finally { restoreEnv(); }
});

Deno.test("unknown event type: returns 200 without crashing", async () => {
  setTestEnv();
  try {
    const event = makeEvent("some.future.event", { foo: "bar" });
    const stripe = createStripeMock({ constructEventResult: event });
    const supa = createSupaMock();

    const res = await handler(makeRequest(JSON.stringify(event)), { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.received, true);
    // No revenue-mutating RPC was called.
    const rev = supa.rpcCalls.filter((c) =>
      c.fn === "increment_user_credits" || c.fn === "deduct_credits_securely"
    );
    assertEquals(rev.length, 0);
  } finally { restoreEnv(); }
});

Deno.test("returns 413 when content-length exceeds 512KB", async () => {
  setTestEnv();
  try {
    const stripe = createStripeMock();
    const supa = createSupaMock();

    const headers = new Headers({
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=abc",
      "content-length": String(600 * 1024),
    });
    const req = new Request("https://example.com/stripe-webhook", {
      method: "POST",
      headers,
      body: '{"type":"test"}',
    });

    const res = await handler(req, { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 413);
  } finally { restoreEnv(); }
});

Deno.test("OPTIONS preflight: returns 204 without invoking Stripe", async () => {
  setTestEnv();
  try {
    let stripeCalled = false;
    const stripe = createStripeMock();
    // Wrap to detect any call.
    const originalConstruct = stripe.webhooks.constructEventAsync;
    stripe.webhooks.constructEventAsync = async (...args: unknown[]) => {
      stripeCalled = true;
      // deno-lint-ignore no-explicit-any
      return await (originalConstruct as any)(...args);
    };
    const supa = createSupaMock();

    const req = new Request("https://example.com/stripe-webhook", {
      method: "OPTIONS",
      headers: new Headers({ origin: "https://motionmax.io" }),
    });

    const res = await handler(req, { stripe, supabaseAdmin: supa });

    assertEquals(res.status, 204);
    assertEquals(stripeCalled, false);
  } finally { restoreEnv(); }
});
