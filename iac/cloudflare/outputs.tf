output "apex_record_id" {
  description = "Resource ID of the apex CNAME record."
  value       = cloudflare_dns_record.apex.id
}

output "managed_waf_ruleset_id" {
  description = "Resource ID of the Managed-WAF deployment ruleset."
  value       = cloudflare_ruleset.managed_waf.id
}

output "custom_waf_ruleset_id" {
  description = "Resource ID of the custom WAF ruleset."
  value       = cloudflare_ruleset.waf_custom.id
}
