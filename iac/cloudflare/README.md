# iac/cloudflare

Cloudflare-managed pieces of the MotionMax production stack:

- **DNS records** for `motionmax.io`, `app.motionmax.io`, `www.motionmax.io`,
  all CNAME-flattened to Vercel.
- **Managed WAF ruleset** deployed onto the zone's
  `http_request_firewall_managed` phase.
- **Custom WAF rules** (high threat-score challenge, non-browser /admin
  challenge).

## Prereqs

- Terraform `>= 1.6`
- Cloudflare API token with **Zone:DNS:Edit** + **Zone:WAF:Edit** for
  the `motionmax.io` zone.
- The zone ID from the Cloudflare dashboard.

## Run

```bash
cp terraform.tfvars.example terraform.tfvars
# fill in cloudflare_zone_id

export TF_VAR_cloudflare_api_token=<your-token>

terraform init
terraform plan
terraform apply
```

## Files

| File                       | Purpose                                          |
| -------------------------- | ------------------------------------------------ |
| `versions.tf`              | Terraform + provider version pins (`cloudflare ~> 5`) |
| `provider.tf`              | Provider config — reads `var.cloudflare_api_token` |
| `variables.tf`             | All inputs (zone id, token, CNAME target, apex)  |
| `dns.tf`                   | Apex / `www` / `app` CNAME records               |
| `waf.tf`                   | Managed-WAF deployment + small custom ruleset    |
| `outputs.tf`               | Resource IDs for cross-module reference          |
| `terraform.tfvars.example` | Template for the gitignored `terraform.tfvars`   |

## What's not here

- The staging.motionmax.io record (Part D follow-up — see TODO in
  `dns.tf`).
- Page Rules / Workers / Cache Rules — currently no production use.
  Add as new `.tf` files when needed; do not bundle into existing
  resources.
