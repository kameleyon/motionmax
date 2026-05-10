# Cloudflare provider — credentials come from CI secrets via TF_VAR_*.
# Do NOT hard-code a token here.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
