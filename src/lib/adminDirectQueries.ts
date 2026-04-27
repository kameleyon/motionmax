/**
 * Direct DB queries for admin panel — no edge function dependency.
 * Requires admin RLS policies (is_admin() check on each table).
 * All data comes from the DB where the worker writes it.
 */
import { supabase } from "@/integrations/supabase/client";

// ── Dashboard Stats ────────────────────────────────────────────────

/** Known subscription prices (monthly) for revenue estimation */
const PLAN_MONTHLY_PRICE: Record<string, number> = {
  creator: 14.99,
  starter: 14.99,
  studio: 39.99,
  professional: 39.99,
  enterprise: 99.99,
};

/** Known credit pack prices */
const CREDIT_PACK_PRICE: Record<number, number> = {
  300: 9.99,
  900: 24.99,
  2500: 59.99,
  // Legacy packs
  15: 4.99,
  50: 14.99,
  150: 34.99,
  500: 99.99,
};

export async function fetchDashboardStats() {
  const [
    { count: profileCount },
    { data: subscriptions },
    { count: genCount },
    { count: archiveCount },
    { data: flags },
    { data: costs },
    { data: purchaseTxns },
  ] = await Promise.all([
    supabase.from("profiles").select("*", { count: "exact", head: true }),
    supabase.from("subscriptions").select("*"),
    supabase.from("generations").select("*", { count: "exact", head: true }),
    supabase.from("generation_archives").select("*", { count: "exact", head: true }),
    supabase.from("user_flags").select("*").is("resolved_at", null),
    (supabase.rpc as unknown as (fn: string) => Promise<{ data: Record<string, unknown> | null; error: unknown }>)("get_generation_costs_summary"),
    supabase.from("credit_transactions").select("amount, transaction_type").eq("transaction_type", "purchase"),
  ]);

  const activeSubs = subscriptions?.filter(s => s.status === "active") || [];

  // ── Costs from RPC (bypasses RLS via SECURITY DEFINER) ──
  const costData = costs as Record<string, unknown> | null;
  const totalOpenRouter = Number(costData?.openrouter) || 0;
  const totalReplicate = Number(costData?.replicate) || 0;
  const totalHypereal = Number(costData?.hypereal) || 0;
  const totalGoogleTts = Number(costData?.google_tts) || 0;
  const totalSpent = Number(costData?.total) || 0;

  // ── Revenue from verified credit pack purchases only ──
  // Only count actual money: credit amount → known pack price
  let creditPackRevenue = 0;
  (purchaseTxns || []).forEach(t => {
    const credits = Math.abs(t.amount || 0);
    creditPackRevenue += CREDIT_PACK_PRICE[credits] || 0;
  });

  // Subscription revenue: only count Stripe subscriptions (not manual entries)
  // Manual subs have stripe_subscription_id starting with "manual_"
  const paidSubs = (subscriptions || []).filter(s =>
    s.status === "active" &&
    s.stripe_subscription_id &&
    !s.stripe_subscription_id.startsWith("manual_")
  );
  let subscriptionRevenue = 0;
  paidSubs.forEach(s => {
    const planPrice = PLAN_MONTHLY_PRICE[s.plan_name] || 0;
    const start = s.current_period_start ? new Date(s.current_period_start) : new Date(s.created_at);
    const monthsActive = Math.max(1, Math.ceil((Date.now() - start.getTime()) / (30 * 24 * 60 * 60 * 1000)));
    subscriptionRevenue += planPrice * monthsActive;
  });

  const totalRevenue = creditPackRevenue + subscriptionRevenue;

  return {
    totalUsers: profileCount || 0,
    subscriberCount: activeSubs.length,
    activeSubscriptions: activeSubs.length,
    totalGenerations: (genCount || 0) + (archiveCount || 0),
    activeGenerations: genCount || 0,
    archivedGenerations: archiveCount || 0,
    activeFlags: flags?.length || 0,
    creditPurchases: (purchaseTxns || []).length,
    costs: {
      openrouter: totalOpenRouter,
      replicate: totalReplicate,
      hypereal: totalHypereal,
      googleTts: totalGoogleTts,
      total: totalSpent,
    },
    revenue: {
      total: totalRevenue,
      subscriptions: subscriptionRevenue,
      creditPacks: creditPackRevenue,
    },
    profitMargin: totalRevenue - totalSpent,
  };
}

// ── Subscribers List ───────────────────────────────────────────────

export async function fetchSubscribersList(params: { page?: number; limit?: number; search?: string }) {
  const { page = 1, limit = 20, search = "" } = params;

  // If the search term looks like an email, resolve to a user_id first via
  // the admin email RPC and pin the query to that id. The UI placeholder
  // says "Search email or name" but display_name only is wrong.
  let emailResolvedUserId: string | null = null;
  if (search.includes("@")) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: resolved } = await (supabase.rpc as any)(
      "admin_get_user_id_by_email",
      { email_param: search.trim() },
    );
    emailResolvedUserId = (resolved as string) || null;
    // No match → return empty page (do not fall through to display_name).
    if (!emailResolvedUserId) {
      return { users: [], total: 0, page, limit, totalPages: 0 };
    }
  }

  // Step 1: Fetch paginated profiles (server-side)
  let profileQuery = supabase
    .from("profiles")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (emailResolvedUserId) {
    profileQuery = profileQuery.eq("user_id", emailResolvedUserId);
  } else if (search) {
    profileQuery = profileQuery.ilike("display_name", `%${search}%`);
  }

  const { data: profiles, count: totalCount } = await profileQuery
    .range((page - 1) * limit, page * limit - 1);

  const total = totalCount || 0;
  if (!profiles || profiles.length === 0) {
    return { users: [], total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // Step 2: Fetch related data only for the current page's user IDs
  const userIds = profiles.map(p => p.user_id);

  const [
    { data: subscriptions },
    { data: credits },
    { data: generations },
    { data: flags },
    { data: costsData },
    { data: emailRows },
  ] = await Promise.all([
    supabase.from("subscriptions").select("*").in("user_id", userIds),
    supabase.from("user_credits").select("*").in("user_id", userIds),
    supabase.from("generations").select("user_id").in("user_id", userIds),
    supabase.from("user_flags").select("*").is("resolved_at", null).in("user_id", userIds),
    supabase.from("generation_costs").select("user_id, openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost, total_cost").in("user_id", userIds),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.rpc as any)("admin_get_user_emails", { user_ids: userIds }),
  ]);

  const emailMap: Record<string, string> = {};
  (emailRows as { user_id: string; email: string }[] | null)?.forEach(r => {
    emailMap[r.user_id] = r.email;
  });

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

  const users = profiles.map(p => {
    const sub = subscriptions?.find(s => s.user_id === p.user_id && s.status === "active");
    const uc = credits?.find(c => c.user_id === p.user_id);
    return {
      id: p.user_id,
      email: emailMap[p.user_id] || p.user_id.slice(0, 8),
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

  return { users, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ── Generation List ────────────────────────────────────────────────

export async function fetchGenerationList(params: { page?: number; limit?: number; status?: string; search?: string }) {
  const page = params.page ?? 0;
  const limit = Math.min(params.limit ?? 20, 100);

  let query = supabase
    .from("generations")
    .select("id, user_id, project_id, status, progress, created_at, completed_at, started_at, error_message", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(page * limit, page * limit + limit - 1);

  if (params.status && params.status !== "all") query = query.eq("status", params.status);
  if (params.search) {
    const s = params.search.trim();
    // The id / user_id / project_id columns are uuid; Postgres rejects
    // ilike against uuid without an explicit text cast, which previously
    // threw and cleared the table on every keystroke. Cast each side.
    query = query.or(
      `id::text.ilike.%${s}%,user_id::text.ilike.%${s}%,project_id::text.ilike.%${s}%`,
    );
  }

  const { data, error, count } = await query;
  if (error) throw error;

  // Enrich with cost-per-generation summed from api_call_logs. One extra
  // round-trip for the whole page (~20 rows), client-side aggregation —
  // cheaper than a per-row RPC and works without a generation_costs table.
  const rows = data ?? [];
  const costMap: Record<string, number> = {};
  if (rows.length > 0) {
    const ids = rows.map(r => r.id);
    const { data: costRows } = await supabase
      .from("api_call_logs")
      .select("generation_id, cost")
      .in("generation_id", ids);
    if (costRows) {
      for (const r of costRows as { generation_id: string | null; cost: number | null }[]) {
        if (!r.generation_id) continue;
        costMap[r.generation_id] = (costMap[r.generation_id] ?? 0) + (r.cost ?? 0);
      }
    }
  }
  const enriched = rows.map(r => ({
    ...r,
    total_cost: costMap[r.id] ?? 0,
  }));

  return { rows: enriched, total: count ?? 0, page, limit };
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
    if (st in byStatus) (byStatus as Record<string, number>)[st]++;
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

export async function fetchFlagsList(params: { page?: number; limit?: number; includeResolved?: boolean } = {}) {
  const { page = 1, limit = 50, includeResolved = false } = params;
  const from = (page - 1) * limit;

  let query = supabase
    .from("user_flags")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (!includeResolved) query = query.is("resolved_at", null);

  const { data: flags, count } = await query.range(from, from + limit - 1);

  // Enrich with userName via profiles join.
  const userIds = (flags ?? []).map(f => f.user_id);
  let userNameMap: Record<string, string> = {};
  if (userIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", userIds);
    userNameMap = Object.fromEntries(
      (profiles ?? []).map(p => [p.user_id, p.display_name ?? ""]),
    );
  }

  const enriched = (flags ?? []).map(f => ({
    ...f,
    userName: userNameMap[f.user_id] ?? "",
  }));

  const total = count ?? 0;
  return {
    flags: enriched,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function createFlag(params: { user_id: string; reason: string; flag_type?: string }) {
  const { data: { user } } = await supabase.auth.getUser();

  let targetUserId = params.user_id;
  if (targetUserId.includes("@")) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: resolvedId, error: rpcError } = await (supabase.rpc as any)(
      "admin_get_user_id_by_email",
      { email_param: targetUserId },
    );
    if (rpcError || !resolvedId) throw new Error(`No user found with email: ${targetUserId}`);
    targetUserId = resolvedId as string;
  }

  const { error } = await supabase.from("user_flags").insert({
    user_id: targetUserId,
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

export async function fetchApiCallsList(params: {
  page?: number;
  limit?: number;
  status?: string;
  provider?: string;
  user_search?: string;
}) {
  const { page = 1, limit = 50, status, provider, user_search } = params;
  const from = (page - 1) * limit;

  // If the user_search looks like an email, resolve via the admin RPC
  // and constrain by user_id; otherwise fall back to ILIKE on user_id::text.
  let userIdFilter: string | null = null;
  if (user_search?.includes("@")) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: resolved } = await (supabase.rpc as any)(
      "admin_get_user_id_by_email",
      { email_param: user_search.trim() },
    );
    userIdFilter = (resolved as string) || null;
    if (!userIdFilter) {
      return {
        logs: [],
        calls: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }
  }

  let query = supabase
    .from("api_call_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (status && status !== "all") query = query.eq("status", status);
  if (provider && provider !== "all") query = query.eq("provider", provider);
  if (userIdFilter) {
    query = query.eq("user_id", userIdFilter);
  } else if (user_search) {
    query = query.ilike("user_id::text", `%${user_search.trim()}%`);
  }

  const { data, count } = await query.range(from, from + limit - 1);

  const total = count ?? 0;
  // Return both `logs` (what the UI reads) and `calls` (legacy alias) so
  // anything still consuming the old shape keeps working.
  return {
    logs: data ?? [],
    calls: data ?? [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function fetchApiCallDetail(params: { id?: string; callId?: string }) {
  const id = params.id ?? params.callId;
  if (!id) throw new Error("api_call_detail: id is required");
  const { data, error } = await supabase
    .from("api_call_logs")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ── Revenue (stub — needs Stripe secret key, not available client-side) ──

export async function fetchRevenueStats(params?: { startDate?: string; endDate?: string }) {
  let txnQuery = supabase
    .from("credit_transactions")
    .select("amount, transaction_type, created_at")
    .eq("transaction_type", "purchase");

  const subsQuery = supabase
    .from("subscriptions")
    .select("plan_name, status, stripe_subscription_id")
    .eq("status", "active");

  if (params?.startDate) {
    txnQuery = txnQuery.gte("created_at", params.startDate);
  }
  if (params?.endDate) {
    txnQuery = txnQuery.lte("created_at", params.endDate);
  }

  const [{ data: txns }, { data: subs }] = await Promise.all([txnQuery, subsQuery]);

  // Revenue by day from verified credit pack purchases
  let totalRevenue = 0;
  const dayMap: Record<string, number> = {};

  (txns || []).forEach(t => {
    const credits = Math.abs(t.amount || 0);
    const price = CREDIT_PACK_PRICE[credits] || 0;
    totalRevenue += price;
    const day = t.created_at?.slice(0, 10) || "unknown";
    dayMap[day] = (dayMap[day] || 0) + price;
  });

  // MRR only from real Stripe subscriptions (not manual entries)
  const paidSubs = (subs || []).filter(s =>
    s.stripe_subscription_id && !s.stripe_subscription_id.startsWith("manual_")
  );
  let mrr = 0;
  paidSubs.forEach(s => {
    mrr += PLAN_MONTHLY_PRICE[s.plan_name] || 0;
  });

  return {
    totalRevenue,
    mrr,
    chargeCount: (txns || []).length,
    activeSubscriptions: (subs || []).length,
    revenueByDay: Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amount]) => ({ date, amount })),
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
    { count: archiveCount },
    { data: flags },
    { data: costs },
    { data: logs },
    { data: transactions },
    { count: projectsCount },
    { data: archivedProjectIds },
    { data: activeProjectIds },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", uid).single(),
    supabase.from("subscriptions").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("user_credits").select("*").eq("user_id", uid).single(),
    supabase.from("generations").select("id, project_id, status, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
    supabase.from("generation_archives").select("*", { count: "exact", head: true }).eq("user_id", uid),
    supabase.from("user_flags").select("*").eq("user_id", uid).order("created_at", { ascending: false }),
    supabase.from("generation_costs").select("*").eq("user_id", uid),
    supabase.from("system_logs").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(15),
    supabase.from("credit_transactions").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(10),
    supabase.from("projects").select("*", { count: "exact", head: true }).eq("user_id", uid),
    supabase.from("generation_archives").select("project_id").eq("user_id", uid).not("project_id", "is", null),
    supabase.from("projects").select("id").eq("user_id", uid),
  ]);

  let totalCost = 0;
  costs?.forEach(c => { totalCost += Number(c.total_cost) || 0; });

  // Determine user status from active flags
  const activeFlags = flags?.filter(f => !f.resolved_at) || [];
  const isBanned = activeFlags.some(f => f.flag_type === "banned");
  const isSuspended = activeFlags.some(f => f.flag_type === "suspended");
  const userStatus = isBanned ? "banned" : isSuspended ? "suspended" : "active";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: emailRows2 } = await (supabase.rpc as any)("admin_get_user_emails", { user_ids: [uid] });
  const userEmail = (emailRows2 as { user_id: string; email: string }[] | null)?.[0]?.email || uid.slice(0, 8);

  return {
    user: {
      id: uid,
      email: userEmail,
      created_at: profile?.created_at || "",
      last_sign_in_at: null,
      email_confirmed_at: profile?.created_at || null,
    },
    profile: profile ? {
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
    } : null,
    subscription: sub ? {
      plan_name: sub.plan_name,
      status: sub.status,
      current_period_end: sub.current_period_end || null,
      cancel_at_period_end: sub.cancel_at_period_end || false,
    } : null,
    credits: creds ? {
      credits_balance: creds.credits_balance || 0,
      total_purchased: creds.total_purchased || 0,
      total_used: creds.total_used || 0,
    } : null,
    projectsCount: projectsCount || 0,
    deletedProjectsCount: (() => {
      const activeIds = new Set((activeProjectIds || []).map(p => p.id));
      const archived = new Set((archivedProjectIds || []).map(a => a.project_id).filter(Boolean));
      return [...archived].filter(id => !activeIds.has(id)).length;
    })(),
    totalGenerationCost: totalCost,
    totalGenerations: (gens?.length || 0) + (archiveCount || 0),
    activeGenerations: gens?.length || 0,
    archivedGenerations: archiveCount || 0,
    userStatus,
    recentGenerations: (gens || []).map(g => ({
      id: g.id,
      status: g.status,
      created_at: g.created_at,
      completed_at: null,
    })),
    flags: (flags || []).map(f => ({
      id: f.id,
      flag_type: f.flag_type,
      reason: f.reason,
      created_at: f.created_at,
      resolved_at: f.resolved_at,
    })),
    recentUserLogs: (logs || []).map(l => ({
      id: l.id,
      category: l.category || "",
      event_type: l.event_type || "",
      message: l.message || "",
      details: l.details || null,
      created_at: l.created_at,
    })),
    recentTransactions: (transactions || []).map(t => ({
      id: t.id,
      amount: t.amount || 0,
      transaction_type: t.transaction_type || "",
      description: t.description || null,
      created_at: t.created_at,
    })),
  };
}

// ── Router ─────────────────────────────────────────────────────────

export async function adminDirectQuery(action: string, params?: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case "dashboard_stats": return fetchDashboardStats();
    case "subscribers_list": return fetchSubscribersList(params as { page?: number; limit?: number; search?: string });
    case "generation_stats": return fetchGenerationStats(params as { startDate?: string; endDate?: string });
    case "generation_list": return fetchGenerationList(params as { page?: number; limit?: number; status?: string; search?: string });
    case "admin_logs": return fetchAdminLogs(params as { page?: number; limit?: number });
    case "flags_list": return fetchFlagsList(params as { page?: number; limit?: number; includeResolved?: boolean });
    case "create_flag": return createFlag({
      user_id: (params?.userId ?? params?.user_id) as string,
      reason: params?.reason as string,
      flag_type: (params?.flagType ?? params?.flag_type) as string | undefined,
    });
    case "resolve_flag": return resolveFlag(params as { flagId: string });
    case "api_calls_list": return fetchApiCallsList(params as { page?: number; limit?: number; status?: string; provider?: string; user_search?: string });
    case "api_call_detail": return fetchApiCallDetail(params as { id?: string; callId?: string });
    case "revenue_stats": return fetchRevenueStats(params as { startDate?: string; endDate?: string });
    case "user_details": return fetchUserDetails(params as { userId?: string; targetUserId?: string });
    default: throw new Error(`Unknown admin action: ${action}`);
  }
}
