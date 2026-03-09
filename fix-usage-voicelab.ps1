## --- Usage.tsx: replace reimplemented credit cost function ---
$f1 = 'src\pages\Usage.tsx'
$c1 = [System.IO.File]::ReadAllText($f1)

# Replace CREDIT_COSTS import with getCreditsRequired
$c1 = $c1.Replace(
  'import { CREDIT_COSTS } from "@/lib/planLimits";',
  'import { getCreditsRequired } from "@/lib/planLimits";'
)

# Add normalizeProjectType import (after supabase import for clean ordering)
if ($c1 -notmatch 'normalizeProjectType') {
  $c1 = $c1.Replace(
    'import { supabase } from "@/integrations/supabase/client";',
    'import { supabase } from "@/integrations/supabase/client";' + "`nimport { normalizeProjectType } from `"@/lib/projectUtils`";"
  )
}

# Replace the duplicate function body with a delegation to getCreditsRequired
$oldFn = 'function getCreditCostForGeneration(projectType: string | undefined, length: string | undefined): number {' + "`n  if (projectType === `"smartflow`" || projectType === `"smart-flow`") return CREDIT_COSTS.smartflow;`n  if (projectType === `"cinematic`") return CREDIT_COSTS.cinematic;`n  if (length && length in CREDIT_COSTS) return CREDIT_COSTS[length as keyof typeof CREDIT_COSTS];`n  return CREDIT_COSTS.short;`n}"

$newFn = 'function getCreditCostForGeneration(projectType: string | undefined, length: string | undefined): number {' + "`n  try {`n    return getCreditsRequired(`n      normalizeProjectType(projectType) as `"doc2video`" | `"storytelling`" | `"smartflow`" | `"cinematic`",`n      length || `"short`"`n    );`n  } catch {`n    return 1; // fallback for unknown project type or length`n  }`n}"

$c1 = $c1.Replace($oldFn, $newFn)
[System.IO.File]::WriteAllText($f1, $c1, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f1"

## --- VoiceLab.tsx: revoke preview audio blob URL on unmount ---
$f2 = 'src\pages\VoiceLab.tsx'
$c2 = [System.IO.File]::ReadAllText($f2)

$oldCleanup = '  useEffect(() => {' + "`n    return () => {`n      if (timerRef.current) clearInterval(timerRef.current);`n      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);`n    };`n  }, []);"

$newCleanup = '  useEffect(() => {' + "`n    return () => {`n      if (timerRef.current) clearInterval(timerRef.current);`n      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);`n      // Revoke any blob URL held by the audio preview element to free memory`n      if (audioPreviewRef.current) {`n        const src = audioPreviewRef.current.src;`n        audioPreviewRef.current.pause();`n        audioPreviewRef.current = null;`n        if (src?.startsWith('blob:')) URL.revokeObjectURL(src);`n      }`n    };`n  }, []);"

$c2 = $c2.Replace($oldCleanup, $newCleanup)
[System.IO.File]::WriteAllText($f2, $c2, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f2"
