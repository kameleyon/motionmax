# BetterStack monitors as code

Terraform-managed BetterStack Uptime monitors and the public status page.
The actual config lives in `main.tf`; this README is the human runbook.

## What gets provisioned

| Resource                       | Purpose                                                             |
|--------------------------------|---------------------------------------------------------------------|
| `betteruptime_monitor.frontend_health`  | HTTP probe of `https://app.motionmax.io/health` every 60s. |
| `betteruptime_monitor.worker_health`    | HTTP probe of `https://api.motionmax.io/health` every 60s. |
| `betteruptime_monitor.worker_ready`     | HTTP probe of `https://api.motionmax.io/ready` (alerts before `/health` flips during graceful shutdown). |
| `betteruptime_monitor.supabase_health`  | HTTP probe of `https://ayjbvcikuwknqdrpsdmj.supabase.co/health/v1` every 120s. |
| `betteruptime_status_page.public`       | `status.motionmax.io` aggregating the three components.    |

## Required env / vars

| Variable                  | Used by | Where to get                                                         |
|---------------------------|---------|----------------------------------------------------------------------|
| `BETTERSTACK_API_TOKEN`   | TF      | BetterStack → Settings → API Tokens.                                 |
| `BETTERSTACK_TEAM_ID`     | TF      | BetterStack → Team → ID. (Provider auto-resolves if account has one team.) |
| `oncall_policy_id`        | TF var  | BetterStack On-Call → Escalation Policies → ID. Optional.            |
| DNS CNAME for `status.motionmax.io` | manual | Point at `statuspage.betteruptime.com.` after first apply.   |

## Apply

```bash
cd iac/betterstack
terraform init
terraform plan \
  -var "betterstack_api_token=$BETTERSTACK_API_TOKEN" \
  -var "oncall_policy_id=$BETTERSTACK_ONCALL_POLICY_ID"
terraform apply
```

## Manual fallback (UI)

If you'd rather click rather than apply:

1. <https://uptime.betterstack.com> → **Monitors → New monitor** for each
   row in the table above. Settings:
   - HTTP(s), 60s frequency (120s for Supabase), regions `us` + `eu`,
     2-failure confirmation, 14-day SSL warning.
2. **Status pages → New status page**, subdomain `motionmax`, custom
   domain `status.motionmax.io`, dark theme, vertical layout.
3. Add the three monitors as components.
4. Under **Integrations**, point alerts at PagerDuty service
   `motionmax-oncall` (see `docs/on-call-rotation.md`).

The TF state and the UI state will drift if you do both — pick one mode of
ownership and stick with it. The recommendation is **TF for monitors,
UI for the status page incident timeline** (incidents are too ephemeral
to be worth versioning).

## Verifying after apply

```bash
# Force a synthetic outage (dev-only — don't run in prod):
curl -fsS https://app.motionmax.io/health           # should be 200
curl -fsS https://api.motionmax.io/health           # should be 200
curl -fsS https://api.motionmax.io/ready            # should be 200
curl -fsS https://ayjbvcikuwknqdrpsdmj.supabase.co/health/v1 # should be 200
```

In BetterStack, each monitor should show a green check within 90 s.

## Removal

```bash
terraform destroy
```

Note: the BetterStack status page subdomain (`motionmax.betteruptime.com`)
is *reserved* for 30 days after destroy. Plan accordingly.
