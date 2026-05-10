// Deno unit tests for the REAL delete-account handler.
// Probe F-10-05 (B-NEW-20): tests the deployed `index.ts` via the
// `DeleteAccountDeps` injection seam. No mirrored handler.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { handler } from "./index.ts";

// ─── Supabase mock ────────────────────────────────────────────────────────────

interface TableConfig {
  maybeSingle?: { data: unknown; error: unknown };
  single?: { data: unknown; error: unknown };
  insertError?: { code?: string; message: string } | null;
}

function createSupaMock(opts: {
  user?: { id: string; email: string } | null;
  authError?: { message: string } | null;
  tables?: Record<string, TableConfig>;
} = {}) {
  const insertCalls: { table: string; data: unknown }[] = [];
  const updateCalls: { table: string; data: unknown }[] = [];

  const supa = {
    insertCalls,
    updateCalls,
    auth: {
      getUser: async (_token: string) => ({
        data: { user: opts.user === undefined ? { id: "user-test", email: "test@example.com" } : opts.user },
        error: opts.authError ?? null,
      }),
    },
    from(table: string) {
      const tableConfig: TableConfig = opts.tables?.[table] ?? {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () =>
        tableConfig.maybeSingle ?? { data: null, error: null };
      chain.single = async () =>
        tableConfig.single ?? { data: null, error: null };
      chain.insert = async (data: unknown) => {
        insertCalls.push({ table, data });
        return { error: tableConfig.insertError ?? null };
      };
      chain.update = (data: unknown) => {
        updateCalls.push({ table, data });
        return chain;
      };
      return chain;
    },
  };
  return supa;
}

function createStripeMock(opts: { cancelThrows?: boolean } = {}) {
  const cancelCalls: string[] = [];
  return {
    cancelCalls,
    subscriptions: {
      cancel: async (id: string) => {
        cancelCalls.push(id);
        if (opts.cancelThrows) throw new Error("Stripe error");
        return { id, status: "canceled" };
      },
    },
  };
}

function makeRequest(opts: { auth?: string | null; method?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? "Bearer test-token");
  }
  return new Request("https://example.com/delete-account", {
    method: opts.method ?? "POST",
    headers,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("returns 401 when Authorization header is missing", async () => {
  const supa = createSupaMock();
  const stripe = createStripeMock();

  const res = await handler(makeRequest({ auth: null }), { stripe, supabaseAdmin: supa });

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

Deno.test("returns 401 when JWT is invalid (auth.getUser returns error)", async () => {
  const supa = createSupaMock({
    user: null,
    authError: { message: "JWT expired" },
  });
  const stripe = createStripeMock();

  const res = await handler(makeRequest(), { stripe, supabaseAdmin: supa });

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Invalid token");
});

Deno.test("happy path: inserts deletion_requests row with scheduled_at = +7 days", async () => {
  const supa = createSupaMock({
    user: { id: "user-1", email: "alice@example.com" },
    tables: {
      subscriptions: { maybeSingle: { data: null, error: null } },
    },
  });
  const stripe = createStripeMock();

  const before = Date.now();
  const res = await handler(makeRequest(), { stripe, supabaseAdmin: supa });
  const after = Date.now();

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);

  // Verify the insert into deletion_requests
  const insert = supa.insertCalls.find((c) => c.table === "deletion_requests");
  assertEquals(Boolean(insert), true);
  const data = insert?.data as Record<string, unknown>;
  assertEquals(data.user_id, "user-1");
  assertEquals(data.email, "alice@example.com");
  assertEquals(data.status, "pending");

  // scheduled_at must be ~7 days in the future
  const scheduledAt = new Date(data.scheduled_at as string).getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  // Allow 5-second tolerance for test runtime
  assertEquals(scheduledAt >= before + sevenDaysMs - 5000, true);
  assertEquals(scheduledAt <= after + sevenDaysMs + 5000, true);
});

Deno.test("cancels active Stripe subscription before scheduling deletion", async () => {
  const supa = createSupaMock({
    user: { id: "user-with-sub", email: "bob@example.com" },
    tables: {
      subscriptions: {
        maybeSingle: {
          data: {
            stripe_customer_id: "cus_xyz",
            stripe_subscription_id: "sub_xyz",
            status: "active",
          },
          error: null,
        },
      },
    },
  });
  const stripe = createStripeMock();

  const res = await handler(makeRequest(), { stripe, supabaseAdmin: supa });

  assertEquals(res.status, 200);
  // Stripe cancel must have been called with the subscription id.
  assertEquals(stripe.cancelCalls, ["sub_xyz"]);
});

Deno.test("does NOT call Stripe cancel when subscription is not active", async () => {
  const supa = createSupaMock({
    user: { id: "user-canceled", email: "carol@example.com" },
    tables: {
      subscriptions: {
        maybeSingle: {
          data: {
            stripe_customer_id: "cus_canceled",
            stripe_subscription_id: "sub_canceled",
            status: "canceled", // already canceled
          },
          error: null,
        },
      },
    },
  });
  const stripe = createStripeMock();

  const res = await handler(makeRequest(), { stripe, supabaseAdmin: supa });

  assertEquals(res.status, 200);
  assertEquals(stripe.cancelCalls.length, 0);
});

Deno.test("Stripe cancellation failure does NOT block deletion request insert", async () => {
  const supa = createSupaMock({
    user: { id: "user-stripeflaky", email: "dan@example.com" },
    tables: {
      subscriptions: {
        maybeSingle: {
          data: {
            stripe_customer_id: "cus_flaky",
            stripe_subscription_id: "sub_flaky",
            status: "active",
          },
          error: null,
        },
      },
    },
  });
  const stripe = createStripeMock({ cancelThrows: true });

  const res = await handler(makeRequest(), { stripe, supabaseAdmin: supa });

  // Deletion request should still be inserted even if Stripe blew up.
  assertEquals(res.status, 200);
  const insert = supa.insertCalls.find((c) => c.table === "deletion_requests");
  assertEquals(Boolean(insert), true);
});

Deno.test("returns 500 when deletion_requests insert fails", async () => {
  const supa = createSupaMock({
    user: { id: "user-dbflaky", email: "eve@example.com" },
    tables: {
      subscriptions: { maybeSingle: { data: null, error: null } },
      deletion_requests: { insertError: { message: "DB write failed" } },
    },
  });
  const stripe = createStripeMock();

  const res = await handler(makeRequest(), { stripe, supabaseAdmin: supa });

  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Failed to schedule account deletion");
});

Deno.test("OPTIONS preflight returns CORS response without invoking auth", async () => {
  let authCalled = false;
  const supa = createSupaMock();
  const origGetUser = supa.auth.getUser;
  supa.auth.getUser = async (token: string) => {
    authCalled = true;
    return await origGetUser(token);
  };
  const stripe = createStripeMock();

  const req = new Request("https://example.com/delete-account", {
    method: "OPTIONS",
    headers: new Headers({ origin: "https://motionmax.io" }),
  });
  const res = await handler(req, { stripe, supabaseAdmin: supa });

  // Preflight is a 2xx. Exact code depends on handleCorsPreflightRequest helper
  // but it must NOT have invoked auth.getUser.
  assertEquals(res.status >= 200 && res.status < 300, true);
  assertEquals(authCalled, false);
});
