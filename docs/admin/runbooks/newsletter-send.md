# Newsletter Send Runbook

Pre-flight + monitoring checklist for any campaign that goes to >50 recipients.

## Pre-flight

1. **Subject line ≤60 chars.** The composer warns past 60. Gmail truncates at ~78 on desktop, ~36 on mobile.
2. **Audience matches intent.** "All opted-in" is the largest blast radius. Studio/Pro/Free filters are evaluated against active subscriptions only — free-tier users on a cancelled paid plan get the Free segment.
3. **Send a test to yourself first.** Composer toolbar → **Send test → me**. Worker delivers within ~30 s. Check the rendered email in **your own Gmail** (not the Resend dashboard preview):
   - Subject + preheader render correctly
   - CTA URL works on mobile
   - Footer has the unsubscribe link with `?t=<token>`
   - Gmail's native "Unsubscribe" button shows up (means `List-Unsubscribe` header parsed correctly)
4. **Verify the schedule time** if scheduled. The picker uses your local time but stores UTC; double-check by reading the Status row after Save Draft.

## Send / Schedule

- **Save draft** stays a draft until you click Schedule or trigger a test.
- **Schedule send** flips status to `scheduled`. The worker's `handleNewsletterSend` polls every 30 s for matured rows and atomically claims the campaign (`scheduled` → `sending`).
- The worker resolves the audience via `newsletter_resolve_audience(p_audience)`, bulk-inserts one `newsletter_sends` row per recipient, then drains pending rows in 1000-row batches with 50-row Resend micro-batches. Rate-limit (429) → 2 s backoff.
- Per-recipient unsubscribe tokens are generated lazily via `ensure_unsubscribe_token(uuid)` — no upfront token migration needed.

## Monitoring during send

Watch the **Recent campaigns** table. The status pill cycles through `scheduled` → `sending` → `sent`. If it sticks on `sending` for >10 min for a moderate-sized audience, check:
1. Worker logs (Render dashboard) for `[Newsletter]` lines.
2. `newsletter_sends` rows for this campaign — `status='pending'` count should be falling.
3. RESEND_API_KEY is still set (`supabase secrets list` if you have CLI access; otherwise check the Edge Functions secret panel).

## Post-send

- Open / click rates populate over the next ~5 min as the `resend-webhook` edge function receives `email.opened` and `email.clicked` events from Resend. Each event updates the matching `newsletter_sends` row by `resend_message_id`.
- Bounces (`email.bounced`) flip the row to `status='bounced'`. Hard bounces stay; the operator can disable the address in profiles manually.
- Spam complaints (`email.complained`) automatically flip `profiles.marketing_opt_in = false` — CAN-SPAM compliance.
- Unsubscribes (footer link or Gmail's one-click) call `unsubscribe_with_token` and stamp `newsletter_unsubscribed_at`.

## Cancel mid-flight

Only valid before status flips to `sent`:
1. Kill Switches tab → **Pause outbound email** (subsystem `newsletter`). The worker stops claiming campaigns within ≤30 s.
2. Manually update the campaign row: `UPDATE newsletter_campaigns SET status='cancelled' WHERE id='…'`. Pending sends stay un-emitted.
3. Disengage the kill switch when ready.

## Audit

`admin_create_campaign`, `admin_schedule_campaign`, `admin_cancel_campaign`, and `admin_send_test_to_self` all write to `admin_logs`. The Activity tab surfaces them under `newsletter_*` events.
