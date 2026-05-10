# Vercel provider — reads the API token from var.vercel_api_token,
# which is supplied via TF_VAR_vercel_api_token in CI / shell.
# (You can also omit api_token entirely and rely on the
# VERCEL_API_TOKEN env var, but being explicit is safer.)
provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}
