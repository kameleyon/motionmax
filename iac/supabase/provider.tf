# Supabase provider — reads SUPABASE_ACCESS_TOKEN from the environment.
# This is intentional: Supabase access tokens auth against the management
# API and should never be committed.
#
# Generate one at: Supabase dashboard → Account → Access Tokens.
provider "supabase" {}
