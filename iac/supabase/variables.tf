variable "supabase_project_ref" {
  description = "Supabase project reference (e.g. ayjbvcikuwknqdrpsdmj for prod). Lives as a variable so staging can be applied with a different ref without code changes."
  type        = string
}

variable "site_url" {
  description = "Public URL of the application — used by Supabase Auth for redirect/email-link generation."
  type        = string
  default     = "https://motionmax.io"
}

variable "max_rows" {
  description = "PostgREST max_rows cap. Keeps unbounded queries in check."
  type        = number
  default     = 1000
}

variable "statement_timeout" {
  description = "Postgres statement_timeout for the authenticator role."
  type        = string
  default     = "10s"
}
