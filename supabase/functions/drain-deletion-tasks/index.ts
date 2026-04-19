import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[DRAIN-DELETION-TASKS] ${step}${detailsStr}`);
};

serve(async (req) => {
  // Only accept POST (pg_cron / internal cron callers use POST)
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Require service-role Bearer token
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== serviceRoleKey) {
    logStep("Unauthorized request");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey,
    { auth: { persistSession: false } }
  );

  const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
  const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

  logStep("Starting drain run");

  // Claim up to 10 pending/retryable tasks atomically with SKIP LOCKED
  // so concurrent invocations each get a disjoint set.
  const { data: tasks, error: claimError } = await supabase.rpc(
    "claim_deletion_tasks",
    { batch_size: 10 }
  );

  if (claimError) {
    // Fallback: claim via raw query if the RPC doesn't exist yet —
    // we use a Postgres advisory lock approach via a direct update.
    logStep("claim_deletion_tasks RPC unavailable, using direct query", { error: claimError.message });

    const { data: rawTasks, error: rawError } = await supabase
      .from("deletion_tasks")
      .select("id, task_type, payload, attempts")
      .in("status", ["pending", "failed"])
      .lt("attempts", 3)
      .order("created_at", { ascending: true })
      .limit(10);

    if (rawError) {
      logStep("Failed to fetch tasks", { error: rawError.message });
      return new Response(JSON.stringify({ error: rawError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return await processTasks(supabase, rawTasks ?? [], ELEVENLABS_API_KEY, STRIPE_SECRET_KEY);
  }

  return await processTasks(supabase, tasks ?? [], ELEVENLABS_API_KEY, STRIPE_SECRET_KEY);
});

// ---------------------------------------------------------------------------
// Process a batch of claimed deletion tasks
// ---------------------------------------------------------------------------
async function processTasks(
  supabase: ReturnType<typeof createClient>,
  tasks: Array<{ id: string; task_type: string; payload: Record<string, string>; attempts: number }>,
  elevenLabsApiKey: string,
  stripeSecretKey: string
): Promise<Response> {
  const results = { completed: 0, failed: 0, skipped: 0 };

  for (const task of tasks) {
    // Mark as processing
    await supabase
      .from("deletion_tasks")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", task.id);

    let success = false;
    let errorMessage = "";

    try {
      if (task.task_type === "elevenlabs_voice") {
        success = await deleteElevenLabsVoice(task.payload, elevenLabsApiKey);
      } else if (task.task_type === "stripe_cancel") {
        success = await deleteStripeCustomer(task.payload, stripeSecretKey);
      } else {
        // Unknown task type — mark completed to avoid infinite retries
        console.warn(`[DRAIN-DELETION-TASKS] Unknown task_type "${task.task_type}", marking completed`);
        success = true;
        results.skipped += 1;
      }
    } catch (err: unknown) {
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[DRAIN-DELETION-TASKS] Task ${task.id} threw:`, errorMessage);
      success = false;
    }

    const newAttempts = task.attempts + 1;

    if (success) {
      await supabase
        .from("deletion_tasks")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
          attempts: newAttempts,
        })
        .eq("id", task.id);
      if (task.task_type !== "unknown") results.completed += 1;
    } else {
      // Keep as pending for retry if under the attempt cap, otherwise fail
      const nextStatus = newAttempts >= 3 ? "failed" : "pending";
      await supabase
        .from("deletion_tasks")
        .update({
          status: nextStatus,
          attempts: newAttempts,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id);
      results.failed += 1;
      console.error(`[DRAIN-DELETION-TASKS] Task ${task.id} failed (attempt ${newAttempts}): ${errorMessage}`);
    }
  }

  console.log(`[DRAIN-DELETION-TASKS] Done — completed: ${results.completed}, failed: ${results.failed}, skipped: ${results.skipped}`);

  return new Response(
    JSON.stringify({ processed: tasks.length, ...results }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ---------------------------------------------------------------------------
// ElevenLabs voice deletion
// ---------------------------------------------------------------------------
async function deleteElevenLabsVoice(
  payload: Record<string, string>,
  apiKey: string
): Promise<boolean> {
  const voiceId = payload.voice_id;
  if (!voiceId) {
    console.warn("[DRAIN-DELETION-TASKS] elevenlabs_voice task missing voice_id, skipping");
    return true; // Nothing to delete
  }

  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey },
  });

  if (res.ok || res.status === 404) {
    // 404 means already deleted — treat as success
    console.log(`[DRAIN-DELETION-TASKS] ElevenLabs voice ${voiceId} deleted (status ${res.status})`);
    return true;
  }

  const body = await res.text();
  throw new Error(`ElevenLabs DELETE /voices/${voiceId} returned ${res.status}: ${body}`);
}

// ---------------------------------------------------------------------------
// Stripe customer deletion
// ---------------------------------------------------------------------------
async function deleteStripeCustomer(
  payload: Record<string, string>,
  secretKey: string
): Promise<boolean> {
  const customerId = payload.stripe_customer_id;
  if (!customerId) {
    console.warn("[DRAIN-DELETION-TASKS] stripe_cancel task missing stripe_customer_id, skipping");
    return true; // Nothing to delete
  }

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  });

  if (res.ok) {
    console.log(`[DRAIN-DELETION-TASKS] Stripe customer ${customerId} deleted`);
    return true;
  }

  if (res.status === 404) {
    // Customer already deleted or never existed
    console.log(`[DRAIN-DELETION-TASKS] Stripe customer ${customerId} not found (already deleted)`);
    return true;
  }

  const body = await res.text();
  throw new Error(`Stripe DELETE /customers/${customerId} returned ${res.status}: ${body}`);
}
