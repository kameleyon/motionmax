// Deno unit tests for stripe-webhook handler.
// Uses a handler factory (accepts injected deps) to avoid ESM import-cache limitations.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { assertSpyCalls, spy } from "https://deno.land/std@0.190.0/testing/mock.ts";
import {
  creditPackProducts,
  monthlyCredits,
  subscriptionProducts,
} from "../_shared/stripeProducts.ts";

// ─── Supabase mock factory ────────────────────────────────────────────────────

interface TableConfig {
  single?: { data: unknown; error: unknown };
  maybeSingle?: { data: unknown; error: unknown };
  insertError?: { code?: string; message: string } | null;
}

function createSupaMock(opts: {
  webhookInsertError?: { code: string; message: string } | null;
  tables?: Record<string, TableConfig>;
  rpc?: { error: unknown; data: unknown };
} = {}) {
  const insertCalls: { table: string; data: unknown }[] = [];
  const updateCalls: { table: string; data: unknown }[] = [];
  const rpcCalls: { fn: string; params: unknown }[] = [];

  return {
    insertCalls,
    updateCalls,
    rpcCalls,
    from(table: string) {
      const tableConfig: TableConfig = opts.tables?.[table] ?? {};
      const chain: Record<string, unknown> = {};

      const makeChain = (): typeof chain => {
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.limit = () => chain;
        chain.single = async () =>
          tableConfig.single ?? { data: null, error: null };
        chain.maybeSingle = async () =>
          tableConfig.maybeSingle ?? { data: null, error: null };
        chain.insert = async (data: unknown) => {
          insertCalls.push({ table, data });
          if (table === "webhook_events") {
            return { error: opts.webhookInsertError ?? null };
          }
          return { error: tableConfig.insertError ?? null };
        };
        chain.update = (data: unknown) => {
          updateCalls.push({ table, data });
          return chain;
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
        listLineItems: async (_sessionId: string) => ({
          data: opts.lineItems ?? [],
        }),
      },
    },
    subscriptions: {
      retrieve: async (_id: string) => opts.subscription ?? null,
    },
  };
}

// ─── Handler factory (mirrors index.ts logic with injected deps) ──────────────

async function webhookHandler(
  req: Request,
  stripe: ReturnType<typeof createStripeMock>,
  supabaseAdmin: ReturnType<typeof createSupaMock>,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const corsHeaders = { "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response(
      JSON.stringify({ error: "Webhook secret not configured" }),
      { headers: corsHeaders, status: 500 },
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response(
      JSON.stringify({ error: "No signature provided" }),
      { headers: corsHeaders, status: 400 },
    );
  }

  const body = await req.text();

  let event: Record<string, unknown>;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
    ) as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({ error: "Signature verification failed" }),
      { headers: corsHeaders, status: 400 },
    );
  }

  const { error: idempotencyError } = await supabaseAdmin
    .from("webhook_events")
    .insert({ event_id: event.id, event_type: event.type }) as { error: { code?: string; message: string } | null };

  if (idempotencyError?.code === "23505") {
    return new Response(
      JSON.stringify({ received: true, duplicate: true }),
      { headers: corsHeaders, status: 200 },
    );
  }
  if (idempotencyError) {
    throw new Error(`Idempotency check failed: ${idempotencyError.message}`);
  }

  const eventData = event.data as Record<string, unknown>;
  const eventObj = eventData.object as Record<string, unknown>;

  switch (event.type) {
    case "checkout.session.completed": {
      const userId =
        (eventObj.metadata as Record<string, string> | undefined)?.user_id ||
        (eventObj.client_reference_id as string | undefined);
      if (!userId) break;

      if (eventObj.mode === "payment") {
        const paymentIntentId = eventObj.payment_intent as string;
        if (paymentIntentId) {
          const { data: existingTx } = await supabaseAdmin
            .from("credit_transactions")
            .select("id")
            .eq("stripe_payment_intent_id", paymentIntentId)
            .maybeSingle() as { data: unknown };
          if (existingTx) break;
        }

        const lineItems = await stripe.checkout.sessions.listLineItems(
          eventObj.id as string,
        );
        for (const item of lineItems.data) {
          const itemObj = item as Record<string, unknown>;
          const price = itemObj.price as Record<string, unknown>;
          const productRaw = price?.product;
          const productId =
            typeof productRaw === "string"
              ? productRaw
              : ((productRaw as Record<string, string>)?.id ?? "");
          const credits = creditPackProducts[productId];
          if (credits) {
            await supabaseAdmin.rpc("increment_user_credits", {
              p_user_id: userId,
              p_credits: credits,
            });
            await supabaseAdmin.from("credit_transactions").insert({
              user_id: userId,
              amount: credits,
              transaction_type: "purchase",
              description: `Purchased ${credits} credits`,
              stripe_payment_intent_id: paymentIntentId,
            });
          }
        }
      } else if (eventObj.mode === "subscription") {
        const subscriptionId = eventObj.subscription as string;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const subObj = subscription as Record<string, unknown>;
        const items = subObj.items as Record<string, unknown>;
        const itemsData = items.data as Record<string, unknown>[];
        const price = itemsData[0].price as Record<string, unknown>;
        const productRaw = price.product;
        const productId =
          typeof productRaw === "string"
            ? productRaw
            : ((productRaw as Record<string, string>)?.id ?? "");
        const planName = subscriptionProducts[productId] || "starter";

        const { data: existingSub } = await supabaseAdmin
          .from("subscriptions")
          .select("*")
          .eq("user_id", userId)
          .single() as { data: unknown };

        const subscriptionData = {
          user_id: userId,
          stripe_customer_id: eventObj.customer,
          stripe_subscription_id: subscriptionId,
          plan_name: planName,
          status: "active",
          current_period_start: new Date(
            (subObj.current_period_start as number) * 1000,
          ).toISOString(),
          current_period_end: new Date(
            (subObj.current_period_end as number) * 1000,
          ).toISOString(),
        };

        if (existingSub) {
          await supabaseAdmin
            .from("subscriptions")
            .update(subscriptionData)
            .eq("user_id", userId);
        } else {
          await supabaseAdmin.from("subscriptions").insert(subscriptionData);
        }
      }
      break;
    }

    case "invoice.paid": {
      if (eventObj.subscription) {
        const { data: subData } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id, plan_name")
          .eq("stripe_customer_id", eventObj.customer)
          .eq("status", "active")
          .single() as { data: { user_id: string; plan_name: string } | null };

        if (subData) {
          const credits = monthlyCredits[subData.plan_name] || 0;
          if (credits > 0) {
            const { error: creditError } = await supabaseAdmin.rpc(
              "increment_user_credits",
              { p_user_id: subData.user_id, p_credits: credits },
            ) as { error: unknown };
            if (!creditError) {
              await supabaseAdmin.from("credit_transactions").insert({
                user_id: subData.user_id,
                amount: credits,
                transaction_type: "monthly_renewal",
                description: `Monthly ${subData.plan_name} plan renewal: ${credits} credits`,
              });
            }
          }
        }
      }
      break;
    }

    case "charge.refunded": {
      const { data: refundSubData } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", eventObj.customer)
        .single() as { data: { user_id: string } | null };

      if (refundSubData) {
        const { data: txData } = await supabaseAdmin
          .from("credit_transactions")
          .select("amount")
          .eq("user_id", refundSubData.user_id)
          .eq("transaction_type", "purchase")
          .order("created_at", { ascending: false })
          .limit(1)
          .single() as { data: { amount: number } | null };

        if (txData && txData.amount > 0) {
          await supabaseAdmin.rpc("deduct_credits_securely", {
            p_user_id: refundSubData.user_id,
            p_amount: Math.abs(txData.amount),
            p_transaction_type: "refund_clawback",
            p_description: `Credits clawed back due to refund (charge ${eventObj.id})`,
          });
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      const { data: subData } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id, status")
        .eq("stripe_customer_id", eventObj.customer)
        .single() as { data: { user_id: string; status: string } | null };

      if (subData && subData.status === "active") {
        await supabaseAdmin
          .from("subscriptions")
          .update({ status: "past_due" })
          .eq("stripe_customer_id", eventObj.customer);
      }
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: corsHeaders,
    status: 200,
  });
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

const DEFAULT_ENV = {
  STRIPE_SECRET_KEY: "sk_test_xxx",
  STRIPE_WEBHOOK_SECRET: "whsec_test_xxx",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "svc_role_key",
};

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
  return { id: `evt_test_${Date.now()}`, type, data: { object: obj } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("returns 400 when stripe-signature header is missing", async () => {
  const stripe = createStripeMock();
  const supa = createSupaMock();

  const res = await webhookHandler(
    makeRequest('{"type":"test"}', null),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "No signature provided");
});

Deno.test("returns 400 when signature verification fails", async () => {
  const stripe = createStripeMock({ constructEventThrows: true });
  const supa = createSupaMock();

  const res = await webhookHandler(
    makeRequest('{"type":"test"}', "bad-sig"),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "Signature verification failed");
});

Deno.test("returns 500 when webhook secret is not configured", async () => {
  const stripe = createStripeMock();
  const supa = createSupaMock();

  const res = await webhookHandler(
    makeRequest('{"type":"test"}'),
    stripe,
    supa,
    { ...DEFAULT_ENV, STRIPE_WEBHOOK_SECRET: undefined },
  );

  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Webhook secret not configured");
});

Deno.test("returns 200 with duplicate flag for idempotency-blocked events", async () => {
  const event = makeEvent("checkout.session.completed");
  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock({
    webhookInsertError: { code: "23505", message: "duplicate key" },
  });

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.duplicate, true);
});

Deno.test("checkout.session.completed (payment): calls increment_user_credits RPC", async () => {
  const productId = "prod_UHalTrTNeIhUNX"; // 300 credits
  const event = makeEvent("checkout.session.completed", {
    mode: "payment",
    metadata: { user_id: "user-abc" },
    payment_intent: "pi_test",
    id: "cs_test",
    customer: "cus_test",
  });

  const stripe = createStripeMock({
    constructEventResult: event,
    lineItems: [{ price: { product: productId } }],
  });
  const supa = createSupaMock({
    tables: {
      credit_transactions: {
        maybeSingle: { data: null, error: null },
      },
    },
  });

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  assertEquals(supa.rpcCalls.length, 1);
  assertEquals(supa.rpcCalls[0].fn, "increment_user_credits");
  assertEquals((supa.rpcCalls[0].params as Record<string, unknown>).p_credits, 300);
  assertEquals((supa.rpcCalls[0].params as Record<string, unknown>).p_user_id, "user-abc");

  const txInsert = supa.insertCalls.find((c) => c.table === "credit_transactions");
  assertEquals((txInsert?.data as Record<string, unknown>)?.amount, 300);
  assertEquals((txInsert?.data as Record<string, unknown>)?.transaction_type, "purchase");
});

Deno.test("checkout.session.completed (subscription): upserts subscription record", async () => {
  const productId = "prod_UHakcDFbS7Vw7z"; // creator plan
  const now = Math.floor(Date.now() / 1000);
  const event = makeEvent("checkout.session.completed", {
    mode: "subscription",
    metadata: { user_id: "user-sub" },
    subscription: "sub_test",
    customer: "cus_sub",
  });

  const stripe = createStripeMock({
    constructEventResult: event,
    subscription: {
      items: { data: [{ price: { product: productId } }] },
      current_period_start: now,
      current_period_end: now + 2592000,
    },
  });
  const supa = createSupaMock({
    tables: {
      subscriptions: { single: { data: null, error: null } },
    },
  });

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  const subInsert = supa.insertCalls.find((c) => c.table === "subscriptions");
  assertEquals((subInsert?.data as Record<string, unknown>)?.plan_name, "creator");
  assertEquals((subInsert?.data as Record<string, unknown>)?.status, "active");
});

Deno.test("invoice.paid: grants monthly credits for active creator subscription", async () => {
  const event = makeEvent("invoice.paid", {
    subscription: "sub_test",
    customer: "cus_creator",
  });

  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock({
    tables: {
      subscriptions: {
        single: { data: { user_id: "user-creator", plan_name: "creator" }, error: null },
      },
    },
  });

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  assertEquals(supa.rpcCalls.length, 1);
  assertEquals(supa.rpcCalls[0].fn, "increment_user_credits");
  assertEquals((supa.rpcCalls[0].params as Record<string, unknown>).p_credits, 500); // creator = 500/mo

  const renewal = supa.insertCalls.find((c) => c.table === "credit_transactions");
  assertEquals((renewal?.data as Record<string, unknown>)?.transaction_type, "monthly_renewal");
});

Deno.test("invoice.paid: grants 2500 credits for studio plan renewal", async () => {
  const event = makeEvent("invoice.paid", {
    subscription: "sub_studio",
    customer: "cus_studio",
  });

  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock({
    tables: {
      subscriptions: {
        single: { data: { user_id: "user-studio", plan_name: "studio" }, error: null },
      },
    },
  });

  await webhookHandler(makeRequest(JSON.stringify(event)), stripe, supa, DEFAULT_ENV);

  assertEquals((supa.rpcCalls[0].params as Record<string, unknown>).p_credits, 2500);
});

Deno.test("invoice.paid: skips credit grant for non-subscription invoices", async () => {
  const event = makeEvent("invoice.paid", {
    subscription: null,
    customer: "cus_onetime",
  });

  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock();

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  assertEquals(supa.rpcCalls.length, 0);
});

Deno.test("charge.refunded: calls deduct_credits_securely with correct amount", async () => {
  const event = makeEvent("charge.refunded", {
    id: "ch_test",
    customer: "cus_refund",
    amount_refunded: 999,
  });

  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock({
    tables: {
      subscriptions: {
        single: { data: { user_id: "user-refund" }, error: null },
      },
      credit_transactions: {
        single: { data: { amount: 300 }, error: null },
      },
    },
  });

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  assertEquals(supa.rpcCalls.length, 1);
  assertEquals(supa.rpcCalls[0].fn, "deduct_credits_securely");
  assertEquals((supa.rpcCalls[0].params as Record<string, unknown>).p_amount, 300);
  assertEquals(
    (supa.rpcCalls[0].params as Record<string, unknown>).p_transaction_type,
    "refund_clawback",
  );
});

Deno.test("charge.refunded: skips clawback when no subscription found", async () => {
  const event = makeEvent("charge.refunded", {
    id: "ch_unknown",
    customer: "cus_unknown",
  });

  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock({
    tables: {
      subscriptions: { single: { data: null, error: null } },
    },
  });

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  assertEquals(supa.rpcCalls.length, 0);
});

Deno.test("invoice.payment_failed: marks active subscription as past_due", async () => {
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

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  const updated = supa.updateCalls.find((c) => c.table === "subscriptions");
  assertEquals((updated?.data as Record<string, unknown>)?.status, "past_due");
});

Deno.test("invoice.payment_failed: skips update when subscription already past_due", async () => {
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

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  assertEquals(supa.updateCalls.length, 0);
});

Deno.test("unknown event type: returns 200 without crashing", async () => {
  const event = makeEvent("some.future.event", { foo: "bar" });
  const stripe = createStripeMock({ constructEventResult: event });
  const supa = createSupaMock();

  const res = await webhookHandler(
    makeRequest(JSON.stringify(event)),
    stripe,
    supa,
    DEFAULT_ENV,
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.received, true);
  assertEquals(supa.rpcCalls.length, 0);
});
