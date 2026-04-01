/**
 * Direct DB queries for admin panel — no edge function dependency.
 * Requires admin RLS policies (is_admin() check on each table).
 * All data comes from the DB where the worker writes it.
 */
import { supabase } from "@/integrations/supabase/client";

// ── Dashboard Stats ────────────────────────────────────────────────

export async function fetchDashboardStats() {
  const [
    { count: profileCount },
    { data: subscriptions },
    { count: genCount },
    { count: archiveCount },
    { data: flags },
    { data: costs },
    { data: transactions },
  ] = await Promise.all([
    supabase.from("profiles").select("*", { count: "exact", head: true }),
    supabase.from("subscriptions").select("*"),
    supabase.from("generations").select("*", { count: "exact", head: true }),
    supabase.from("generation_archives").select("*", { count: "exact", head: true }),
    supabase.from("user_flags").select("*").is("resolved_at", null),
    supabase.from("generation_costs").select("openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost, total_cost"),
    supabase.from("credit_transactions").select("*").eq("transaction_type", "purchase"),
  ]);

  const activeSubs = subscriptions?.filter(s => s.status === "active") || [];

  let totalOpenRouter = 0;
  let totalReplicate = 0;
  let totalHypereal = 0;
  let totalGoogleTts = 0;
  let totalSpent = 0;

  costs?.forEach(c => {
    totalOpenRouter += Number(c.openrouter_cost) || 0;
    totalReplicate += Number(c.replicate_cost) || 0;
    totalHypereal += Number(c.hypereal_cost) || 0;
    totalGoogleTts += Number(c.google_tts_cost) || 0;
    totalSpent += Number(c.total_cost) || 0;
  });

  return {
    totalUsers: profileCount || 0,
    subscriberCount: activeSubs.length,
    activeSubscriptions: activeSubs.length,
    totalGenerations: (genCount || 0) + (archiveCount || 0),
    activeGenerations: genCount || 0,
    archivedGenerations: archiveCount || 0,
    activeFlags: flags?.length || 0,
    creditPurchases: transactions?.length || 0,
    costs: {
      openrouter: totalOpenRouter,
      replicate: totalReplicate,
      hypereal: totalHypereal,
      googleTts: totalGoogleTts,
      total: totalSpent,
    },
    revenue: { total: 0, subscriptions: 0, creditPacks: 0 },
    profitMargin: -totalSpent,
  };
}

// ── Subscribers List ───────────────────────────────────────────────

export async function fetchSubscribersList(params: { page?: number; limit?: number; search?: string }) {
  const { page = 1, limit = 20, search = "" } = params;

  const [
    { data: profiles },
    { data: subscriptions },
    { data: credits },
    { data: generations },
    { data: flags },
    { data: costsData },
  ] = await Promise.all([
    supabase.from("profiles").select("*"),
    supabase.from("subscriptions").select("*"),
    supabase.from("user_credits").select("*"),
    supabase.from("generations").select("user_id"),
    supabase.from("user_flags").select("*").is("resolved_at", null),
    supabase.from("generation_costs").select("user_id, openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost, total_cost"),
  ]);

  const genCounts: Record<string, number> = {};
  generations?.forEach(g => { genCounts[g.user_id] = (genCounts[g.user_id] || 0) + 1; });

  const flagCounts: Record<string, number> = {};
  flags?.forEach(f => { flagCounts[f.user_id] = (flagCounts[f.user_id] || 0) + 1; });

  const userCosts: Record<string, { openrouter: number; replicate: number; hypereal: number; googleTts: number; total: number }> = {};
  costsData?.forEach(c => {
    if (!userCosts[c.user_id]) userCosts[c.user_id] = { openrouter: 0, replicate: 0, hypereal: 0, googleTts: 0, total: 0 };
    userCosts[c.user_id].openrouter += Number(c.openrouter_cost) || 0;
    userCosts[c.user_id].replicate += Number(c.replicate_cost) || 0;
    userCosts[c.user_id].hypereal += Number(c.hypereal_cost) || 0;
    userCosts[c.user_id].googleTts += Number(c.google_tts_cost) || 0;
    userCosts[c.user_id].total += Number(c.total_cost) || 0;
  });

  let users = (profiles || []).map(p => {
    const sub = subscriptions?.find(s => s.user_id === p.user_id && s.status === "active");
    const uc = credits?.find(c => c.user_id === p.user_id);
    return {
      id: p.user_id,
      email: p.display_name || p.user_id.slice(0, 8),
      displayName: p.display_name || p.user_id.slice(0, 8),
      avatarUrl: p.avatar_url,
      createdAt: p.created_at,
      lastSignIn: null,
      plan: sub?.plan_name || "free",
      status: sub?.status || "none",
      creditsBalance: uc?.credits_balance || 0,
      totalPurchased: uc?.total_purchased || 0,
      totalUsed: uc?.total_used || 0,
      generationCount: genCounts[p.user_id] || 0,
      flagCount: flagCounts[p.user_id] || 0,
      costs: userCosts[p.user_id] || { openrouter: 0, replicate: 0, hypereal: 0, googleTts: 0, total: 0 },
    };
  });

  if (search) {
    const s = search.toLowerCase();
    users = users.filter(u => u.displayName?.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s));
  }

  const total = users.length;
  const start = (page - 1) * limit;
  const paged = users.slice(start, start + limit);

  return { users: paged, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ── Generation Stats ───────────────────────────────────────────────

export async function fetchGenerationStats(params: { startDate?: string; endDate?: string }) {
  let query = supabase.from("generations").select("status, created_at");
  if (params.startDate) query = query.gte("created_at", params.startDate);
  if (params.endDate) query = query.lte("created_at", params.endDate);
  const { data: gens } = await query;

  const { count: archiveCount } = await supabase.from("generation_archives").select("*", { count: "exact", head: true });

  const byStatus = { pending: 0, processing: 0, complete: 0, error: 0, deleted: archiveCount || 0 };
  const dayMap: Record<string, { total: number; completed: number; failed: number; deleted: number }> = {};

  (gens || []).forEach(g => {
    const st = g.status || "pending";
    if (st in byStatus) (byStatus as any)[st]++;
    const day = g.created_at?.slice(0, 10) || "unknown";
    if (!dayMap[day]) dayMap[day] = { total: 0, completed: 0, failed: 0, deleted: 0 };
    dayMap[day].total++;
    if (st === "complete") dayMap[day].completed++;
    if (st === "error") dayMap[day].failed++;
  });

  const byDay = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));

  return {
    total: (gens?.length || 0) + (archiveCount || 0),
    byStatus,
    byDay,
  };
}

// ── Admin Logs ─────────────────────────────────────────────────────

export async function fetchAdminLogs(params: { page?: number; limit?: number }) {
  const { page = 1, limit = 50 } = params;
  const from = (page - 1) * limit;

  const { data, count } = await supabase
    .from("system_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  return { logs: data || [], total: count || 0, page, limit };
}

// ── Flags ──────────────────────────────────────────────────────────

export async function fetchFlagsList() {
  const { data } = await supabase
    .from("user_flags")
    .select("*")
    .order("created_at", { ascending: false });
  return { flags: data || [] };
}

export async function createFlag(params: { user_id: string; reason: string; flag_type?: string }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("user_flags").insert({
    user_id: params.user_id,
    reason: params.reason,
    flag_type: params.flag_type || "warning",
    flagged_by: user?.id || "admin",
  });
  if (error) throw new Error(error.message);
  return { success: true };
}

export async function resolveFlag(params: { flagId: string }) {
  const { error } = await supabase
    .from("user_flags")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", params.flagId);
  if (error) throw new Error(error.message);
  return { success: true };
}

// ── API Calls ──────────────────────────────────────────────────────

export async function fetchApiCallsList(params: { page?: number; limit?: number }) {
  const { page = 1, limit = 50 } = params;
  const from = (page - 1) * limit;

  const { data, count } = await supabase
    .from("api_call_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  return { calls: data || [], total: count || 0, page, limit };
}

export async function fetchApiCallDetail(params: { id: string }) {
  const { data, error } = await supabase
    .from("api_call_logs")
    .select("*")
    .eq("id", params.id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ── Revenue (stub — needs Stripe secret key, not available client-side) ──

export async function fetchRevenueStats() {
  const { data: costs } = await supabase
    .from("generation_costs")
    .select("openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost, total_cost, created_at");

  let totalSpent = 0;
  const dayMap: Record<string, number> = {};

  costs?.forEach(c => {
    totalSpent += Number(c.total_cost) || 0;
    const day = c.created_at?.slice(0, 10) || "unknown";
    dayMap[day] = (dayMap[day] || 0) + (Number(c.total_cost) || 0);
  });

  return {
    totalSpent,
    costsByDay: Object.entries(dayMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, cost]) => ({ date, cost })),
    note: "Stripe revenue unavailable — deploy admin-stats edge function for revenue data",
  };
}

// ── User Details ───────────────────────────────────────────────────

export async function fetchUserDetails(params: { userId?: string; targetUserId?: string }) {
  const uid = params.targetUserId || params.userId;
  if (!uid) throw new Error("userId or targetUserId is required");

  const [
    { data: profile },
    { data: sub },
    { data: creds },
    { data: gens },
    { data: flags },
    { data: costs },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", uid).single(),
    supabase.from("subscriptions").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("user_credits").select("*").eq("user_id", uid).single(),
    supabase.from("generations").select("id, project_id, status, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
    supabase.from("user_flags").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
    supabase.from("generation_costs").select("*").eq("user_id", uid),
  ]);

  let totalCost = 0;
  costs?.forEach(c => { totalCost += Number(c.total_cost) || 0; });

  return {
    id: uid,
    email: profile?.display_name || uid.slice(0, 8),
    displayName: profile?.display_name,
    avatarUrl: profile?.avatar_url,
    createdAt: profile?.created_at,
    subscription: sub,
    credits: creds,
    recentGenerations: gens || [],
    flags: flags || [],
    totalCost,
  };
}

// ── Router ─────────────────────────────────────────────────────────

export async function adminDirectQuery(action: string, params?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "dashboard_stats": return fetchDashboardStats();
    case "subscribers_list": return fetchSubscribersList(params as any);
    case "generation_stats": return fetchGenerationStats(params as any);
    case "admin_logs": return fetchAdminLogs(params as any);
    case "flags_list": return fetchFlagsList();
    case "create_flag": return createFlag(params as any);
    case "resolve_flag": return resolveFlag(params as any);
    case "api_calls_list": return fetchApiCallsList(params as any);
    case "api_call_detail": return fetchApiCallDetail(params as any);
    case "revenue_stats": return fetchRevenueStats();
    case "user_details": return fetchUserDetails(params as any);
    default: throw new Error(`Unknown admin action: ${action}`);
  }
}
