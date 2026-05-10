# ──────────────────────────────────────────────────────────────────────
# Vercel project — describes the existing motionmax-app project.
#
# The project already exists in Vercel; the first `terraform apply`
# should be preceded by an explicit import:
#
#   terraform import vercel_project.app prj_XXXXXXXXXXXX
#
# Otherwise Terraform will try to *create* a duplicate project.
# Document the import step in your runbook before applying.
# ──────────────────────────────────────────────────────────────────────

resource "vercel_project" "app" {
  name      = "motionmax"
  framework = "vite"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = var.production_branch
  }

  # PR previews are enabled by default; documenting the intent.
  # Vercel previews fire on every push to a branch with an open PR
  # against the production branch.

  build_command    = "npm run build"
  output_directory = "dist"
  install_command  = "npm ci && npm ci --prefix marketing"
}
