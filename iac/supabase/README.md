# iac/supabase

> **Caveat first.** The Supabase Terraform provider is **narrow**.
> It can pin a handful of project settings (API, auth, DB, storage)
> and read API keys back, but it does **not** manage schema,
> migrations, edge functions, RLS policies, buckets, auth providers,
> webhooks, or service-role JWTs. Most Supabase configuration still
> goes through the dashboard or `supabase` CLI. This module exists
> mainly to (a) get the project ref into version control and (b)
> codify the small set of settings the provider does support.

## What this module manages

- `supabase_settings.project` — `database.statement_timeout`,
  `api.db_schema`, `api.db_extra_search_path`, `api.max_rows`,
  `auth.site_url`, `storage.fileSizeLimit`, image transformation flag.
- `data.supabase_apikeys.project` — read-only access to anon /
  service-role keys for downstream modules.

## What this module does NOT manage (still manual / CLI / other tools)

| Concern               | Where it lives today                                  |
| --------------------- | ----------------------------------------------------- |
| DB schema             | `supabase/migrations/*.sql` deployed via `supabase db push` (CI) |
| RLS policies          | Migrations + dashboard                                |
| Edge functions        | `supabase/functions/<name>/index.ts` deployed via CI  |
| Buckets               | Migrations or dashboard                               |
| Auth providers (OAuth)| Dashboard                                             |
| Storage CORS          | Dashboard                                             |
| Webhooks              | Dashboard                                             |

When/if Supabase ships first-class Terraform support for these we'll
extend this module; until then, document changes in PR descriptions.

## Production / staging swap

The `supabase_project_ref` variable is the swap point. Apply twice
with different `-var-file`:

```bash
# Production
terraform workspace new prod   # one-time
terraform workspace select prod
terraform apply -var-file=terraform.tfvars

# Staging
terraform workspace new staging   # one-time
terraform workspace select staging
terraform apply -var-file=staging.tfvars
```

Each workspace gets its own state, so the two project refs never
collide.

## Run

```bash
export SUPABASE_ACCESS_TOKEN=<personal access token from dashboard>

cp terraform.tfvars.example terraform.tfvars
# fill in supabase_project_ref

terraform init
terraform plan
terraform apply
```

## Files

| File                       | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `versions.tf`              | Terraform + provider version pins (`supabase ~> 1.0`)   |
| `provider.tf`              | Empty `provider "supabase" {}` — token via env var       |
| `variables.tf`             | Project ref + a small set of settings                   |
| `settings.tf`              | The `supabase_settings` resource + apikeys data source  |
| `outputs.tf`               | Project ref + sensitive API keys                        |
| `terraform.tfvars.example` | Template                                                |
