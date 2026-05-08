-- ============================================================
-- Manual plan grant: tbijou@me.com → Studio
-- ============================================================
-- One-off comp grant. Idempotent: if the user already has a
-- subscription row, plan_name + status are updated in place;
-- otherwise a new row is inserted. Uses 'manual_studio_<uuid>'
-- as a synthetic stripe_subscription_id so it never collides
-- with a real Stripe-issued id.

BEGIN;

DO $$
DECLARE
  v_user_id uuid;
  v_existing_sub_id uuid;
BEGIN
  SELECT id INTO v_user_id
    FROM auth.users
   WHERE email = 'tbijou@me.com'
   LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'tbijou@me.com not found in auth.users — skipping grant';
    RETURN;
  END IF;

  -- Update existing subscription (any status) → studio + active
  SELECT id INTO v_existing_sub_id
    FROM public.subscriptions
   WHERE user_id = v_user_id
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_existing_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
       SET plan_name = 'studio',
           status    = 'active',
           cancel_at_period_end = false,
           current_period_end   = NOW() + INTERVAL '100 years',
           updated_at = NOW()
     WHERE id = v_existing_sub_id;
    RAISE NOTICE 'Updated existing subscription % → studio/active for tbijou@me.com', v_existing_sub_id;
  ELSE
    INSERT INTO public.subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id,
      plan_name, status, current_period_start, current_period_end
    ) VALUES (
      v_user_id,
      'manual_studio_' || v_user_id::text,
      'manual_studio_' || v_user_id::text,
      'studio',
      'active',
      NOW(),
      NOW() + INTERVAL '100 years'
    );
    RAISE NOTICE 'Inserted new studio subscription for tbijou@me.com';
  END IF;
END $$;

COMMIT;
