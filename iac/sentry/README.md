# Sentry alerts as code

This directory holds the Sentry alert rules used by MotionMax in a
machine-readable form. Importing them is a one-time bootstrap; after that the
file is the source of truth — edit it, re-run the import, do not click in the
Sentry UI.

## Files

- `alert-rules.json` — issue alerts + metric alerts. See the inline `_doc`
  field for severity tiers and the integration-ID placeholders that must be
  replaced before import.

## Required env vars

Both import paths need:

| Variable               | Where to get it                                              |
|------------------------|--------------------------------------------------------------|
| `SENTRY_AUTH_TOKEN`    | Sentry → Settings → Account → API → Auth Tokens. Scopes: `project:write`, `alerts:write`, `org:read`. |
| `SENTRY_ORG`           | The org slug, e.g. `motionmax`.                              |
| `SENTRY_PROJECT`       | Project slug, e.g. `motionmax`.                              |
| `PAGERDUTY_INTEGRATION_ID` | Sentry → Settings → Integrations → PagerDuty → "Configurations" → numeric ID at the end of the URL. |
| `SLACK_INTEGRATION_ID` | Sentry → Settings → Integrations → Slack → numeric ID.       |

> The PagerDuty + Slack integrations must be installed in Sentry first
> (one-time OAuth flow). See `docs/on-call-rotation.md` for the PagerDuty
> setup walkthrough.

## Import — Option A: sentry-cli (preferred for CI)

`sentry-cli` ships with `monitors create-from-file`. For *alert rules*,
sentry-cli currently only supports the **monitors** API; alert rules go
through the HTTP API. We provide a small wrapper:

```bash
# 1. Replace integration-ID placeholders.
sed -e "s/<PAGERDUTY_INTEGRATION_ID>/$PAGERDUTY_INTEGRATION_ID/g" \
    -e "s/<SLACK_INTEGRATION_ID>/$SLACK_INTEGRATION_ID/g" \
    alert-rules.json > /tmp/alert-rules.resolved.json

# 2. Create issue alerts.
jq -c '.issue_alerts[]' /tmp/alert-rules.resolved.json | while read -r rule; do
  curl -fsS -X POST \
    "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/rules/" \
    -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$rule"
  echo
done

# 3. Create metric alerts.
jq -c '.metric_alerts[]' /tmp/alert-rules.resolved.json | while read -r rule; do
  curl -fsS -X POST \
    "https://sentry.io/api/0/organizations/$SENTRY_ORG/alert-rules/" \
    -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$rule"
  echo
done
```

For idempotent updates, fetch existing rules first and PUT instead of POST
when the `name` field matches.

## Import — Option B: terraform-provider-sentry

If you prefer Terraform (recommended once the team is past bootstrap):

```hcl
terraform {
  required_providers {
    sentry = {
      source  = "jianyuan/sentry"
      version = "~> 0.13"
    }
  }
}

provider "sentry" {
  token = var.sentry_auth_token
}

locals {
  rules = jsondecode(file("${path.module}/alert-rules.json"))
}

resource "sentry_issue_alert" "rules" {
  for_each = { for r in local.rules.issue_alerts : r.name => r }
  organization = local.rules.organization_slug
  project      = local.rules.project_slug
  name         = each.value.name
  conditions   = each.value.conditions
  filters      = each.value.filters
  actions      = each.value.actions
  action_match = each.value.actionMatch
  filter_match = each.value.filterMatch
  frequency    = each.value.frequency
  environment  = local.rules.environment
}
```

## Import — Option C: manual fallback (UI)

If neither CI access nor Terraform is available:

1. Open Sentry → Alerts → Create Alert.
2. For each rule in `alert-rules.json`:
   - Pick **Issue Alert** for entries under `issue_alerts`, **Metric Alert**
     for entries under `metric_alerts`.
   - Copy the `name`, `conditions`, `filters`, and `actions` field-by-field.
   - Set environment to `production`.
3. Save. After all rules are created, run the import script in non-creation
   mode to verify that every name exists.

## Verifying the alerts work

For each `severity: page` rule, force a synthetic event:

```bash
sentry-cli send-event \
  --message "synthetic test for <rule_name>" \
  --tag service:worker \
  --tag environment:production \
  --tag synthetic:true
```

Then confirm in PagerDuty that an incident was created and routed to the
on-call schedule.

## Updating rules

1. Edit `alert-rules.json`.
2. Re-run the import script (it should be idempotent — name-keyed).
3. Commit the JSON change with a short message:
   `feat(sentry): tighten worker error threshold from 5/min to 3/min`.
