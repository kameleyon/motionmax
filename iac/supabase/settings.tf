# ──────────────────────────────────────────────────────────────────────
# Supabase project settings.
#
# The Supabase Terraform provider is intentionally narrow today: it
# manages project-level settings (API, auth, db, storage) and pulls
# API keys, but it does NOT cover:
#   - Schema / migrations (use `supabase db push` from the CLI)
#   - Edge functions deploy (use `supabase functions deploy`)
#   - Buckets / RLS policies (manual or SQL migration)
#   - Auth providers list (mostly dashboard-only)
#
# Treat this file as a thin layer that pins the few things the
# provider does support; everything else stays in supabase/ at the
# repo root and is deployed via CI.
# ──────────────────────────────────────────────────────────────────────

resource "supabase_settings" "project" {
  project_ref = var.supabase_project_ref

  database = jsonencode({
    statement_timeout = var.statement_timeout
  })

  api = jsonencode({
    db_schema            = "public,storage,graphql_public"
    db_extra_search_path = "public,extensions"
    max_rows             = var.max_rows
  })

  auth = jsonencode({
    site_url = var.site_url
  })

  storage = jsonencode({
    fileSizeLimit = 52428800 # 50 MB — matches dashboard default for prod buckets
    features = {
      imageTransformation = { enabled = true }
      s3Protocol          = { enabled = false }
    }
  })
}

# Read-only data source: use this to pull the project's API keys for
# downstream wiring instead of copying values around manually.
data "supabase_apikeys" "project" {
  project_ref = var.supabase_project_ref
}
