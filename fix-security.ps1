$utf8 = [System.Text.Encoding]::UTF8

## --- 1. CORS: replace "*" with env-var-backed domain in all edge functions ---
# Set Supabase secret in production: supabase secrets set ALLOWED_ORIGIN=https://motionmax.io
$functions = Get-ChildItem -Path 'supabase\functions' -Recurse -Filter 'index.ts'
foreach ($f in $functions) {
  $c = [System.IO.File]::ReadAllText($f.FullName, $utf8)
  if ($c.Contains('"Access-Control-Allow-Origin": "*"')) {
    $c = $c.Replace(
      '"Access-Control-Allow-Origin": "*"',
      '"Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "https://motionmax.io"'
    )
    [System.IO.File]::WriteAllText($f.FullName, $c, $utf8)
    Write-Host "CORS fixed: $($f.FullName)"
  }
}

## --- 2. CSP: add basic meta tag to index.html (before </head>) ---
$fHtml = 'index.html'
$cHtml = [System.IO.File]::ReadAllText($fHtml, $utf8)
$csp = '    <!-- Basic Content Security Policy: prevents framing (clickjacking), plugin content, and base-tag injection -->' + "`n" +
       '    <meta http-equiv="Content-Security-Policy" content="frame-ancestors ' + "'" + 'none' + "'" + '; object-src ' + "'" + 'none' + "'" + '; base-uri ' + "'" + 'self' + "'" + ';">' + "`n" +
       '  </head>'
$cHtml = $cHtml.Replace('  </head>', $csp)
[System.IO.File]::WriteAllText($fHtml, $cHtml, $utf8)
Write-Host "CSP added: $fHtml"
