$utf8 = [System.Text.Encoding]::UTF8

## --- 1. index.css: fix --destructive to proper red (standard shadcn-ui values) ---
$f1 = 'src\index.css'
$c1 = [System.IO.File]::ReadAllText($f1, $utf8)
# Light mode (line ~46): update comment + value
$c1 = $c1.Replace(
  '    /* Using muted amber for warnings instead of red */' + "`n    --destructive: 170 55% 54%;",
  '    --destructive: 0 84% 60%;'
)
# Dark mode (line ~96): same teal value — change to dark-mode red
$c1 = $c1.Replace('    --destructive: 170 55% 54%;', '    --destructive: 0 63% 31%;')
[System.IO.File]::WriteAllText($f1, $c1, $utf8)
Write-Host "Fixed: $f1"

## --- 2. tailwind.config.ts: remove dead content paths ---
$f2 = 'tailwind.config.ts'
$c2 = [System.IO.File]::ReadAllText($f2, $utf8)
$c2 = $c2.Replace(
  'content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"]',
  'content: ["./src/**/*.{ts,tsx}"]'
)
[System.IO.File]::WriteAllText($f2, $c2, $utf8)
Write-Host "Fixed: $f2"

## --- 3. index.html: remove Montserrat from Google Fonts URLs ---
$f3 = 'index.html'
$c3 = [System.IO.File]::ReadAllText($f3, $utf8)
$montserrat = '&family=Montserrat:wght@400;500;600;700'
$c3 = $c3.Replace($montserrat, '')
[System.IO.File]::WriteAllText($f3, $c3, $utf8)
Write-Host "Fixed: $f3"
