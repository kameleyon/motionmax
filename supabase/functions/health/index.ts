/**
 * /health — lightweight uptime probe for external monitors (UptimeRobot, BetterStack, etc.)
 *
 * Returns 200 with JSON body when the edge function runtime is healthy.
 * No auth required — this is intentionally public for uptime monitors.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async () => {
  const start = Date.now();

  // Lightweight DB ping — just checks that the connection is alive
  let dbStatus: "ok" | "error" = "error";
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await supabase.from("profiles").select("user_id").limit(1);
      dbStatus = error ? "error" : "ok";
    } catch {
      dbStatus = "error";
    }
  }

  const latencyMs = Date.now() - start;
  const healthy = dbStatus === "ok";

  return new Response(
    JSON.stringify({
      status: healthy ? "ok" : "degraded",
      ts: new Date().toISOString(),
      db: dbStatus,
      latency_ms: latencyMs,
    }),
    {
      status: healthy ? 200 : 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
});
