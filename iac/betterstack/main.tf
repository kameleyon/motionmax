###############################################################################
# BetterStack monitors + status page for MotionMax.
#
# Provider docs: https://registry.terraform.io/providers/BetterStackHQ/better-uptime/latest
# (the registry name is "better-uptime" — historical, BetterStack rebranded).
#
# Apply:
#   terraform init
#   terraform plan -var "betterstack_api_token=<token>"
#   terraform apply
#
# Manual fallback: see ../../docs/observability-setup.md.
###############################################################################

terraform {
  required_version = ">= 1.5"
  required_providers {
    betteruptime = {
      source  = "BetterStackHQ/better-uptime"
      version = "~> 0.13"
    }
  }
}

variable "betterstack_api_token" {
  type        = string
  sensitive   = true
  description = "BetterStack Uptime API token (Settings → API Tokens)."
}

variable "oncall_policy_id" {
  type        = string
  description = "BetterStack On-Call escalation-policy ID, OR PagerDuty integration ID. Empty = no auto-page."
  default     = ""
}

provider "betteruptime" {
  api_token = var.betterstack_api_token
}

# ─── HTTP monitors ────────────────────────────────────────────────────────────

resource "betteruptime_monitor" "frontend_health" {
  monitor_type   = "expected_status_code"
  url            = "https://app.motionmax.io/health"
  pronounceable_name = "MotionMax Frontend Health"
  check_frequency    = 60       # seconds
  request_timeout    = 10
  recovery_period    = 0
  confirmation_period = 120     # require 2 consecutive failures
  regions            = ["us", "eu"]
  expected_status_codes = [200]
  ssl_expiration     = 14
  domain_expiration  = 30
  policy_id          = var.oncall_policy_id != "" ? var.oncall_policy_id : null

  email          = true
  push           = true
  sms            = false        # SMS goes via PagerDuty escalation, not BetterStack
  call           = false
}

resource "betteruptime_monitor" "worker_health" {
  monitor_type   = "expected_status_code"
  url            = "https://api.motionmax.io/health"
  pronounceable_name = "MotionMax Worker Health"
  check_frequency    = 60
  request_timeout    = 15
  recovery_period    = 0
  confirmation_period = 120
  regions            = ["us", "eu"]
  expected_status_codes = [200]
  ssl_expiration     = 14
  policy_id          = var.oncall_policy_id != "" ? var.oncall_policy_id : null
}

resource "betteruptime_monitor" "worker_ready" {
  # /ready returns 503 during graceful shutdown so we alert before /health flips.
  monitor_type   = "expected_status_code"
  url            = "https://api.motionmax.io/ready"
  pronounceable_name = "MotionMax Worker Ready"
  check_frequency    = 60
  request_timeout    = 15
  recovery_period    = 0
  confirmation_period = 120
  regions            = ["us", "eu"]
  expected_status_codes = [200]
  ssl_expiration     = 14
  policy_id          = var.oncall_policy_id != "" ? var.oncall_policy_id : null
}

resource "betteruptime_monitor" "supabase_health" {
  # Supabase REST endpoint we depend on. They publish a status page but we
  # also probe directly so we can correlate latency spikes against our own
  # error rate.
  monitor_type   = "expected_status_code"
  url            = "https://ayjbvcikuwknqdrpsdmj.supabase.co/health/v1"
  pronounceable_name = "Supabase Project Health"
  check_frequency    = 120
  request_timeout    = 10
  recovery_period    = 0
  confirmation_period = 180
  regions            = ["us", "eu"]
  expected_status_codes = [200]
  ssl_expiration     = 14
  policy_id          = var.oncall_policy_id != "" ? var.oncall_policy_id : null
}

# ─── Status page ──────────────────────────────────────────────────────────────

resource "betteruptime_status_page" "public" {
  company_name = "MotionMax"
  company_url  = "https://app.motionmax.io"
  contact_url  = "https://app.motionmax.io/support"
  subdomain    = "motionmax"          # → motionmax.betteruptime.com
  custom_domain = "status.motionmax.io"
  timezone     = "Etc/UTC"
  history      = 90                    # days of incident history to show
  layout       = "vertical"
  theme        = "dark"
  hide_from_search_engines = false
}

resource "betteruptime_status_page_resource" "frontend" {
  status_page_id = betteruptime_status_page.public.id
  resource_id    = betteruptime_monitor.frontend_health.id
  resource_type  = "Monitor"
  public_name    = "App (motionmax.io)"
  position       = 0
}

resource "betteruptime_status_page_resource" "worker" {
  status_page_id = betteruptime_status_page.public.id
  resource_id    = betteruptime_monitor.worker_health.id
  resource_type  = "Monitor"
  public_name    = "Render API & Worker"
  position       = 1
}

resource "betteruptime_status_page_resource" "supabase" {
  status_page_id = betteruptime_status_page.public.id
  resource_id    = betteruptime_monitor.supabase_health.id
  resource_type  = "Monitor"
  public_name    = "Database & Auth"
  position       = 2
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "status_page_url" {
  value       = "https://status.motionmax.io"
  description = "Public status page (after DNS for status.motionmax.io is pointed at BetterStack)."
}

output "monitor_ids" {
  value = {
    frontend_health = betteruptime_monitor.frontend_health.id
    worker_health   = betteruptime_monitor.worker_health.id
    worker_ready    = betteruptime_monitor.worker_ready.id
    supabase_health = betteruptime_monitor.supabase_health.id
  }
}
