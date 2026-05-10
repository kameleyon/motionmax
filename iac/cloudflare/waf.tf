# ──────────────────────────────────────────────────────────────────────
# WAF — Cloudflare Managed Ruleset deployment + minimal custom rules.
#
# Cloudflare's "Managed Ruleset" (the OWASP-style protection set) is
# enabled by deploying it into the http_request_firewall_managed phase
# for the zone. Without this resource the managed rules sit idle.
#
# We additionally attach a small custom ruleset for app-specific
# patterns (block scripted access to /admin from unknown IPs, challenge
# very high threat-score requests). Keep the custom rule list small:
# every rule should have a stated reason.
# ──────────────────────────────────────────────────────────────────────

# Managed Ruleset: deploy Cloudflare's official ruleset onto the zone.
resource "cloudflare_ruleset" "managed_waf" {
  zone_id     = var.cloudflare_zone_id
  name        = "MotionMax — Managed WAF deployment"
  description = "Deploys Cloudflare Managed Ruleset on the http_request_firewall_managed phase."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [{
    action = "execute"
    action_parameters = {
      # The static UUID below is the Cloudflare Managed Ruleset ID (publicly documented:
      # https://developers.cloudflare.com/waf/managed-rules/reference/cloudflare-managed-ruleset/).
      # If Cloudflare ever rotates this you'll see a 404 on apply — update here.
      id = "efb7b8c949ac4650a09736fc376e9aee"
    }
    expression  = "true"
    description = "Execute the Cloudflare Managed Ruleset for the entire zone"
    enabled     = true
  }]
}

# Custom rules layered on top of the managed set.
resource "cloudflare_ruleset" "waf_custom" {
  zone_id     = var.cloudflare_zone_id
  name        = "MotionMax — Custom WAF Rules"
  description = "Application-specific WAF rules for motionmax.io"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      action      = "managed_challenge"
      expression  = "(cf.threat_score > 30)"
      description = "Challenge requests with elevated Cloudflare threat score"
      enabled     = true
    },
    {
      # /admin is gated by Supabase auth, but bots still probe it. Force
      # a managed challenge before the request even hits Vercel.
      action      = "managed_challenge"
      expression  = "(http.request.uri.path matches \"^/admin\") and (not http.user_agent contains \"Mozilla\")"
      description = "Challenge non-browser hits to /admin*"
      enabled     = true
    }
  ]
}
