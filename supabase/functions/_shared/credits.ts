/**
 * Shared credit deduction/refund helpers for edge functions.
 * Both generate-cinematic and generate-video use the same RPC pattern —
 * centralising here prevents the two from drifting apart.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CreditResult {
  success: boolean;
  error?: string;
}

/** Deduct credits atomically. Returns false if the user has insufficient balance. */
export async function deductCredits(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  description: string,
): Promise<CreditResult> {
  const { data, error } = await supabase.rpc("deduct_credits_securely", {
    p_user_id: userId,
    p_amount: amount,
    p_transaction_type: "usage",
    p_description: description,
  });

  if (error || !data) {
    return { success: false, error: error?.message ?? "Insufficient credits" };
  }
  return { success: true };
}

/** Refund credits. Fire-and-forget safe — logs but never throws. */
export async function refundCredits(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  description: string,
): Promise<void> {
  const { error } = await supabase.rpc("refund_credits_securely", {
    p_user_id: userId,
    p_amount: amount,
    p_description: description,
  });
  if (error) {
    console.error(`[Credits] Refund failed for user ${userId} (${amount} credits):`, error.message);
  }
}
