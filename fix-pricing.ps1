$files = @('src\pages\Landing.tsx', 'src\pages\Pricing.tsx')

foreach ($f in $files) {
  $c = [System.IO.File]::ReadAllText($f)

  # Add yearlyDiscountPercent to config import (Pricing.tsx has CREDIT_PACK_PRICES too)
  $c = $c.Replace(
    'import { PLAN_PRICES, CREDIT_PACK_PRICES } from "@/config/products";',
    'import { PLAN_PRICES, CREDIT_PACK_PRICES, yearlyDiscountPercent } from "@/config/products";'
  )
  $c = $c.Replace(
    'import { PLAN_PRICES } from "@/config/products";',
    'import { PLAN_PRICES, yearlyDiscountPercent } from "@/config/products";'
  )

  # Replace the plain text "Save 20%" with a JSX expression using the computed value
  # Works for both Pricing.tsx (>Save 20%<) and Landing.tsx (indented text node)
  $c = $c.Replace('Save 20%', '{`Save ${yearlyDiscountPercent()}%`}')

  [System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
  Write-Host "Updated: $f"
}
