# PagerDuty as code (optional)

PagerDuty has a community-supported [Terraform provider][1]
(`pagerduty/pagerduty`). Using it is **optional** — the team can manage
schedules and escalation policies in the PagerDuty UI and we'd lose
nothing operationally — but committing them as code gives:

- Audit trail of rotation changes via git blame.
- One-command provisioning when bringing on a new team or environment.
- Escalation-policy diffs visible in PR review.

[1]: https://registry.terraform.io/providers/PagerDuty/pagerduty/latest/docs

## Skeleton (`main.tf`)

If/when there's appetite for this, drop the following at
`iac/pagerduty/main.tf`. This file is intentionally NOT auto-applied;
treat it as a starting point.

```hcl
terraform {
  required_providers {
    pagerduty = {
      source  = "PagerDuty/pagerduty"
      version = "~> 3.0"
    }
  }
  backend "s3" {} # or terraform-cloud, or local — your call
}

variable "pagerduty_token" {
  type        = string
  sensitive   = true
  description = "PagerDuty API token from User → My Profile → User Settings → API Access"
}

provider "pagerduty" {
  token = var.pagerduty_token
}

# ─── Team ──────────────────────────────────────────────────────────────────
resource "pagerduty_team" "engineering" {
  name        = "MotionMax Engineering"
  description = "Owns the worker, edge functions, frontend, and infra."
}

# ─── Users (placeholder — fill in manually or import existing) ─────────────
# Run `terraform import pagerduty_user.alice <pd_user_id>` instead of declaring
# emails here, so PII isn't checked into git.
#
# data "pagerduty_user" "alice"   { email = "[REDACTED]" }
# data "pagerduty_user" "bob"     { email = "[REDACTED]" }
# data "pagerduty_user" "founder" { email = "[REDACTED]" }

# ─── Schedules ─────────────────────────────────────────────────────────────
resource "pagerduty_schedule" "primary" {
  name      = "motionmax-primary"
  time_zone = "Etc/UTC"

  layer {
    name                         = "weekly-rotation"
    start                        = "2026-01-05T09:00:00+00:00"  # next Monday at 09:00 UTC
    rotation_virtual_start       = "2026-01-05T09:00:00+00:00"
    rotation_turn_length_seconds = 604800  # 7 days

    # Order of users determines initial rotation. Use data.pagerduty_user refs above.
    # users = [
    #   data.pagerduty_user.alice.id,
    #   data.pagerduty_user.bob.id,
    # ]
    users = []
  }
}

resource "pagerduty_schedule" "secondary" {
  name      = "motionmax-secondary"
  time_zone = "Etc/UTC"

  layer {
    name                         = "weekly-rotation-offset"
    start                        = "2026-01-12T09:00:00+00:00"  # one week after primary
    rotation_virtual_start       = "2026-01-12T09:00:00+00:00"
    rotation_turn_length_seconds = 604800
    users                        = []
  }
}

# ─── Escalation policy ─────────────────────────────────────────────────────
resource "pagerduty_escalation_policy" "default" {
  name      = "motionmax-default"
  num_loops = 1
  teams     = [pagerduty_team.engineering.id]

  rule {
    escalation_delay_in_minutes = 5
    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.primary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 5
    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.primary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 15
    target {
      type = "schedule_reference"
      id   = pagerduty_schedule.secondary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 30
    # target { type = "user_reference"; id = data.pagerduty_user.founder.id }
  }
}

# ─── Services ──────────────────────────────────────────────────────────────
resource "pagerduty_service" "oncall" {
  name                    = "motionmax-oncall"
  auto_resolve_timeout    = 86400   # 24h
  acknowledgement_timeout = 300     # 5 min
  escalation_policy       = pagerduty_escalation_policy.default.id

  alert_creation = "create_alerts_and_incidents"

  incident_urgency_rule {
    type    = "constant"
    urgency = "high"
  }
}

resource "pagerduty_service" "billing_oncall" {
  name                    = "motionmax-billing-oncall"
  auto_resolve_timeout    = 86400
  acknowledgement_timeout = 300
  escalation_policy       = pagerduty_escalation_policy.default.id
  alert_creation          = "create_alerts_and_incidents"
}

# ─── Sentry integration (creates the webhook URL Sentry will POST to) ──────
resource "pagerduty_service_integration" "sentry" {
  name    = "Sentry"
  service = pagerduty_service.oncall.id
  vendor  = data.pagerduty_vendor.sentry.id
}

data "pagerduty_vendor" "sentry" {
  name = "Sentry"
}

# ─── Outputs ───────────────────────────────────────────────────────────────
output "sentry_integration_url" {
  value     = pagerduty_service_integration.sentry.integration_url
  sensitive = true
}
```

## Apply

```bash
cd iac/pagerduty
terraform init
terraform plan
terraform apply
# Capture the integration URL into the Sentry → PagerDuty config.
```

## Why this is optional

PagerDuty's UI is ergonomic and changes are rare (typically only when team
membership changes). The cost of Terraform-managing it is non-trivial:
- The PagerDuty Terraform state contains user IDs which are PII-adjacent.
- Drift between UI clicks and TF state requires `terraform import` rituals.
- A misapplied plan can wipe an active rotation.

For a 1–3 engineer team, **the UI is fine**. Revisit when team size > 5.
