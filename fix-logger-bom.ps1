$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$content = [System.IO.File]::ReadAllText('worker\src\lib\logger.ts') -replace '^\xEF\xBB\xBF', ''
$stripped = $content.TrimStart([char]0xFEFF)
[System.IO.File]::WriteAllText("$PWD\worker\src\lib\logger.ts", $stripped, $utf8NoBom)
Write-Host "BOM removed from logger.ts"
