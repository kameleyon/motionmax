## --- 1. Remove blocking @import from index.css ---
$f1 = 'src\index.css'
$c1 = [System.IO.File]::ReadAllText($f1)
$c1 = $c1.Replace(
  "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Montserrat:wght@400;500;600;700&display=swap');" + "`n",
  ""
)
[System.IO.File]::WriteAllText($f1, $c1, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f1"

## --- 2. Add async font loading to index.html (before </head>) ---
$f2 = 'index.html'
$c2 = [System.IO.File]::ReadAllText($f2)
$fontTag = @"
    <!-- Google Fonts loaded asynchronously to avoid render-blocking -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Montserrat:wght@400;500;600;700&display=swap">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Montserrat:wght@400;500;600;700&display=swap" media="print" onload="this.media='all'">
    <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Montserrat:wght@400;500;600;700&display=swap"></noscript>
  </head>
"@
$c2 = $c2.Replace("  </head>", $fontTag)
[System.IO.File]::WriteAllText($f2, $c2, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f2"

## --- 3. Change Workbox from NetworkFirst to NetworkOnly for Supabase ---
$f3 = 'vite.config.ts'
$c3 = [System.IO.File]::ReadAllText($f3)
$c3 = $c3.Replace(
  '            handler: "NetworkFirst",' + "`n            options: { cacheName: `"supabase-api`", expiration: { maxEntries: 50, maxAgeSeconds: 300 } },",
  '            handler: "NetworkOnly",'
)
[System.IO.File]::WriteAllText($f3, $c3, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f3"

## --- 4. Remove node-fetch imports from all 5 worker files ---
$workerFiles = @(
  'worker\src\handlers\exportVideo.ts',
  'worker\src\services\elevenlabs.ts',
  'worker\src\handlers\generateVideo.ts',
  'worker\src\services\hypereal.ts',
  'worker\src\services\openrouter.ts'
)
foreach ($wf in $workerFiles) {
  $wc = [System.IO.File]::ReadAllText($wf)
  $wc = $wc.Replace('import fetch from "node-fetch";' + "`n", "")
  $wc = $wc.Replace('import fetch from "node-fetch";', "")
  [System.IO.File]::WriteAllText($wf, $wc, [System.Text.Encoding]::UTF8)
  Write-Host "Done: $wf"
}

## --- 5. Remove node-fetch from worker/package.json ---
$pj = 'worker\package.json'
$pc = [System.IO.File]::ReadAllText($pj)
$pc = $pc.Replace('    "node-fetch": "^3.3.2",' + "`n", "")
$pc = $pc.Replace(',' + "`n    `"node-fetch`": `"^3.3.2`"", "")
[System.IO.File]::WriteAllText($pj, $pc, [System.Text.Encoding]::UTF8)
Write-Host "Done: $pj"
