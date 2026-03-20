# MotionMax — Disaster Recovery Plan

## 1. Infrastructure Overview

| Component        | Provider  | Region       |
|------------------|-----------|--------------|
| Frontend         | Vercel    | Edge (global)|
| Database         | Supabase  | us-east-1    |
| Storage          | Supabase  | us-east-1    |
| Edge Functions   | Supabase  | us-east-1    |
| Worker           | Cloudflare| global       |
| Payments         | Stripe    | global       |

---

## 2. Backup Schedule

### Database
- **Automated snapshots**: Daily (managed by Supabase Pro plan)
- **Retention**: 30 days
- **Point-in-time recovery**: Enabled (Pro plan, 7-day window)

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
| **RPO** (Recovery Point Objective) | 1 hour | 24 hours (daily snapshot) |

---

## 4. Recovery Procedures

### 4.1 Database Restore (Full)

1. Go to **Supabase Dashboard → Project → Backups**
2. Select the desired snapshot
3. Click **Restore** and confirm
4. Verify with `SELECT count(*) FROM projects;` and compare to expected
5. Notify the team via Slack `#engineering-incidents`

**Estimated time**: 15–30 minutes

### 4.2 Database Restore (Point-in-Time)

1. Contact Supabase support or use `pg_restore` from the downloaded backup
2. Specify the target timestamp
3. Validate RLS policies re-applied correctly

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

| Test Type                  | Frequency  | Last Tested |
|---------------------------|------------|-------------|
| Database restore (snapshot)| Quarterly  | _TODO_      |
| Frontend rollback          | Monthly    | _TODO_      |
| Edge function rollback     | Quarterly  | _TODO_      |
| Full disaster simulation   | Annually   | _TODO_      |

---

## 7. Escalation Contacts

| Role              | Contact          | Method        |
|-------------------|------------------|---------------|
| Lead Engineer     | _TODO_           | Slack / Phone |
| Supabase Support  | support@supabase.com | Email / Dashboard |
| Vercel Support    | support@vercel.com   | Email / Dashboard |
| Stripe Support    | support@stripe.com   | Dashboard     |

---

## 8. Post-Incident Template

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
