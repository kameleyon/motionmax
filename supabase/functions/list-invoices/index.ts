import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import * as Sentry from "https://deno.land/x/sentry/index.mjs";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
});

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[LIST-INVOICES] ${step}${detailsStr}`);
};

class UserFacingError extends Error {
  constructor(message: string) { super(message); this.name = "UserFacingError"; }
}

interface TrimmedInvoice {
  id: string;
  number: string | null;
  date: number;
  description: string;
  amount: number; // cents, total
  currency: string;
  status: string | null;
  paid: boolean;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return handleCorsPreflightRequest(req.headers.get("origin"));

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new UserFacingError("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new UserFacingError("Authentication failed. Please sign in again.");
    const user = userData.user;
    if (!user?.email) throw new UserFacingError("User not authenticated");

    const rl = await checkRateLimit(supabaseClient, {
      key: "list-invoices", maxRequests: 20, windowSeconds: 60, userId: user.id,
    });
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429,
      });
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { apiVersion: "2024-12-18.acacia" });

    // Find Stripe customer by email
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    if (customers.data.length === 0) {
      logStep("No Stripe customer", { email: user.email });
      return new Response(JSON.stringify({ invoices: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
    const customerId = customers.data[0].id;

    const invoices = await stripe.invoices.list({ customer: customerId, limit: 24 });

    const trimmed: TrimmedInvoice[] = invoices.data.map((inv) => {
      // Best effort to get card brand + last4 from payment method
      let brand: string | null = null;
      let last4: string | null = null;
      const charge = (inv as unknown as { charge?: { payment_method_details?: { card?: { brand?: string; last4?: string } } } }).charge;
      const card = charge?.payment_method_details?.card;
      if (card) {
        brand = card.brand ?? null;
        last4 = card.last4 ?? null;
      }
      const lineDescription = inv.lines?.data?.[0]?.description ?? null;
      return {
        id: inv.id,
        number: inv.number,
        date: inv.created,
        description: lineDescription || (inv.lines?.data?.[0]?.price?.nickname ?? "Subscription"),
        amount: inv.amount_paid ?? inv.total ?? 0,
        currency: inv.currency,
        status: inv.status,
        paid: !!inv.paid,
        invoice_pdf: inv.invoice_pdf,
        hosted_invoice_url: inv.hosted_invoice_url,
        payment_method_brand: brand,
        payment_method_last4: last4,
      };
    });

    return new Response(JSON.stringify({ invoices: trimmed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    Sentry.captureException(error);
    await Sentry.flush(2000);
    const clientMessage = error instanceof UserFacingError ? errorMessage : "An unexpected error occurred.";
    return new Response(JSON.stringify({ error: clientMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
}

serve(handler);
