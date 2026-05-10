variable "vercel_api_token" {
  description = "Vercel API token. Set via TF_VAR_vercel_api_token in CI / shell."
  type        = string
  sensitive   = true
}

variable "vercel_team_id" {
  description = "Vercel team / org ID for the motionmax org."
  type        = string
}

variable "github_repo" {
  description = "GitHub repo backing the Vercel project (org/repo)."
  type        = string
  default     = "kameleyon/motionmax"
}

variable "production_branch" {
  description = "Git branch that triggers production deploys."
  type        = string
  default     = "main"
}

# ── Supabase wiring (production) ────────────────────────────────────
# These names match the Supabase project that the Vite app talks to.
# Values come from the Supabase dashboard → Project Settings → API.
# We pass them as Terraform variables (sensitive) so they never get
# baked into committed state.

variable "supabase_url_production" {
  description = "Supabase URL for the production environment (https://<ref>.supabase.co)."
  type        = string
  sensitive   = true
}

variable "supabase_publishable_key_production" {
  description = "Supabase publishable / anon key for the production environment."
  type        = string
  sensitive   = true
}

variable "supabase_url_preview" {
  description = "Supabase URL for the staging / preview environment."
  type        = string
  sensitive   = true
}

variable "supabase_publishable_key_preview" {
  description = "Supabase publishable / anon key for the staging / preview environment."
  type        = string
  sensitive   = true
}

# Stripe / Sentry / OpenRouter etc. are deliberately not declared here
# — they remain in the Vercel dashboard until we're ready to migrate
# the full env-var inventory. See README for the migration plan.
