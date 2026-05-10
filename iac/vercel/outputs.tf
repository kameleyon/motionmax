output "project_id" {
  description = "Vercel project ID — used by other modules / CI."
  value       = vercel_project.app.id
}

output "project_name" {
  description = "Vercel project name."
  value       = vercel_project.app.name
}
