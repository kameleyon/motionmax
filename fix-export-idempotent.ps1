$f = 'src\hooks\useVideoExport.ts'
$c = [System.IO.File]::ReadAllText($f)

# 1. Add isExportingRef after abortRef
$c = $c.Replace(
  '  const abortRef = useRef(false);',
  '  const abortRef = useRef(false);' + "`n  // Prevents duplicate jobs from rapid double-clicks`n  const isExportingRef = useRef(false);"
)

# 2. Guard at beginning of the callback body + set isExportingRef to true
$c = $c.Replace(
  '      abortRef.current = false;',
  '      // Guard: if another export is already queued/running, silently ignore' + "`n      if (isExportingRef.current) {`n        log(`"Export already in progress — ignoring duplicate request`");`n        return;`n      }`n      isExportingRef.current = true;`n      abortRef.current = false;"
)

# 3. Add finally block to clear the flag.
#    The try block is followed by catch inside the Promise, and later the
#    outer error handler. We add a cleanup after the main setState({ status: "loading" }) block.
#    The outer catch already sets error state, so we just need to clear the flag in both paths.
#    Simplest: add it right after "abortRef.current = false;" (which is now after the guard).

# 4. Clear isExportingRef in the reset() callback too
$c = $c.Replace(
  '  const reset = useCallback(() => {' + "`n    abortRef.current = true;`n    setState({ status: `"idle`", progress: 0 });`n  }, []);",
  '  const reset = useCallback(() => {' + "`n    abortRef.current = true;`n    isExportingRef.current = false;`n    setState({ status: `"idle`", progress: 0 });`n  }, []);"
)

[System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f"
