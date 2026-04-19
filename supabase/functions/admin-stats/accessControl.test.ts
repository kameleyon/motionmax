// Deno unit tests — admin-stats access control.
// Tests the invariant: non-admin users must receive HTTP 403.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";

// ── Minimal supabase mock ─────────────────────────────────────────────────────

function createSupaMock(opts: {
  getUser?: { user: { id: string } | null; error: unknown };
  adminRole?: { data: { role: string } | null; error: unknown };
  rateLimitData?: { data: { request_count: number } | null };
}) {
  const defaultGetUser = opts.getUser ?? { user: { id: "user-1" }, error: null };
  const defaultAdminRole = opts.adminRole ?? { data: null, error: null };
  const defaultRateLimit = opts.rateLimitData ?? { data: null };

  return {
    auth: {
      getUser: async (_token: string) => ({ data: defaultGetUser }),
    },
    from(table: string) {
      return {
        select: () => this.from(table),
        eq: () => this.from(table),
        single: async () =>
          table === "user_roles" ? defaultAdminRole : { data: null, error: null },
        maybeSingle: async () =>
          table === "rate_limits"
            ? defaultRateLimit
            : { data: null, error: null },
        insert: async () => ({ error: null }),
        update: () => this.from(table),
        upsert: async () => ({ error: null }),
      };
    },
  };
}

// ── Handler factory — mirrors admin-stats auth/admin check ────────────────────

async function handleAdminRequest(
  req: Request,
  supabase: ReturnType<typeof createSupaMock>
): Promise<Response> {
  const corsHeaders = { "Access-Control-Allow-Origin": "*" };

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "No authorization header provided" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: userData } = await supabase.auth.getUser(token);

  if (!userData.user) {
    return new Response(
      JSON.stringify({ error: "Authentication error: Invalid session" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: adminRole, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("role", "admin")
    .single();

  if (roleError || !adminRole) {
    return new Response(
      JSON.stringify({ error: "Access denied. Admin privileges required." }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("admin-stats: 401 when no Authorization header", async () => {
  const req = new Request("https://fn.test/admin-stats", { method: "POST" });
  const supabase = createSupaMock({});
  const res = await handleAdminRequest(req, supabase);
  assertEquals(res.status, 401);
});

Deno.test("admin-stats: 401 when JWT resolves to no user", async () => {
  const req = new Request("https://fn.test/admin-stats", {
    method: "POST",
    headers: { Authorization: "Bearer bad-token" },
  });
  const supabase = createSupaMock({ getUser: { user: null, error: new Error("invalid") } });
  const res = await handleAdminRequest(req, supabase);
  assertEquals(res.status, 401);
});

Deno.test("admin-stats: 403 for authenticated non-admin user", async () => {
  const req = new Request("https://fn.test/admin-stats", {
    method: "POST",
    headers: { Authorization: "Bearer valid-user-token" },
  });
  // user_roles returns no row → not admin
  const supabase = createSupaMock({
    getUser: { user: { id: "user-regular" }, error: null },
    adminRole: { data: null, error: { code: "PGRST116", message: "no rows" } },
  });
  const res = await handleAdminRequest(req, supabase);
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, "Access denied. Admin privileges required.");
});

Deno.test("admin-stats: 200 for authenticated admin user", async () => {
  const req = new Request("https://fn.test/admin-stats", {
    method: "POST",
    headers: { Authorization: "Bearer valid-admin-token" },
  });
  const supabase = createSupaMock({
    getUser: { user: { id: "admin-1" }, error: null },
    adminRole: { data: { role: "admin" }, error: null },
  });
  const res = await handleAdminRequest(req, supabase);
  assertEquals(res.status, 200);
});
