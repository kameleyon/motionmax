# ──────────────────────────────────────────────────────────────────────
# Environment variable bindings for the Vercel project.
#
# We split production and preview deliberately so a staging/preview
# Supabase project can be swapped in without touching prod.
#
# Values are NEVER committed — they're injected at apply time from
# TF_VAR_* env vars (see variables.tf). Marking the resource
# `sensitive = true` keeps the value out of `terraform plan`/`apply`
# output too.
#
# Anything listed here is "managed by Terraform" — adding a duplicate
# in the Vercel dashboard will collide on next apply. See README.md
# for the full migration plan; today the list is intentionally minimal
# (just the Supabase wiring) so we don't rip the rug out from under
# the existing dashboard-managed inventory.
# ──────────────────────────────────────────────────────────────────────

resource "vercel_project_environment_variable" "supabase_url_production" {
  project_id = vercel_project.app.id
  key        = "VITE_SUPABASE_URL"
  value      = var.supabase_url_production
  target     = ["production"]
  sensitive  = true
  comment    = "Production Supabase URL — managed by iac/vercel"
}

resource "vercel_project_environment_variable" "supabase_anon_production" {
  project_id = vercel_project.app.id
  key        = "VITE_SUPABASE_PUBLISHABLE_KEY"
  value      = var.supabase_publishable_key_production
  target     = ["production"]
  sensitive  = true
  comment    = "Production Supabase publishable key — managed by iac/vercel"
}

resource "vercel_project_environment_variable" "supabase_url_preview" {
  project_id = vercel_project.app.id
  key        = "VITE_SUPABASE_URL"
  value      = var.supabase_url_preview
  target     = ["preview"]
  sensitive  = true
  comment    = "Preview / staging Supabase URL — managed by iac/vercel"
}

resource "vercel_project_environment_variable" "supabase_anon_preview" {
  project_id = vercel_project.app.id
  key        = "VITE_SUPABASE_PUBLISHABLE_KEY"
  value      = var.supabase_publishable_key_preview
  target     = ["preview"]
  sensitive  = true
  comment    = "Preview / staging Supabase publishable key — managed by iac/vercel"
}
