/**
 * Billing & Plans page — shared data-access helpers.
 *
 * Wraps the supabase client so individual tab components don't have
 * to retype the rpc/auth/edge-fn ceremony. Mirrors the typed-RPC shim
 * pattern used in admin/_shared/queries.ts (note the .bind — it's
 * required so the function reference is callable on its own).
 */

import { supabase } from "@/integrations/supabase/client";

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;

export const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

export interface BillingOverview {
  plan: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  pack_quantity: number;
  paused_until: string | null;
  credits_balance: number;
  monthly_allowance: number;
  used_this_month: number;
  video_used: number;
  voice_used: number;
  image_used: number;
  other_used: number;
  videos_rendered: number;
  ytd_spend: number;
  avg_per_day: number;
  runway_days: number;
  total_purchased: number;
  total_used: number;
}

export async function fetchBillingOverview(): Promise<BillingOverview | null> {
  const { data, error } = await rpc<BillingOverview>("billing_user_overview");
  if (error) throw new Error(error.message);
  return data;
}

export interface BillingUsageHistoryMonth {
  month: string;
  video: number;
  voice: number;
  image: number;
  total: number;
}
export interface BillingUsageHistoryProject {
  id: string;
  title: string | null;
  thumbnail_url: string | null;
  updated_at: string;
}
export interface BillingUsageHistory {
  months: BillingUsageHistoryMonth[];
  top_projects: BillingUsageHistoryProject[];
}

export async function fetchBillingUsageHistory(): Promise<BillingUsageHistory | null> {
  const { data, error } = await rpc<BillingUsageHistory>("billing_usage_history");
  if (error) throw new Error(error.message);
  return data;
}

export interface ReferralSummary {
  code: string | null;
  invited_count: number;
  joined_count: number;
  credits_earned: number;
}

export async function fetchReferralSummary(): Promise<ReferralSummary | null> {
  const { data, error } = await rpc<ReferralSummary>("referral_user_summary");
  if (error) throw new Error(error.message);
  return data;
}

export async function ensureReferralCode(): Promise<string> {
  const { data, error } = await rpc<string>("ensure_referral_code");
  if (error) throw new Error(error.message);
  return data ?? "";
}

export interface ReferralSignupRow {
  id: string;
  referrer_id: string;
  referred_id: string;
  signed_up_at: string;
  first_render_at: string | null;
  credits_awarded: boolean;
  referred_name?: string | null;
}

export async function fetchReferralSignups(): Promise<ReferralSignupRow[]> {
  const { data, error } = await supabase
    .from("referral_signups")
    .select("id, referrer_id, referred_id, signed_up_at, first_render_at, credits_awarded")
    .order("signed_up_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as ReferralSignupRow[];
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  date: number;
  description: string;
  amount: number;
  currency: string;
  status: string | null;
  paid: boolean;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  payment_method_brand: string | null;
  payment_method_last4: string | null;
}

export async function fetchInvoices(accessToken: string): Promise<InvoiceRow[]> {
  const { data, error } = await supabase.functions.invoke("list-invoices", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (error) throw error;
  return (data?.invoices ?? []) as InvoiceRow[];
}

export interface AutoRechargeSettings {
  enabled: boolean;
  threshold: number;
  pack_credits: number;
  spending_cap: number | null;
}

export async function fetchAutoRecharge(userId: string): Promise<AutoRechargeSettings> {
  const { data, error } = await supabase
    .from("auto_recharge_settings")
    .select("enabled, threshold, pack_credits, spending_cap")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AutoRechargeSettings | null) ?? {
    enabled: false, threshold: 2000, pack_credits: 2000, spending_cap: null,
  };
}

export async function saveAutoRecharge(s: AutoRechargeSettings) {
  const { data, error } = await rpc("update_auto_recharge_settings", {
    p_enabled: s.enabled,
    p_threshold: s.threshold,
    p_pack_credits: s.pack_credits,
    p_spending_cap: s.spending_cap,
  });
  if (error) throw new Error(error.message);
  return data;
}

export interface BillingNotificationPrefs {
  email_receipts: boolean;
  include_vat: boolean;
  year_end_statement: boolean;
}

export async function fetchBillingPrefs(userId: string): Promise<BillingNotificationPrefs> {
  const { data, error } = await supabase
    .from("billing_notification_prefs")
    .select("email_receipts, include_vat, year_end_statement")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as BillingNotificationPrefs | null) ?? {
    email_receipts: true, include_vat: false, year_end_statement: false,
  };
}

export async function saveBillingPrefs(userId: string, p: BillingNotificationPrefs) {
  const { error } = await supabase
    .from("billing_notification_prefs")
    .upsert({ user_id: userId, ...p, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function applyPromoCode(code: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  const { data, error } = await rpc<{ ok: boolean; message?: string; error?: string }>("apply_promo_code", { p_code: code });
  if (error) throw new Error(error.message);
  return data ?? { ok: false, error: "Empty response" };
}

export async function callPauseSubscription(accessToken: string, months: number) {
  const { data, error } = await supabase.functions.invoke("pause-subscription", {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { months },
  });
  if (error) throw error;
  return data;
}

export async function callResumeSubscription(accessToken: string) {
  const { data, error } = await supabase.functions.invoke("pause-subscription", {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { resume: true },
  });
  if (error) throw error;
  return data;
}

export async function callUpdatePackQuantity(accessToken: string, quantity: number) {
  const { data, error } = await supabase.functions.invoke("update-pack-quantity", {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { quantity },
  });
  if (error) throw error;
  return data;
}

export async function callCancelWithReason(accessToken: string, reason: string | null, keepWithOffer: boolean) {
  const { data, error } = await supabase.functions.invoke("cancel-with-reason", {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { reason, keep_with_offer: keepWithOffer },
  });
  if (error) throw error;
  return data;
}

export async function callCustomerPortal(accessToken: string) {
  const { data, error } = await supabase.functions.invoke("customer-portal", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (error) throw error;
  if (!data?.url) throw new Error(data?.message ?? data?.error ?? "Could not open portal");
  return data.url as string;
}
