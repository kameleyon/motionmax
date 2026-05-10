variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zone:DNS edit + WAF). Set via TF_VAR_cloudflare_api_token in CI / shell — never commit."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for motionmax.io. Find under Cloudflare dashboard → motionmax.io → Overview → Zone ID."
  type        = string
}

variable "vercel_cname_target" {
  description = "Vercel-issued CNAME target for the apex/app/www records. Vercel exposes this when you add the domain in the project."
  type        = string
  default     = "cname.vercel-dns.com"
}

variable "apex_domain" {
  description = "Root domain managed in this Cloudflare zone."
  type        = string
  default     = "motionmax.io"
}
