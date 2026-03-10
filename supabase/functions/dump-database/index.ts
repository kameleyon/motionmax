import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function escapeSQL(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return val.toString();
  if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
  if (typeof val === "object") return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

function buildInsert(table: string, columns: string[], row: Record<string, unknown>): string {
  const vals = columns.map((c) => escapeSQL(row[c]));
  return `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING;`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: user.id });
  if (!isAdmin) {
    return new Response("Forbidden - admin only", { status: 403 });
  }

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const limit = parseInt(url.searchParams.get("limit") || "1000");

  const tables: Record<string, string[]> = {
    projects: ["id","user_id","created_at","updated_at","is_favorite","character_consistency_enabled","disable_expressions","status","brand_mark","presenter_focus","character_description","project_type","inspiration_style","story_tone","story_genre","voice_inclination","voice_type","voice_id","voice_name","thumbnail_url","title","description","content","format","length","style"],
    generations: ["id","project_id","user_id","progress","scenes","started_at","completed_at","created_at","video_url","error_message","status","script","audio_url"],
    credit_transactions: ["id","user_id","amount","created_at","transaction_type","description","stripe_payment_intent_id"],
    generation_costs: ["id","generation_id","user_id","openrouter_cost","replicate_cost","hypereal_cost","google_tts_cost","total_cost","created_at"],
    api_call_logs: ["id","generation_id","user_id","queue_time_ms","running_time_ms","total_duration_ms","cost","created_at","provider","model","status","error_message"],
    system_logs: ["id","user_id","details","generation_id","project_id","created_at","event_type","category","message"],
    video_generation_jobs: ["id","project_id","user_id","progress","payload","created_at","updated_at","task_type","error_message","status"],
    project_shares: ["id","project_id","user_id","created_at","expires_at","view_count","share_token"],
    generation_archives: ["id","original_id","project_id","user_id","progress","scenes","original_created_at","original_completed_at","deleted_at","status","script","audio_url","video_url","error_message"],
    profiles: ["id","user_id","created_at","updated_at","display_name","avatar_url"],
    user_roles: ["id","user_id","role","created_at","updated_at"],
    subscriptions: ["id","user_id","status","current_period_start","current_period_end","cancel_at_period_end","created_at","updated_at","stripe_subscription_id","plan_name","stripe_customer_id"],
    user_credits: ["id","user_id","credits_balance","total_purchased","total_used","created_at","updated_at"],
    user_api_keys: ["id","user_id","created_at","updated_at","gemini_api_key","replicate_api_token"],
    user_voices: ["id","user_id","created_at","voice_name","voice_id","sample_url","description"],
    user_flags: ["id","user_id","flagged_by","resolved_at","resolved_by","created_at","updated_at","reason","details","resolution_notes","flag_type"],
    webhook_events: ["id","processed_at","event_id","event_type"],
    admin_logs: ["id","admin_id","target_id","details","created_at","action","target_type","ip_address","user_agent"],
    project_characters: ["id","project_id","user_id","created_at","character_name","description","reference_image_url"],
  };

  if (!table) {
    const counts: Record<string, number> = {};
    for (const t of Object.keys(tables)) {
      const { count } = await supabase.from(t).select("*", { count: "exact", head: true });
      counts[t] = count || 0;
    }
    return new Response(JSON.stringify({ tables: counts, usage: "Add ?table=TABLE_NAME&offset=0&limit=1000 to get SQL INSERTs" }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  if (!tables[table]) {
    return new Response(JSON.stringify({ error: `Unknown table: ${table}`, available: Object.keys(tables) }), {
      status: 400,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const columns = tables[table];
  const { data, error, count } = await supabase
    .from(table)
    .select("*", { count: "exact" })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const lines = [`-- Table: ${table} (offset: ${offset}, limit: ${limit}, total: ${count})\n`];
  for (const row of data || []) {
    lines.push(buildInsert(table, columns, row));
  }

  const hasMore = (offset + limit) < (count || 0);
  if (hasMore) {
    lines.push(`\n-- MORE DATA: ?table=${table}&offset=${offset + limit}&limit=${limit}`);
  }
  lines.push(`\n-- End: ${data?.length || 0} rows, ${hasMore ? "more available" : "complete"}`);

  return new Response(lines.join("\n"), {
    headers: {
      ...corsHeaders,
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${table}_${offset}.sql"`,
    },
  });
});
