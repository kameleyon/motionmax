# Revenue Reconciliation Runbook

Use this when the **Revenue** tab's number disagrees with what Stripe reports, when a user disputes a charge, or as a monthly close-the-books pass.

## What "revenue" means in this app

Three sources of truth, in priority order:

1. **Stripe dashboard** — the actual money. Always authoritative. `https://dashboard.stripe.com/payments`.
2. **`credit_transactions`** — local record of credit grants/debits/refunds keyed to a user. The Stripe webhook (`stripe-webhook` edge fn) writes a `purchase` or `subscription_grant` row here on every successful invoice.
3. **`subscriptions`** — current plan state (active / cancelled / past_due / trialing) per user. Stripe webhook keeps this in sync.

The Revenue tab joins these and surfaces totals; the **Activity** tab shows the underlying credit_transactions feed.

## Daily check (5 minutes)

1. Admin → **Revenue** tab → note **MRR** + **today's revenue**.
2. Open Stripe dashboard → Payments → today's totals.
3. The numbers should match within ±$1 (rounding on partial-month proration).

If they diverge by more than ±$5, drop into the deep-reconcile flow below.

## Deep reconcile

```sql
-- Stripe charges from the last 24 h (run in Supabase SQL editor):
SELECT user_id, amount, transaction_type, description, created_at
  FROM public.credit_transactions
 WHERE transaction_type IN ('purchase','subscription_grant','refund')
   AND created_at > NOW() - INTERVAL '24 hours'
 ORDER BY created_at DESC;
```

Cross-reference each row against the matching Stripe payment. Common disagreements:

| Disagreement | Likely cause | Fix |
|---|---|---|
| Stripe charge succeeded, no `credit_transactions` row | Webhook delivery failure (Resend / network) | Re-run webhook from Stripe dashboard → "Resend" on the event. The handler is idempotent (UPSERT on `stripe_invoice_id`). |
| Charge succeeded, row has wrong amount | Currency / cents conversion bug | Check the webhook log. If isolated, manually correct the row + grant any missing credits via `admin_grant_credits`. |
| Refund issued, no matching `refund` row | Stripe refund webhook not configured | Add `charge.refunded` to the Stripe webhook event types. |
| `subscriptions.status='active'` but no monthly grant for >35 days | Webhook `invoice.payment_succeeded` not firing | Same — re-add to webhook event types and re-send the missed invoice. |

## When to refund

Founder-discretion territory. The mechanical refund flow:

1. Refund in Stripe (dashboard → payment → Refund).
2. Stripe `charge.refunded` webhook arrives → handler inserts a `transaction_type='refund'` row + debits the equivalent credits.
3. If the credit debit would push the balance negative (user already used the credits), **don't** rebound — the founder's call.

## Monthly close

End of each month:

1. Pull a CSV from Stripe Reports → "Balance summary" → match against the sum of `credit_transactions` for the same period.
2. Note any outstanding disputes / chargebacks in Stripe → cross-check `admin_logs` for any matching `force_refund` or admin manual debit rows.
3. Update the bookkeeping spreadsheet.

## When NOT to debug here

- **A user says "I was charged but didn't get credits."** Check `credit_transactions` first; if a row exists, the credits ARE there — point them to Account → Credits in the app. If no row, then dig.
- **A user says "I got refunded but my account is locked."** The `subscriptions.status` flips to `past_due` on a chargeback; resolve the subscription state first, not the credit balance.
