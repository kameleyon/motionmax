$f = 'src\pages\Pricing.tsx'
$c = [System.IO.File]::ReadAllText($f)

# Insert helper function before the export default
$helperFn = @"

function getCheckoutErrorMessage(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("rate") || msg.includes("too many"))
    return "Too many attempts. Please wait a moment before trying again.";
  if (msg.includes("already") || msg.includes("active sub") || msg.includes("existing"))
    return "You may already have an active subscription. Visit your billing portal to manage it.";
  if (msg.includes("network") || msg.includes("failed to fetch") || msg.includes("connection"))
    return "Connection error. Check your internet connection and try again.";
  return "Unable to start checkout. Please try again or contact support@motionmax.io.";
}

"@

$anchor = "export default function Pricing()"
$c = $c.Replace($anchor, $helperFn + $anchor)

# Replace generic error message in both handleSubscribe and handleBuyCredits
$c = $c.Replace(
  'error instanceof Error ? error.message : "Failed to start checkout"',
  'getCheckoutErrorMessage(error)'
)

[System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f"
