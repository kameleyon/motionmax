// Deno unit tests — get-shared-project share flow.
// Validates: missing token → 400, non-existent/expired share → 404 (covers
// non-published projects since the DB RPC returns null for those), success → 200.
import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";

// ── extractStoragePath utility (duplicated from production for isolated testing) ─

function extractStoragePath(signedUrl: string): string | null {
  try {
    const url = new URL(signedUrl);
    const pathMatch = url.pathname.match(/\/storage\/v1\/object\/sign\/(.+)/);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

// ── Supabase mock factory ─────────────────────────────────────────────────────

function createSupaMock(opts: {
  rpcData?: unknown;
  rpcError?: { message: string } | null;
  rateLimitOk?: boolean;
}) {
  return {
    from(_table: string) {
      const self = this;
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.rateLimitOk !== false ? null : { request_count: 9999 }, error: null }) }) }),
        insert: async () => ({ error: null }),
        update: () => self.from(_table),
        upsert: async () => ({ error: null }),
      };
    },
    rpc: async (_fn: string, _params: unknown) => ({
      data: opts.rpcData ?? null,
      error: opts.rpcError ?? null,
    }),
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: async (_path: string, _exp: number) => ({
          data: { signedUrl: "https://cdn.test/signed?token=abc" },
          error: null,
        }),
      }),
    },
  };
}

// ── Minimal handler ───────────────────────────────────────────────────────────
// Mirrors the core request-handling path of the production edge function.

async function handleShareRequest(
  req: Request,
  supabase: ReturnType<typeof createSupaMock>
): Promise<Response> {
  const corsHeaders = { "Access-Control-Allow-Origin": "*" };

  let body: { token?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!body.token) {
    return new Response(JSON.stringify({ error: "Share token is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: shared, error: sharedError } = await supabase.rpc(
    "get_shared_project",
    { share_token_param: body.token }
  );

  if (sharedError || !shared) {
    return new Response(JSON.stringify({ error: "Share not found or expired" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ project: (shared as Record<string, unknown>).project, scenes: [] }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("get-shared-project: 400 when token is missing", async () => {
  const req = new Request("https://fn.test/get-shared-project", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  });
  const supabase = createSupaMock({});
  const res = await handleShareRequest(req, supabase);
  assertEquals(res.status, 400);
});

Deno.test("get-shared-project: 404 when RPC returns null (non-published/expired project)", async () => {
  const req = new Request("https://fn.test/get-shared-project", {
    method: "POST",
    body: JSON.stringify({ token: "some-token" }),
    headers: { "Content-Type": "application/json" },
  });
  // Simulates: project exists but is not published → DB RPC returns null
  const supabase = createSupaMock({ rpcData: null });
  const res = await handleShareRequest(req, supabase);
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "Share not found or expired");
});

Deno.test("get-shared-project: 404 when RPC returns an error", async () => {
  const req = new Request("https://fn.test/get-shared-project", {
    method: "POST",
    body: JSON.stringify({ token: "bad-token" }),
    headers: { "Content-Type": "application/json" },
  });
  const supabase = createSupaMock({ rpcError: { message: "no rows" } });
  const res = await handleShareRequest(req, supabase);
  assertEquals(res.status, 404);
});

Deno.test("get-shared-project: 200 for a valid published project share", async () => {
  const req = new Request("https://fn.test/get-shared-project", {
    method: "POST",
    body: JSON.stringify({ token: "valid-token" }),
    headers: { "Content-Type": "application/json" },
  });
  const supabase = createSupaMock({
    rpcData: {
      project: { id: "p1", title: "Test Video", format: "landscape", style: "cinematic", description: null },
      scenes: [],
      share: { id: "s1", view_count: 5 },
    },
  });
  const res = await handleShareRequest(req, supabase);
  assertEquals(res.status, 200);
});

// ── extractStoragePath utility tests ─────────────────────────────────────────

Deno.test("extractStoragePath: parses valid signed URL", () => {
  const url = "https://project.supabase.co/storage/v1/object/sign/videos/generated/abc.mp4?token=xyz";
  const path = extractStoragePath(url);
  assertEquals(path, "videos/generated/abc.mp4");
});

Deno.test("extractStoragePath: returns null for non-storage URL", () => {
  const path = extractStoragePath("https://example.com/file.mp4");
  assertEquals(path, null);
});

Deno.test("extractStoragePath: returns null for invalid URL", () => {
  const path = extractStoragePath("not-a-url");
  assertEquals(path, null);
});
