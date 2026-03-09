$f = 'src\pages\VoiceLab.tsx'
$c = [System.IO.File]::ReadAllText($f)

# 1. Pause audio visualization when browser tab is not visible
#    Replace the animation loop that always runs with one that checks document.visibilityState
$oldLoop = '      const updateLevels = () => {' + "`n        if (analyzerRef.current) {`n          const dataArray = new Uint8Array(analyzerRef.current.frequencyBinCount);`n          analyzerRef.current.getByteFrequencyData(dataArray);`n          const levels = Array.from(dataArray.slice(0, 20)).map(v => v / 255);`n          setAudioLevels(levels);`n        }`n        animationFrameRef.current = requestAnimationFrame(updateLevels);`n      };`n      updateLevels();"

$newLoop = '      const updateLevels = () => {' + "`n        // Skip update when tab is hidden to save CPU on background tabs`n        if (document.visibilityState === 'visible' && analyzerRef.current) {`n          const dataArray = new Uint8Array(analyzerRef.current.frequencyBinCount);`n          analyzerRef.current.getByteFrequencyData(dataArray);`n          const levels = Array.from(dataArray.slice(0, 20)).map(v => v / 255);`n          setAudioLevels(levels);`n        }`n        animationFrameRef.current = requestAnimationFrame(updateLevels);`n      };`n      updateLevels();"

$c = $c.Replace($oldLoop, $newLoop)

[System.IO.File]::WriteAllText($f, $c, [System.Text.Encoding]::UTF8)
Write-Host "Done: $f"
