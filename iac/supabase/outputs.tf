output "project_ref" {
  description = "Supabase project ref (echoes the input — useful for chaining to other modules)."
  value       = var.supabase_project_ref
}

output "anon_key" {
  description = "Project anon (publishable) key — pull-once via the management API."
  value       = data.supabase_apikeys.project.anon_key
  sensitive   = true
}

# service_role is intentionally exposed as an output so iac/vercel/ can
# read it; if you don't trust the state backend, comment this out and
# wire the value in by hand.
output "service_role_key" {
  description = "Project service_role key. Sensitive."
  value       = data.supabase_apikeys.project.service_role_key
  sensitive   = true
}
