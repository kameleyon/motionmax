# ──────────────────────────────────────────────────────────────────────
# DNS records for motionmax.io
#
# Cloudflare doesn't allow a true CNAME at the apex, so we use CNAME
# flattening (proxied = true on a CNAME at "@") which Cloudflare
# resolves to A/AAAA records at edge.
#
# All three records point at Vercel via the shared cname.vercel-dns.com
# alias. If we ever migrate to a different host, change
# var.vercel_cname_target in terraform.tfvars and re-apply.
# ──────────────────────────────────────────────────────────────────────

resource "cloudflare_dns_record" "apex" {
  zone_id = var.cloudflare_zone_id
  name    = var.apex_domain
  type    = "CNAME"
  content = var.vercel_cname_target
  ttl     = 1 # 1 = automatic; required when proxied = true
  proxied = true
  comment = "motionmax.io apex → Vercel (CNAME flattening)"
}

resource "cloudflare_dns_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = "www.${var.apex_domain}"
  type    = "CNAME"
  content = var.vercel_cname_target
  ttl     = 1
  proxied = true
  comment = "www.motionmax.io → Vercel"
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = "app.${var.apex_domain}"
  type    = "CNAME"
  content = var.vercel_cname_target
  ttl     = 1
  proxied = true
  comment = "app.motionmax.io → Vercel (authenticated app shell)"
}

# Audit C-9-4 (2026-05-10) — public status page hosted by BetterStack.
# Provisioning order:
#   1. Run scripts/setup-betterstack-monitors.mjs (or terraform apply
#      against iac/betterstack/) — that creates the status page and
#      prints the BetterStack subdomain to use as the CNAME target.
#   2. Set var.betterstack_status_target to that subdomain (something
#      like motionmax.betteruptime.com) in terraform.tfvars and apply.
#   3. BetterStack auto-issues + renews the TLS cert for the custom
#      domain once it can resolve the CNAME.
# proxied = false because BetterStack requires the request to reach
# their edge directly so they can serve the status page TLS cert —
# putting Cloudflare's proxy in front breaks SSL and SNI routing.
resource "cloudflare_dns_record" "status" {
  zone_id = var.cloudflare_zone_id
  name    = "status.${var.apex_domain}"
  type    = "CNAME"
  content = var.betterstack_status_target
  ttl     = 300
  proxied = false
  comment = "status.motionmax.io → BetterStack status page (audit C-9-4)"
}

# TODO (B-NEW-17 / Part D): once the staging Vercel project exists,
# add a `staging.motionmax.io` CNAME pointing at its preview alias.
# Likely shape:
#
#   resource "cloudflare_dns_record" "staging" {
#     zone_id = var.cloudflare_zone_id
#     name    = "staging.${var.apex_domain}"
#     type    = "CNAME"
#     content = "<staging-alias>.vercel.app"
#     ttl     = 1
#     proxied = true
#   }
