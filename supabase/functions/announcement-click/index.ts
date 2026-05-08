import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";

// Phase 16.4 — announcement CTA click tracker.
//
// Reached via the redirect URL we substitute in announcement bodies
// when an admin sets a CTA: instead of pointing the button at the
// admin's URL directly, the body uses
// `<APP_URL>/functions/v1/announcement-click?id=<announcement_id>&to=<encoded_url>`.
// We log the click + the user (if authenticated via JWT) and 302 to
// the original URL.
//
// No CORS — this is invoked by browser navigation, not fetch().

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSafeRedirectUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // Allowlist: http/https only, ban data: and javascript:.
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const to = url.searchParams.get("to") ?? "";

  if (!UUID_REGEX.test(id) || !isSafeRedirectUrl(to)) {
    return new Response("Bad request", { status: 400 });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Best-effort user resolution from the JWT cookie/header. Click
  // tracking works for anon visitors too (user_id stays null).
  let userId: string | null = null;
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.replace("Bearer ", "");
    const { data } = await supabaseAdmin.auth.getUser(token);
    userId = data?.user?.id ?? null;
  }

  // Insert is best-effort. If the row fails (FK on a deleted
  // announcement, etc.) we still 302 — the user shouldn't see a
  // broken link because our tracking blew up.
  await supabaseAdmin.from("announcement_clicks")
    .insert({
      announcement_id: id,
      user_id: userId,
      ip: req.headers.get("x-forwarded-for") ?? null,
      user_agent: req.headers.get("user-agent") ?? null,
    })
    .then(() => {}, () => {});

  return new Response(null, { status: 302, headers: { Location: to } });
}

serve(handler);
