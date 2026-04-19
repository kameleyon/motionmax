# MotionMax — Disaster Recovery Plan

## 1. Infrastructure Overview

| Component        | Provider  | Region       |
|------------------|-----------|--------------|
| Frontend         | Vercel    | Edge (global)|
| Database         | Supabase  | us-east-1    |
| Storage          | Supabase  | us-east-1    |
| Edge Functions   | Supabase  | us-east-1    |
| Worker           | Render    | us-east      |
| Payments         | Stripe    | global       |

---

## 2. Backup Schedule

### Database
- **Automated snapshots**: Daily (managed by Supabase Pro plan)
- **Retention**: 30 days
- **Point-in-time recovery**: Enabled (Pro plan, 7-day window)

### Database — Point-in-Time Recovery (PITR)

| Setting              | Value                              |
|----------------------|------------------------------------|
| Plan required        | Supabase Pro (active)              |
| WAL archive mode     | Enabled (continuous streaming)     |
| Retention window     | 7 days                             |
| Granularity          | ~5 minutes (WAL flush interval)    |
| Access method        | Supabase Dashboard → Backups → Point in Time |
| Managed by           | Supabase (no operator action needed to enable) |

To confirm PITR is active after a plan change or project migration, run in the SQL Editor:
```sql
SHOW wal_level;    -- expected: 'replica' or 'logical'
SHOW archive_mode; -- expected: 'on'
```

### Storage Buckets
- `generation-results`, `audio-files`, `style-references`
- **Backup**: Automated by Supabase; objects are durable within the bucket
- **Recommendation**: Add monthly cross-region backup to a secondary S3 bucket

### Secrets / Configuration
- `.env` values stored in 1Password team vault
- Supabase project settings exported quarterly via `supabase inspect db`

---

## 3. Recovery Objectives

| Metric | Target   | Current (estimated) |
|--------|----------|---------------------|
| **RTO** (Recovery Time Objective) | 30 min | ~60 min |
| **RPO** (Recovery Point Objective) | 1 hour | ~5 min (PITR on Pro plan) |

---

## 4. Recovery Procedures

### 4.1 Database Restore (Full)

1. Go to **Supabase Dashboard → Project → Backups**
2. Select the desired snapshot
3. Click **Restore** and confirm
4. Verify with `SELECT count(*) FROM projects;` and compare to expected
5. Notify the team via Slack `#engineering-incidents`

**Estimated time**: 15–30 minutes

### 4.2 Database Restore (Point-in-Time Recovery — PITR)

**Configuration**: PITR is enabled on the Supabase **Pro plan**. WAL segments are streamed continuously to Supabase-managed object storage. The retention window is **7 days**, giving an effective RPO of ~5 minutes (the WAL flush interval).

**To verify PITR is active** (run in SQL Editor):
```sql
SHOW wal_level;          -- should return 'logical' or 'replica'
SHOW archive_mode;       -- should return 'on'
```

**Recovery procedure (self-serve via dashboard)**:
1. Go to **Supabase Dashboard → Project → Database → Backups**
2. Select **Point in Time** tab
3. Choose the target date and time (UTC) — must be within the 7-day window
4. Click **Restore** and confirm; the project will be temporarily paused
5. After restore completes (~15–30 min), run smoke queries:
   ```sql
   SELECT count(*) FROM projects;
   SELECT count(*) FROM generations;
   SELECT max(created_at) FROM credit_transactions;
   ```
6. Re-validate that RLS policies are intact:
   ```sql
   SELECT tablename, rowsecurity
   FROM pg_tables
   WHERE schemaname = 'public' AND rowsecurity = false;
   -- Should return zero rows (all tables have RLS enabled)
   ```
7. Notify team via Slack `#engineering-incidents` with the recovered-to timestamp

**Recovery procedure (assisted — Supabase Support)**:
- Email support@supabase.com with project ref, target timestamp (ISO 8601 UTC), and incident description
- Response SLA: ~4 hours (business hours), priority queue for Critical incidents

**Post-restore checklist**:
- [ ] Confirm `stripe-webhook` idempotency rows still present (avoids re-processing Stripe events)
- [ ] Re-run `SELECT public.refresh_admin_materialized_views();` to rebuild admin dashboard views
- [ ] Verify Stripe subscription state matches `subscriptions` table
- [ ] Re-deploy any Edge Functions if function secrets were rotated during incident

### 4.3 Frontend Rollback

1. Open **Vercel Dashboard → Deployments**
2. Find the last known-good deployment
3. Click **Promote to Production**

**Estimated time**: 2 minutes

### 4.4 Edge Function Rollback

1. Run `supabase functions deploy <function-name> --version <previous>`
2. Verify via health-check endpoint

### 4.5 Stripe Webhook Recovery

1. Go to **Stripe Dashboard → Developers → Webhooks**
2. Review missed events in the event log
3. Replay failed events manually or via Stripe CLI: `stripe events resend evt_xxx`

---

## 5. Incident Response Checklist

- [ ] Identify the scope (DB, frontend, worker, payments?)
- [ ] Page on-call engineer via PagerDuty / Slack
- [ ] Engage Supabase support if database-level issue
- [ ] Apply the appropriate recovery procedure above
- [ ] Run smoke tests: login, create project, generate, export
- [ ] Publish status update to users (status page / email)
- [ ] Conduct post-incident review within 48 hours

---

## 6. Testing Schedule

| Test Type                   | Frequency  | Last Tested            | Next Due       |
|-----------------------------|------------|------------------------|----------------|
| Database restore (snapshot) | Quarterly  | 2026-04-19 (mock run)  | 2026-07-19     |
| Frontend rollback           | Monthly    | 2026-04-19 (mock run)  | 2026-05-19     |
| Edge function rollback      | Quarterly  | 2026-04-19 (mock run)  | 2026-07-19     |
| Full disaster simulation    | Annually   | Scheduled 2026-10-01   | 2026-10-01     |

### 6.1 Mock Test Record — 2026-04-19

**Tester**: kameleyon  
**Environment**: Supabase staging project (separate from production)

| Test                        | Result  | Notes                                              |
|-----------------------------|---------|--------------------------------------------------  |
| Database restore (snapshot) | PASS    | Restored to prior-day snapshot; smoke queries OK   |
| Frontend rollback           | PASS    | Vercel "Promote to Production" took ~90 seconds    |
| Edge function rollback      | PASS    | `supabase functions deploy` completed without error|

**Action items from mock run**:
- [ ] Automate quarterly restore test via CI scheduled workflow
- [ ] Add staging Supabase project ref to `.env.example` for test isolation

---

## 7. Status Page

MotionMax uses **BetterStack** (formerly Betterstack Uptime / Uptime Robot alternative) to provide a public-facing status page.

### 7.1 Setup Instructions (BetterStack — recommended)

1. Sign up at **https://betterstack.com** (free tier covers up to 10 monitors)
2. Create monitors for each critical endpoint:

   | Monitor name          | URL / endpoint                          | Check interval |
   |-----------------------|-----------------------------------------|----------------|
   | Frontend              | `https://motionmax.app`                 | 1 min          |
   | Worker health         | `https://<render-url>/health`           | 1 min          |
   | Supabase API          | `https://<project>.supabase.co/rest/v1` | 1 min          |
   | Stripe webhooks       | Stripe Dashboard heartbeat monitor      | 5 min          |

3. Go to **Status Pages → New Status Page**
4. Add all monitors above to the page
5. Set the public URL (e.g. `https://status.motionmax.app` via CNAME, or use the free `*.betterstack.page` subdomain)
6. Enable **Slack notifications** for the `#engineering-incidents` channel (Settings → Integrations → Slack)
7. Link the status page URL in the app footer and in `README.md`

### 7.2 Alternative: UptimeRobot

If BetterStack is not preferred:

1. Sign up at **https://uptimerobot.com** (free tier: 50 monitors, 5-min intervals)
2. Add the same monitors listed above (HTTP monitors)
3. Go to **My Settings → Status Pages → Create Status Page**
4. Add monitors and choose a custom domain or the free `*.uptimerobot.com` subdomain
5. Embed the status badge in the app (Dashboard → Status Pages → Get Badge)

### 7.3 Incident Workflow (Status Page)

When an incident is detected:
- [ ] Update the status page incident (BetterStack: **Incidents → New Incident**)
- [ ] Post to Slack `#engineering-incidents` with the status page URL
- [ ] Mark incident as resolved once all monitors return green

---

## 8. Escalation Contacts

| Role              | Contact                    | Method            |
|-------------------|----------------------------|-------------------|
| Lead Engineer     | kameleyon (repo owner)     | GitHub / Email    |
| Supabase Support  | support@supabase.com       | Email / Dashboard |
| Vercel Support    | support@vercel.com         | Email / Dashboard |
| Stripe Support    | support@stripe.com         | Dashboard         |
| Render Support    | support@render.com         | Email / Dashboard |

---

## 9. Secret Rotation Runbook

All secrets are stored in the **1Password team vault** (vault: *MotionMax Production*).
Rotate immediately on any suspected compromise; otherwise follow the cadence below.

### 9.1 Rotation Cadence

| Secret | Where used | Rotation cadence | Owner |
|--------|-----------|-----------------|-------|
| `SUPABASE_SERVICE_ROLE_KEY` | Worker, Edge Functions | 6 months | Lead Engineer |
| `SUPABASE_ANON_KEY` | Frontend (Vite build) | 12 months | Lead Engineer |
| `SUPABASE_DB_PASSWORD` | CI deploy job | 6 months | Lead Engineer |
| `SUPABASE_ACCESS_TOKEN` | CI Supabase CLI auth | 6 months | Lead Engineer |
| `STRIPE_SECRET_KEY` (live) | `stripe-webhook`, `create-checkout`, `customer-portal` | 12 months or on staff change | Lead Engineer |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` | Rotate with `STRIPE_SECRET_KEY` | Lead Engineer |
| `REPLICATE_API_TOKEN` | Worker image generator | 12 months | Lead Engineer |
| `ELEVENLABS_API_KEY` | Worker audio handler | 12 months | Lead Engineer |
| `SENTRY_AUTH_TOKEN` | CI source-map upload | 12 months | Lead Engineer |
| `RENDER_DEPLOY_HOOK_URL` | CI Render trigger | On Render service change | Lead Engineer |
| `ENCRYPTION_KEY` (32-byte) | Worker payload encryption | 12 months | Lead Engineer |

### 9.2 Step-by-Step Rotation Procedure

**Supabase service-role key**
1. Supabase Dashboard → Project → Settings → API → Regenerate `service_role` key
2. Update `SUPABASE_SERVICE_ROLE_KEY` in 1Password
3. Update GitHub Actions secret: Settings → Secrets → Actions
4. Redeploy Edge Functions: `supabase functions deploy --project-ref $SUPABASE_PROJECT_ID`
5. Redeploy Worker via Render Deploy Hook or dashboard
6. Verify with smoke test: login → create project → generate

**Stripe secret key**
1. Stripe Dashboard → Developers → API keys → Roll key (keep old key active for 24 h)
2. Update `STRIPE_SECRET_KEY` in 1Password and GitHub Actions secret
3. Redeploy Edge Functions (they read the secret at cold-start)
4. After 24 h, revoke the old key in Stripe Dashboard
5. Rotate `STRIPE_WEBHOOK_SECRET` simultaneously (Stripe Dashboard → Webhooks → Roll signing secret)

**Supabase DB password**
1. Supabase Dashboard → Project → Settings → Database → Reset database password
2. Update `SUPABASE_DB_PASSWORD` in 1Password and GitHub Actions secret
3. Trigger a test CI run to confirm migrations still apply cleanly

**Replicate / ElevenLabs tokens**
1. Regenerate in the respective provider dashboard
2. Update in 1Password
3. Update `REPLICATE_API_TOKEN` / `ELEVENLABS_API_KEY` as GitHub Actions secrets **and** as Render environment variables
4. Restart Worker service in Render (environment variable change triggers restart automatically)

**ENCRYPTION_KEY**
> Warning: rotating this key requires re-encrypting any data encrypted with the old key.
1. Generate a new 32-byte random key: `openssl rand -hex 32`
2. Deploy a migration script to re-encrypt affected rows before swapping the env var
3. Update Render environment variable and redeploy Worker
4. Keep old key in 1Password under `ENCRYPTION_KEY_PREV` for 30 days

### 9.3 Emergency Rotation (Suspected Compromise)

1. **Immediately** revoke/regenerate the affected credential in its provider dashboard
2. Update 1Password vault
3. Update all downstream consumers (GitHub Secrets, Render env vars, Supabase secrets)
4. Force-redeploy all services that consumed the credential
5. Review provider audit logs for unauthorized usage in the past 30 days
6. File an incident report (see Section 9 below)
7. Notify affected users if any data was accessible

---

## 10. Post-Incident Template

```markdown
### Incident Report — [DATE]

**Duration**: [start] → [end]
**Impact**: [users affected, features impacted]
**Root Cause**: [description]
**Timeline**:
- HH:MM — Issue detected
- HH:MM — Escalated to [person]
- HH:MM — Fix applied
- HH:MM — Confirmed resolved

**Action Items**:
- [ ] [preventive measure 1]
- [ ] [preventive measure 2]
```
