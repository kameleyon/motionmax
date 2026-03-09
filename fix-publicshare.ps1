$f = 'src\pages\PublicShare.tsx'
$c = [System.IO.File]::ReadAllText($f)

# 1. Add named constant after the first import block (find a stable anchor)
if ($c -notmatch 'DEFAULT_SCENE_DURATION_S') {
  $c = $c.Replace(
    'export default function PublicShare',
    "/** Fallback duration (seconds) when a scene has no explicit duration from backend */`nconst DEFAULT_SCENE_DURATION_S = 3;`n`nexport default function PublicShare"
  )
}

# 2. Replace all || 3 scene duration fallbacks with the constant
$c = $c.Replace('(scene.duration || 3)', '(scene.duration || DEFAULT_SCENE_DURATION_S)')
$c = $c.Replace('(s.duration || 3)', '(s.duration || DEFAULT_SCENE_DURATION_S)')
$c = $c.Replace('currentScene.duration || 3', 'currentScene.duration || DEFAULT_SCENE_DURATION_S')
$c = $c.Replace('scenes[i].duration || 3', 'scenes[i].duration || DEFAULT_SCENE_DURATION_S')

# 3. Add document.fullscreenEnabled check before requesting fullscreen
$c = $c.Replace(
  'if (container?.requestFullscreen) container.requestFullscreen();',
  'if (document.fullscreenEnabled && container?.requestFullscreen) container.requestFullscreen();'
)

[System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f"
