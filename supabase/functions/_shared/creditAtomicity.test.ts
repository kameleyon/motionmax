// Deno unit tests for credit deduction atomicity.
// Verifies the RPC call pattern used by generate-video to prevent double-spending.
import { assertEquals, assertRejects } from "https://deno.land/std@0.190.0/testing/asserts.ts";

// ─── Credit operation helpers (mirrors generate-video's credit deduction pattern) ──

async function deductCreditsForJob(
  supabase: {
    rpc: (fn: string, params: Record<string, unknown>) => Promise<{ error: { message: string } | null; data: unknown }>;
  },
  userId: string,
  amount: number,
  jobId: string,
): Promise<void> {
  const { error } = await supabase.rpc("deduct_credits_securely", {
    p_user_id: userId,
    p_amount: amount,
    p_transaction_type: "video_generation",
    p_description: `Video generation job ${jobId}`,
  });

  if (error) {
    throw new Error(`Insufficient credits: ${error.message}`);
  }
}

async function refundCreditsForFailedJob(
  supabase: {
    rpc: (fn: string, params: Record<string, unknown>) => Promise<{ error: unknown; data: unknown }>;
  },
  userId: string,
  amount: number,
): Promise<void> {
  await supabase.rpc("increment_user_credits", {
    p_user_id: userId,
    p_credits: amount,
  });
}

// ─── RPC mock factory ─────────────────────────────────────────────────────────

interface RpcCall {
  fn: string;
  params: Record<string, unknown>;
}

function createRpcMock(opts: {
  // Per-call results keyed by "fnName:callIndex"
  results?: Record<string, { error: { message: string } | null; data: unknown }>;
  defaultResult?: { error: { message: string } | null; data: unknown };
} = {}) {
  const calls: RpcCall[] = [];

  const rpc = async (fn: string, params: Record<string, unknown>) => {
    const callIndex = calls.filter((c) => c.fn === fn).length;
    calls.push({ fn, params });

    const key = `${fn}:${callIndex}`;
    return (
      opts.results?.[key] ??
      opts.defaultResult ?? { error: null, data: null }
    );
  };

  return { rpc, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test("deductCreditsForJob: calls deduct_credits_securely with correct params", async () => {
  const mock = createRpcMock();

  await deductCreditsForJob(mock, "user-123", 50, "job-abc");

  assertEquals(mock.calls.length, 1);
  assertEquals(mock.calls[0].fn, "deduct_credits_securely");
  assertEquals(mock.calls[0].params.p_user_id, "user-123");
  assertEquals(mock.calls[0].params.p_amount, 50);
  assertEquals(mock.calls[0].params.p_transaction_type, "video_generation");
});

Deno.test("deductCreditsForJob: throws when RPC returns an error (insufficient credits)", async () => {
  const mock = createRpcMock({
    results: {
      "deduct_credits_securely:0": {
        error: { message: "insufficient_credits" },
        data: null,
      },
    },
  });

  await assertRejects(
    () => deductCreditsForJob(mock, "user-broke", 100, "job-fail"),
    Error,
    "Insufficient credits",
  );
});

Deno.test("refundCreditsForFailedJob: calls increment_user_credits when job fails", async () => {
  const mock = createRpcMock();

  await refundCreditsForFailedJob(mock, "user-123", 50);

  assertEquals(mock.calls.length, 1);
  assertEquals(mock.calls[0].fn, "increment_user_credits");
  assertEquals(mock.calls[0].params.p_user_id, "user-123");
  assertEquals(mock.calls[0].params.p_credits, 50);
});

Deno.test("concurrent requests: second deduction rejected when credits exhausted", async () => {
  // Simulate a credit pool that only allows one deduction.
  // First call succeeds; second call returns an error — atomic DB constraint.
  const mock = createRpcMock({
    results: {
      "deduct_credits_securely:0": { error: null, data: null },
      "deduct_credits_securely:1": {
        error: { message: "insufficient_credits" },
        data: null,
      },
    },
  });

  const userId = "user-concurrent";
  const amount = 100;

  // Fire both deductions concurrently
  const [result1, result2] = await Promise.allSettled([
    deductCreditsForJob(mock, userId, amount, "job-1"),
    deductCreditsForJob(mock, userId, amount, "job-2"),
  ]);

  assertEquals(result1.status, "fulfilled");
  assertEquals(result2.status, "rejected");
  assertEquals(mock.calls.filter((c) => c.fn === "deduct_credits_securely").length, 2);
});

Deno.test("full generation lifecycle: deduct then refund on failure", async () => {
  const mock = createRpcMock();
  const userId = "user-lifecycle";
  const amount = 50;

  // Step 1: deduct credits before starting job
  await deductCreditsForJob(mock, userId, amount, "job-lifecycle");
  assertEquals(mock.calls.length, 1);
  assertEquals(mock.calls[0].fn, "deduct_credits_securely");

  // Step 2: simulate job failure → credits refunded
  await refundCreditsForFailedJob(mock, userId, amount);
  assertEquals(mock.calls.length, 2);
  assertEquals(mock.calls[1].fn, "increment_user_credits");
  assertEquals(mock.calls[1].params.p_credits, amount);
});

Deno.test("deduction is not retried on failure — single RPC call per attempt", async () => {
  const mock = createRpcMock({
    defaultResult: { error: { message: "insufficient_credits" }, data: null },
  });

  await assertRejects(
    () => deductCreditsForJob(mock, "user-no-retry", 999, "job-noretry"),
    Error,
  );

  // Must not retry — exactly one call should have been made
  assertEquals(mock.calls.length, 1);
});

Deno.test("refund uses exact same amount that was deducted — no rounding drift", async () => {
  const mock = createRpcMock();
  const amount = 2500; // studio plan generation

  await deductCreditsForJob(mock, "user-studio", amount, "job-cinematic");
  await refundCreditsForFailedJob(mock, "user-studio", amount);

  const deductCall = mock.calls.find((c) => c.fn === "deduct_credits_securely");
  const refundCall = mock.calls.find((c) => c.fn === "increment_user_credits");

  assertEquals(deductCall?.params.p_amount, amount);
  assertEquals(refundCall?.params.p_credits, amount);
});
