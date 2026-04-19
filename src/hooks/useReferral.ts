import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

const REFERRAL_BASE_URL = "https://www.motionmax.io";

export interface ReferralState {
  referralCode: string | null;
  referralLink: string;
  totalReferrals: number;
  totalCreditsEarned: number;
  isLoading: boolean;
}

async function fetchOrCreateReferral(userId: string): Promise<{
  code: string;
  totalReferrals: number;
  totalCreditsEarned: number;
}> {
  // generate_referral_code is idempotent — safe to call every time
  const { data: code, error: rpcError } = await supabase.rpc(
    "generate_referral_code",
    { p_user_id: userId },
  );

  if (rpcError || !code) {
    throw new Error(rpcError?.message ?? "Failed to generate referral code");
  }

  // Fetch the counters from referral_codes (RLS: own row only)
  const { data: row, error: selectError } = await supabase
    .from("referral_codes")
    .select("total_referrals, total_credits_earned")
    .eq("user_id", userId)
    .single();

  if (selectError) {
    // Non-fatal: return counters as 0 if the read fails
    console.warn("[useReferral] Could not read referral counters:", selectError.message);
    return { code, totalReferrals: 0, totalCreditsEarned: 0 };
  }

  return {
    code,
    totalReferrals: row?.total_referrals ?? 0,
    totalCreditsEarned: row?.total_credits_earned ?? 0,
  };
}

export function useReferral(): ReferralState {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["referral", user?.id],
    queryFn: () => fetchOrCreateReferral(user!.id),
    enabled: !!user?.id,
    // Referral codes rarely change — keep in cache for the session
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
  });

  const referralCode = data?.code ?? null;
  const referralLink = referralCode
    ? `${REFERRAL_BASE_URL}/?ref=${referralCode}`
    : REFERRAL_BASE_URL;

  return {
    referralCode,
    referralLink,
    totalReferrals: data?.totalReferrals ?? 0,
    totalCreditsEarned: data?.totalCreditsEarned ?? 0,
    isLoading,
  };
}
