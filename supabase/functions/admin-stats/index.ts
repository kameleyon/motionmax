import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[ADMIN-STATS] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    // Verify admin access
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("No authorization header provided");
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      throw new Error("Authentication error: Invalid session");
    }
    
    const userId = claimsData.claims.sub as string;
    logStep("User authenticated", { userId });

    // Check if user is admin using direct query (service role bypasses RLS)
    const { data: adminRole, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .single();

    if (roleError || !adminRole) {
      logStep("Access denied - not admin", { userId });
      return new Response(JSON.stringify({ error: "Access denied. Admin privileges required." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 403,
      });
    }

    logStep("Admin access verified");

    const { action, params } = await req.json();
    logStep("Action requested", { action, params });

    let result: unknown;

    switch (action) {
      case "dashboard_stats": {
        // Get all users with auth.users via service role
        const { data: authUsers, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
        if (usersError) throw usersError;

        const totalUsers = authUsers.users.length;

        // Get subscriptions
        const { data: subscriptions } = await supabaseAdmin
          .from("subscriptions")
          .select("*");

        const activeSubscriptions = subscriptions?.filter(s => s.status === "active") || [];
        const subscriberCount = activeSubscriptions.length;

        // Get generations count
        const { count: generationsCount } = await supabaseAdmin
          .from("generations")
          .select("*", { count: "exact", head: true });

        // Get archived generations count
        const { count: archivedCount } = await supabaseAdmin
          .from("generation_archives")
          .select("*", { count: "exact", head: true });

        // Get flags
        const { data: flags } = await supabaseAdmin
          .from("user_flags")
          .select("*")
          .is("resolved_at", null);

        const activeFlags = flags?.length || 0;

        // Get credit transactions for revenue
        const { data: transactions } = await supabaseAdmin
          .from("credit_transactions")
          .select("*")
          .eq("transaction_type", "purchase");

        // Get total costs from generation_costs table (money spent)
        const { data: costsData } = await supabaseAdmin
          .from("generation_costs")
          .select("openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost, total_cost");

        // Aggregate costs by provider
        let totalOpenRouterCost = 0;
        let totalReplicateCost = 0;
        let totalHyperealCost = 0;
        let totalGoogleTtsCost = 0;
        let totalSpent = 0;

        costsData?.forEach(c => {
          totalOpenRouterCost += Number(c.openrouter_cost) || 0;
          totalReplicateCost += Number(c.replicate_cost) || 0;
          totalHyperealCost += Number(c.hypereal_cost) || 0;
          totalGoogleTtsCost += Number(c.google_tts_cost) || 0;
          totalSpent += Number(c.total_cost) || 0;
        });

        // Get revenue from Stripe
        let totalRevenue = 0;
        let subscriptionRevenue = 0;
        let creditPackRevenue = 0;
        const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
        
        if (stripeKey) {
          try {
            const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
            
            // Get all successful charges
            const charges = await stripe.charges.list({
              limit: 100,
            });
            
            const successfulCharges = charges.data.filter((c: { status: string }) => c.status === "succeeded");
            totalRevenue = successfulCharges.reduce((sum: number, c: { amount: number }) => sum + c.amount, 0) / 100;
            
            // Separate subscription vs one-time (credit pack) payments
            for (const charge of successfulCharges) {
              if (charge.invoice) {
                subscriptionRevenue += charge.amount / 100;
              } else {
                creditPackRevenue += charge.amount / 100;
              }
            }
          } catch (stripeErr) {
            console.error("Stripe error in dashboard_stats:", stripeErr);
          }
        }

        result = {
          totalUsers,
          subscriberCount,
          activeSubscriptions: activeSubscriptions.length,
          totalGenerations: (generationsCount || 0) + (archivedCount || 0),
          activeGenerations: generationsCount || 0,
          archivedGenerations: archivedCount || 0,
          activeFlags,
          creditPurchases: transactions?.length || 0,
          // Financial data
          costs: {
            openrouter: totalOpenRouterCost,
            replicate: totalReplicateCost,
            hypereal: totalHyperealCost,
            googleTts: totalGoogleTtsCost,
            total: totalSpent,
          },
          revenue: {
            total: totalRevenue,
            subscriptions: subscriptionRevenue,
            creditPacks: creditPackRevenue,
          },
          profitMargin: totalRevenue - totalSpent,
        };
        break;
      }

      case "subscribers_list": {
        const { page = 1, limit = 20, search = "" } = params || {};
        
        // Get all users
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
        
        // Get all subscriptions
        const { data: subscriptions } = await supabaseAdmin
          .from("subscriptions")
          .select("*");

        // Get all profiles
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("*");

        // Get all credits
        const { data: credits } = await supabaseAdmin
          .from("user_credits")
          .select("*");

        // Get generation counts per user
        const { data: generations } = await supabaseAdmin
          .from("generations")
          .select("user_id");

        const generationCounts: Record<string, number> = {};
        generations?.forEach(g => {
          generationCounts[g.user_id] = (generationCounts[g.user_id] || 0) + 1;
        });

        // Get flags per user
        const { data: flags } = await supabaseAdmin
          .from("user_flags")
          .select("*")
          .is("resolved_at", null);

        const flagCounts: Record<string, number> = {};
        flags?.forEach(f => {
          flagCounts[f.user_id] = (flagCounts[f.user_id] || 0) + 1;
        });

        // Get costs per user from generation_costs table
        const { data: costsData } = await supabaseAdmin
          .from("generation_costs")
          .select("user_id, openrouter_cost, replicate_cost, hypereal_cost, google_tts_cost, total_cost");

        // Aggregate costs per user
        const userCosts: Record<string, { openrouter: number; replicate: number; hypereal: number; googleTts: number; total: number }> = {};
        costsData?.forEach(c => {
          if (!userCosts[c.user_id]) {
            userCosts[c.user_id] = { openrouter: 0, replicate: 0, hypereal: 0, googleTts: 0, total: 0 };
          }
          userCosts[c.user_id].openrouter += Number(c.openrouter_cost) || 0;
          userCosts[c.user_id].replicate += Number(c.replicate_cost) || 0;
          userCosts[c.user_id].hypereal += Number(c.hypereal_cost) || 0;
          userCosts[c.user_id].googleTts += Number(c.google_tts_cost) || 0;
          userCosts[c.user_id].total += Number(c.total_cost) || 0;
        });

        // Combine data
        let users = authUsers?.users.map(user => {
          const profile = profiles?.find(p => p.user_id === user.id);
          const subscription = subscriptions?.find(s => s.user_id === user.id && s.status === "active");
          const userCredits = credits?.find(c => c.user_id === user.id);

          return {
            id: user.id,
            email: user.email,
            displayName: profile?.display_name || user.email?.split("@")[0],
            avatarUrl: profile?.avatar_url,
            createdAt: user.created_at,
            lastSignIn: user.last_sign_in_at,
            plan: subscription?.plan_name || "free",
            status: subscription?.status || "none",
            creditsBalance: userCredits?.credits_balance || 0,
            totalPurchased: userCredits?.total_purchased || 0,
            totalUsed: userCredits?.total_used || 0,
            generationCount: generationCounts[user.id] || 0,
            flagCount: flagCounts[user.id] || 0,
            costs: userCosts[user.id] || { openrouter: 0, replicate: 0, hypereal: 0, googleTts: 0, total: 0 },
          };
        }) || [];

        // Filter by search
        if (search) {
          const searchLower = search.toLowerCase();
          users = users.filter(u => 
            u.email?.toLowerCase().includes(searchLower) ||
            u.displayName?.toLowerCase().includes(searchLower)
          );
        }

        // Paginate
        const total = users.length;
        const start = (page - 1) * limit;
        const paginatedUsers = users.slice(start, start + limit);

        result = {
          users: paginatedUsers,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        };
        break;
      }

      case "revenue_stats": {
        const { startDate, endDate } = params || {};
        
        const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
        if (!stripeKey) {
          result = { error: "Stripe not configured", revenue: 0, charges: [] };
          break;
        }

        const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

        // Get all charges from Stripe
        const charges = await stripe.charges.list({
          limit: 100,
          created: {
            gte: startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined,
            lte: endDate ? Math.floor(new Date(endDate).getTime() / 1000) : undefined,
          },
        });

        const successfulCharges = charges.data.filter((c: { status: string }) => c.status === "succeeded");
        const totalRevenue = successfulCharges.reduce((sum: number, c: { amount: number }) => sum + c.amount, 0) / 100;

        // Get subscriptions revenue
        const subscriptions = await stripe.subscriptions.list({
          limit: 100,
          status: "active",
        });

        const mrr = subscriptions.data.reduce((sum: number, s: { items: { data: Array<{ price?: { recurring?: { interval?: string }; unit_amount?: number | null } }> } }) => {
          const price = s.items.data[0]?.price;
          if (price?.recurring?.interval === "month") {
            return sum + (price.unit_amount || 0) / 100;
          } else if (price?.recurring?.interval === "year") {
            return sum + ((price.unit_amount || 0) / 100) / 12;
          }
          return sum;
        }, 0);

        // Group by day for chart
        const revenueByDay: Record<string, number> = {};
        successfulCharges.forEach((charge: { created: number; amount: number }) => {
          const day = new Date(charge.created * 1000).toISOString().split("T")[0];
          revenueByDay[day] = (revenueByDay[day] || 0) + charge.amount / 100;
        });

        result = {
          totalRevenue,
          mrr,
          chargeCount: successfulCharges.length,
          activeSubscriptions: subscriptions.data.length,
          revenueByDay: Object.entries(revenueByDay).map(([date, amount]) => ({ date, amount })),
        };
        break;
      }

      case "generation_stats": {
        const { startDate, endDate } = params || {};
        
        let query = supabaseAdmin
          .from("generations")
          .select("*");

        if (startDate) {
          query = query.gte("created_at", startDate);
        }
        if (endDate) {
          query = query.lte("created_at", endDate);
        }

        const { data: generations } = await query;

        // Get archived generations too
        let archiveQuery = supabaseAdmin
          .from("generation_archives")
          .select("*");

        if (startDate) {
          archiveQuery = archiveQuery.gte("original_created_at", startDate);
        }
        if (endDate) {
          archiveQuery = archiveQuery.lte("original_created_at", endDate);
        }

        const { data: archives } = await archiveQuery;

        const allGenerations = [
          ...(generations || []).map(g => ({ ...g, deleted: false })),
          ...(archives || []).map(a => ({ 
            ...a, 
            created_at: a.original_created_at,
            deleted: true 
          })),
        ];

        // Group by day
        const byDay: Record<string, { total: number; completed: number; failed: number; deleted: number }> = {};
        allGenerations.forEach(g => {
          const day = new Date(g.created_at).toISOString().split("T")[0];
          if (!byDay[day]) {
            byDay[day] = { total: 0, completed: 0, failed: 0, deleted: 0 };
          }
          byDay[day].total++;
          if (g.deleted) byDay[day].deleted++;
          else if (g.status === "complete") byDay[day].completed++;
          else if (g.status === "error") byDay[day].failed++;
        });

        // By status
        const byStatus = {
          pending: allGenerations.filter(g => g.status === "pending" && !g.deleted).length,
          processing: allGenerations.filter(g => g.status === "processing" && !g.deleted).length,
          complete: allGenerations.filter(g => g.status === "complete" && !g.deleted).length,
          error: allGenerations.filter(g => g.status === "error" && !g.deleted).length,
          deleted: allGenerations.filter(g => g.deleted).length,
        };

        result = {
          total: allGenerations.length,
          byStatus,
          byDay: Object.entries(byDay)
            .map(([date, stats]) => ({ date, ...stats }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        };
        break;
      }

      case "flags_list": {
        const { page = 1, limit = 20, includeResolved = false } = params || {};

        let query = supabaseAdmin
          .from("user_flags")
          .select("*")
          .order("created_at", { ascending: false });

        if (!includeResolved) {
          query = query.is("resolved_at", null);
        }

        const { data: flags, count } = await query
          .range((page - 1) * limit, page * limit - 1);

        // Get user info for each flag
        const userIds = [...new Set(flags?.map(f => f.user_id) || [])];
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("user_id, display_name")
          .in("user_id", userIds);

        const flagsWithUsers = flags?.map(flag => ({
          ...flag,
          userName: profiles?.find(p => p.user_id === flag.user_id)?.display_name || "Unknown",
        }));

        result = {
          flags: flagsWithUsers,
          total: count || 0,
          page,
          limit,
        };
        break;
      }

      case "create_flag": {
        const { userId, flagType, reason, details } = params;

        const { data: flag, error: flagError } = await supabaseAdmin
          .from("user_flags")
          .insert({
            user_id: userId,
            flag_type: flagType,
            reason,
            details,
            flagged_by: userId, // Admin's ID from token
          })
          .select()
          .single();

        if (flagError) throw flagError;

        // Log the action
        await supabaseAdmin.from("admin_logs").insert({
          admin_id: userId,
          action: "create_flag",
          target_type: "user",
          target_id: userId,
          details: { flagType, reason },
        });

        result = { flag };
        break;
      }

      case "resolve_flag": {
        const { flagId, resolutionNotes } = params;

        const { data: flag, error: flagError } = await supabaseAdmin
          .from("user_flags")
          .update({
            resolved_at: new Date().toISOString(),
            resolved_by: userId,
            resolution_notes: resolutionNotes,
          })
          .eq("id", flagId)
          .select()
          .single();

        if (flagError) throw flagError;

        result = { flag };
        break;
      }

      case "admin_logs": {
        const { page = 1, limit = 50, category = "all" } = params || {};

        // Fetch admin action logs
        const { data: adminLogs } = await supabaseAdmin
          .from("admin_logs")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(500);

        // Fetch system logs (user activity + system errors)
        const { data: systemLogs } = await supabaseAdmin
          .from("system_logs")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(500);

        // Transform admin_logs to unified format
        const transformedAdminLogs = (adminLogs || []).map(log => ({
          id: log.id,
          created_at: log.created_at,
          category: "admin_action" as const,
          event_type: log.action,
          message: `${log.action.replace(/_/g, " ")} on ${log.target_type}`,
          user_id: log.admin_id,
          details: log.details,
          target_id: log.target_id,
          target_type: log.target_type,
        }));

        // Transform system_logs to unified format
        const transformedSystemLogs = (systemLogs || []).map(log => ({
          id: log.id,
          created_at: log.created_at,
          category: log.category as "user_activity" | "system_error" | "system_warning" | "system_info",
          event_type: log.event_type,
          message: log.message,
          user_id: log.user_id,
          details: log.details,
          generation_id: log.generation_id,
          project_id: log.project_id,
        }));

        // Combine and sort by date
        let allLogs = [...transformedAdminLogs, ...transformedSystemLogs]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        // Filter by category if specified
        if (category && category !== "all") {
          allLogs = allLogs.filter(log => log.category === category);
        }

        // Paginate
        const total = allLogs.length;
        const start = (page - 1) * limit;
        const paginatedLogs = allLogs.slice(start, start + limit);

        result = {
          logs: paginatedLogs,
          total,
          page,
          limit,
        };
        break;
      }

      case "user_details": {
        const { targetUserId } = params;

        // Get auth user
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(targetUserId);

        // Get profile
        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("*")
          .eq("user_id", targetUserId)
          .single();

        // Get subscription
        const { data: subscription } = await supabaseAdmin
          .from("subscriptions")
          .select("*")
          .eq("user_id", targetUserId)
          .eq("status", "active")
          .single();

        // Get credits
        const { data: credits } = await supabaseAdmin
          .from("user_credits")
          .select("*")
          .eq("user_id", targetUserId)
          .single();

        // Get projects count
        const { count: projectsCount } = await supabaseAdmin
          .from("projects")
          .select("*", { count: "exact", head: true })
          .eq("user_id", targetUserId);

        // Get deleted projects count - count distinct project_ids in generation_archives
        const { data: archivedProjects } = await supabaseAdmin
          .from("generation_archives")
          .select("project_id")
          .eq("user_id", targetUserId);
        
        // Get unique deleted project IDs (projects may have multiple generations)
        const deletedProjectIds = new Set(archivedProjects?.map(a => a.project_id) || []);
        const deletedProjectsCount = deletedProjectIds.size;

        // Get total generation costs for this user
        const { data: costsData } = await supabaseAdmin
          .from("generation_costs")
          .select("total_cost")
          .eq("user_id", targetUserId);

        const totalGenerationCost = costsData?.reduce((sum, c) => sum + (Number(c.total_cost) || 0), 0) || 0;

        // Get active generations count
        const { count: activeGenerationsCount } = await supabaseAdmin
          .from("generations")
          .select("*", { count: "exact", head: true })
          .eq("user_id", targetUserId);

        // Get archived generations count
        const { count: archivedGenerationsCount } = await supabaseAdmin
          .from("generation_archives")
          .select("*", { count: "exact", head: true })
          .eq("user_id", targetUserId);

        // Get recent generations for display
        const { data: generations } = await supabaseAdmin
          .from("generations")
          .select("*")
          .eq("user_id", targetUserId)
          .order("created_at", { ascending: false })
          .limit(10);

        // Get flags
        const { data: flags } = await supabaseAdmin
          .from("user_flags")
          .select("*")
          .eq("user_id", targetUserId)
          .order("created_at", { ascending: false });

        // Determine user status based on flags
        const activeFlags = flags?.filter(f => !f.resolved_at) || [];
        const isBanned = activeFlags.some(f => f.flag_type === "banned");
        const isSuspended = activeFlags.some(f => f.flag_type === "suspended");
        const userStatus = isBanned ? "banned" : isSuspended ? "suspended" : "active";

        // Get credit transactions
        const { data: transactions } = await supabaseAdmin
          .from("credit_transactions")
          .select("*")
          .eq("user_id", targetUserId)
          .order("created_at", { ascending: false })
          .limit(20);

        result = {
          user: authUser?.user,
          profile,
          subscription,
          credits,
          projectsCount: projectsCount || 0,
          deletedProjectsCount: deletedProjectsCount,
          totalGenerationCost,
          totalGenerations: (activeGenerationsCount || 0) + (archivedGenerationsCount || 0),
          activeGenerations: activeGenerationsCount || 0,
          archivedGenerations: archivedGenerationsCount || 0,
          userStatus,
          recentGenerations: generations,
          flags,
          recentTransactions: transactions,
        };
        break;
      }

      case "api_calls_list": {
        const { page = 1, limit = 50, status, provider, user_id, user_search } = params || {};

        // If user_search is provided, resolve to user_id(s)
        let resolvedUserIds: string[] = [];
        if (user_search && typeof user_search === "string" && user_search.trim()) {
          const searchLower = user_search.trim().toLowerCase();
          const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
          const { data: profiles } = await supabaseAdmin.from("profiles").select("user_id, display_name");
          
          resolvedUserIds = (authUsers?.users || [])
            .filter(u => {
              const profile = profiles?.find(p => p.user_id === u.id);
              return (
                u.email?.toLowerCase().includes(searchLower) ||
                profile?.display_name?.toLowerCase().includes(searchLower)
              );
            })
            .map(u => u.id);

          // If no users matched, return empty
          if (resolvedUserIds.length === 0) {
            result = { logs: [], total: 0, page, limit, totalPages: 0, resolvedUsers: [] };
            break;
          }
        }

        let query = supabaseAdmin
          .from("api_call_logs")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false });

        if (status) {
          query = query.eq("status", status);
        }
        if (provider) {
          query = query.eq("provider", provider);
        }
        // Apply user filter
        if (user_id) {
          query = query.eq("user_id", user_id);
        } else if (resolvedUserIds.length > 0) {
          query = query.in("user_id", resolvedUserIds);
        }

        const { data: logs, count, error: logsError } = await query
          .range((page - 1) * limit, page * limit - 1);

        if (logsError) throw logsError;

        // Enrich logs with user email for display
        const logUserIds = [...new Set((logs || []).map(l => l.user_id))];
        let userEmailMap: Record<string, string> = {};
        if (logUserIds.length > 0) {
          const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
          const { data: profiles } = await supabaseAdmin.from("profiles").select("user_id, display_name");
          for (const uid of logUserIds) {
            const au = authUsers?.users.find(u => u.id === uid);
            const profile = profiles?.find(p => p.user_id === uid);
            userEmailMap[uid] = profile?.display_name || au?.email?.split("@")[0] || uid.slice(0, 8);
          }
        }

        result = {
          logs: (logs || []).map(l => ({ ...l, user_display: userEmailMap[l.user_id] || l.user_id.slice(0, 8) })),
          total: count || 0,
          page,
          limit,
          totalPages: Math.ceil((count || 0) / limit),
        };
        break;
      }

      case "api_call_detail": {
        const { callId } = params || {};
        if (!callId) throw new Error("callId is required");

        // Get the specific call
        const { data: call, error: callError } = await supabaseAdmin
          .from("api_call_logs")
          .select("*")
          .eq("id", callId)
          .single();

        if (callError) throw callError;

        // Get related API calls for the same generation (if generation_id exists)
        let relatedCalls: any[] = [];
        if (call.generation_id) {
          const { data: related } = await supabaseAdmin
            .from("api_call_logs")
            .select("*")
            .eq("generation_id", call.generation_id)
            .order("created_at", { ascending: true });
          relatedCalls = related || [];
        }

        // Get system logs for the same generation
        let systemLogs: any[] = [];
        if (call.generation_id) {
          const { data: sysLogs } = await supabaseAdmin
            .from("system_logs")
            .select("*")
            .eq("generation_id", call.generation_id)
            .order("created_at", { ascending: true })
            .limit(200);
          systemLogs = sysLogs || [];
        }

        // Enrich call with user display
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
        const { data: profiles } = await supabaseAdmin.from("profiles").select("user_id, display_name");
        const au = authUsers?.users.find(u => u.id === call.user_id);
        const profile = profiles?.find(p => p.user_id === call.user_id);
        const userDisplay = profile?.display_name || au?.email?.split("@")[0] || call.user_id.slice(0, 8);

        result = {
          call: { ...call, user_display: userDisplay },
          related_calls: relatedCalls.map(rc => ({
            ...rc,
            user_display: userDisplay,
          })),
          system_logs: systemLogs,
        };
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    logStep("Action completed", { action });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
