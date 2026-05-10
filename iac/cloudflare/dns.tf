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
