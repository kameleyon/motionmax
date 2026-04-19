import { http, HttpResponse } from "msw";

const SUPABASE_URL = "http://localhost:54321";

export const handlers = [
  // Supabase auth — return a default session
  http.get(`${SUPABASE_URL}/auth/v1/user`, () =>
    HttpResponse.json({
      id: "test-user-id",
      email: "test@example.com",
      role: "authenticated",
    })
  ),

  // Supabase REST — profiles select
  http.get(`${SUPABASE_URL}/rest/v1/profiles`, () =>
    HttpResponse.json([
      { user_id: "test-user-id", display_name: "Test User", plan: "free" },
    ])
  ),

  // Supabase REST — subscriptions select
  http.get(`${SUPABASE_URL}/rest/v1/subscriptions`, () =>
    HttpResponse.json([
      {
        user_id: "test-user-id",
        plan: "free",
        status: "active",
        credits_balance: 5,
        subscription_end: null,
        cancel_at_period_end: false,
      },
    ])
  ),

  // Supabase Functions — check-subscription
  http.post(`${SUPABASE_URL}/functions/v1/check-subscription`, () =>
    HttpResponse.json({
      subscribed: false,
      plan: "free",
      credits_balance: 5,
    })
  ),

  // Supabase Functions — create-checkout
  http.post(`${SUPABASE_URL}/functions/v1/create-checkout`, () =>
    HttpResponse.json({ url: "https://checkout.stripe.com/test" })
  ),

  // Supabase Functions — customer-portal
  http.post(`${SUPABASE_URL}/functions/v1/customer-portal`, () =>
    HttpResponse.json({ url: "https://billing.stripe.com/test" })
  ),
];
