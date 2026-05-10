# iac/vercel

Vercel-managed pieces of the MotionMax production stack:

- **`vercel_project`** — the existing `motionmax` project (Vite app), git-linked.
- **`vercel_project_environment_variable`** — Supabase URL / publishable
  key bindings, scoped separately to `production` and `preview` targets.

## Important: import the existing project before first apply

The `motionmax` Vercel project already exists. Running `terraform
apply` blindly will try to **create a new project** (and fail with a
slug-conflict). Import first:

```bash
# Find the project ID:
#   vercel projects ls --scope <team>
# It looks like prj_XXXXXXXXXXXXXXXXXXXXXXXX

terraform init
terraform import vercel_project.app prj_XXXXXXXXXXXX
```

After the import, `terraform plan` will show what's *currently set* in
Vercel vs. what this config declares — review carefully before applying.

## Running

```bash
cp terraform.tfvars.example terraform.tfvars
# fill in vercel_team_id

# Sensitive values via env (do NOT put in terraform.tfvars):
export TF_VAR_vercel_api_token=...
export TF_VAR_supabase_url_production=https://ayjbvcikuwknqdrpsdmj.supabase.co
export TF_VAR_supabase_publishable_key_production=...
export TF_VAR_supabase_url_preview=https://<staging-ref>.supabase.co
export TF_VAR_supabase_publishable_key_preview=...

terraform plan
terraform apply
```

## Files

| File                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `versions.tf`              | Terraform + provider version pins (`vercel ~> 3`)                   |
| `provider.tf`              | Provider config — reads token + team from variables                  |
| `variables.tf`             | All inputs (token, team, repo, branch, Supabase wiring)             |
| `project.tf`               | The `vercel_project.app` resource                                    |
| `env.tf`                   | Env-var bindings — production + preview Supabase                     |
| `outputs.tf`               | Project ID/name for cross-module use                                 |
| `terraform.tfvars.example` | Template for the gitignored `terraform.tfvars`                       |

## Migration plan for the rest of the env-var inventory

Today this module manages only the Supabase wiring. The remaining
production env vars (Stripe keys, Sentry DSN, OpenRouter, Hypereal,
ElevenLabs, etc.) are still managed in the Vercel dashboard. Migration
plan:

1. Snapshot the current Vercel env list (`vercel env pull` against prod).
2. Audit each var — drop anything no longer used.
3. Add resources here in groups (one PR per provider: Stripe, Sentry, …)
   with the values injected via `TF_VAR_*`.
4. After each PR is applied, **delete the dashboard copy** so we don't
   end up with two sources of truth.

Tracked under follow-up issue **B-NEW-17 / vercel-env-migration**.

## Gotchas

- **Sensitive values in plan output.** `sensitive = true` on the
  resource hides the value, but Terraform may still write it to the
  state file. Use a remote backend with encryption-at-rest before
  multi-operator apply.
- **Concurrent dashboard edits.** If someone edits a var in the
  dashboard that's also declared here, the next `apply` will revert
  it. Communicate before changing anything that lives in both places.
