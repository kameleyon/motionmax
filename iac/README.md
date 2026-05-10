# MotionMax Infrastructure-as-Code

This directory holds Terraform configurations describing the cloud
infrastructure that powers MotionMax. Each subdirectory targets a single
provider (Cloudflare, Supabase, Vercel) and is initialized / planned /
applied independently — there is intentionally **no root module** that
ties them together, because the state files for these providers should
not share a backend.

> **Source of truth, not auto-applier.** These configs are committed so
> infrastructure changes flow through pull-request review the same way
> application code does. They are **not** wired into CI to `terraform
> apply` automatically. Until trust is established the workflow is:
>
> 1. Open a PR with the proposed `.tf` change.
> 2. A reviewer runs `terraform plan` locally and pastes the plan output
>    into the PR.
> 3. After merge, an authorized operator runs `terraform apply` from
>    their workstation.
>
> If/when we move to auto-apply we'll add a separate
> `iac.yml` workflow gated on the `infrastructure` GitHub environment
> with required reviewers (mirrors the prod-deploy gate added in
> `B-NEW-17 / Part D`).

---

## Layout

```
iac/
├── README.md            ← you are here
├── betterstack/         ← uptime monitors + public status page (Terraform)
├── cloudflare/          ← DNS records, WAF managed ruleset
├── pagerduty/           ← on-call rotations + escalation policy (optional TF)
├── sentry/              ← alert rules as JSON, importable via API or TF
├── supabase/            ← project settings (limited; most config still
│                          requires the dashboard or Supabase CLI)
└── vercel/              ← Vercel project + env-var bindings (production
                           and preview targets)
```

## Bootstrap procedure

For each subdirectory:

```bash
cd iac/<provider>
cp terraform.tfvars.example terraform.tfvars   # fill in non-secret values
terraform init
terraform plan -out=plan.out
# review the plan, share it on the PR
terraform apply plan.out
```

Run `terraform init` the first time only — afterwards `plan` and
`apply` are sufficient.

## Required environment variables (CI / operator workstation)

These are read by the providers via `TF_VAR_*` so they never land in
state files committed to git:

| Var                        | Where used     | Source                                                                |
| -------------------------- | -------------- | --------------------------------------------------------------------- |
| `TF_VAR_cloudflare_api_token` | `iac/cloudflare/` | Cloudflare dashboard → My Profile → API Tokens (Zone:DNS edit + WAF) |
| `TF_VAR_cloudflare_zone_id`   | `iac/cloudflare/` | Cloudflare dashboard → motionmax.io zone → Overview                  |
| `TF_VAR_vercel_api_token`     | `iac/vercel/`     | Vercel dashboard → Account Settings → Tokens                         |
| `TF_VAR_vercel_team_id`       | `iac/vercel/`    | Vercel dashboard → Team Settings → General                            |
| `SUPABASE_ACCESS_TOKEN`       | `iac/supabase/`  | Supabase dashboard → Account → Access Tokens (the provider reads this env var directly — no `TF_VAR_` prefix) |
| `TF_VAR_supabase_project_ref` | `iac/supabase/`  | Supabase dashboard → Project Settings → General → Reference ID       |

These are also configured as GitHub Actions secrets so that — once we
enable an `iac.yml` workflow — the same names work without changes.

## State backend

State is stored locally for now (`terraform.tfstate` in each
subdirectory, gitignored). Before moving to multi-operator apply we
need a remote backend. Two reasonable options:

- **Terraform Cloud** (free for ≤5 users) — best UX, includes plan/apply
  in the web UI and can drive the GitHub integration.
- **Supabase Postgres backend** — keep state in our existing DB via
  the `pg` backend; one less SaaS dependency but harder to audit.

Tracked under follow-up issue **B-NEW-17 / state-backend**.

## What is **not** in here (yet)

- **Railway** — the worker host. Railway has no first-class Terraform
  provider; configuration lives in `worker/railway.json` plus the
  Railway dashboard for env vars and deploy hooks. See
  `docs/deploy-flow.md` for the rationale and rollback procedure.
- **Sentry** — alert rules ARE codified in `iac/sentry/alert-rules.json`
  (B-NEW-19). Project-level settings (DSN visibility, sourcemap upload
  scopes) still live in the Sentry UI and aren't worth Terraforming.
- **DNS for staging subdomain** — the staging.motionmax.io record will
  be added by **Part D** of this issue; a TODO is left in
  `iac/cloudflare/dns.tf`.
