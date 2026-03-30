/**
 * Ken Burns effect presets and FFmpeg zoompan filter builder.
 *
 * Applies subtle pan + zoom motion to still images during video export,
 * transforming static slideshow scenes into dynamic, cinema-grade content.
 *
 * Each preset generates a unique zoompan expression with duration-adaptive
 * speeds — longer scenes zoom/pan slower to maintain natural feel.
 *
 * Usage:
 *   const preset = getKenBurnsPreset(sceneIndex);
 *   const filter = buildZoompanFilter(preset, duration, 24, 1920, 1080);
 *   // → "zoompan=z='...' :x='...' :y='...' :d=192:s=1920x1080:fps=24"
 */

// ── Types ────────────────────────────────────────────────────────────

export interface KenBurnsPreset {
  /** Human-readable name for logging */
  name: string;
  /** Direction of primary motion */
  direction: "zoom-in" | "zoom-out" | "pan-right" | "pan-left" | "pan-down" | "pan-up" | "diagonal";
  /** Base zoom factor change over 10 seconds (scaled by actual duration) */
  baseZoomDelta: number;
  /** Starting zoom level (1.0 = full image visible) */
  startZoom: number;
  /** Build the z (zoom) expression given computed speed */
  buildZ: (zoomSpeed: string, startZoom: string) => string;
  /** Build the x (horizontal pan) expression given computed speed */
  buildX: (panSpeed: string) => string;
  /** Build the y (vertical pan) expression given computed speed */
  buildY: (panSpeed: string) => string;
}

// ── Presets ───────────────────────────────────────────────────────────

/**
 * 8 Ken Burns presets providing varied camera movements.
 *
 * Each preset is designed to:
 *   - Look natural at any duration (5-30s)
 *   - Never zoom beyond 1.35x (avoids quality loss on AI images)
 *   - Pan no more than 20% of image width (avoids revealing edges)
 *   - Use smooth, slow movements (no jarring jumps)
 */
const PRESETS: KenBurnsPreset[] = [
  {
    // Gentle zoom in, centered — most common cinematic effect
    name: "zoom-in-center",
    direction: "zoom-in",
    baseZoomDelta: 0.20,
    startZoom: 1.0,
    buildZ: (speed, start) => `if(eq(on,1),${start},min(zoom+${speed},1.35))`,
    buildX: () => "iw/2-(iw/zoom/2)",
    buildY: () => "ih/2-(ih/zoom/2)",
  },
  {
    // Zoom out from tight to full — reveals the scene
    name: "zoom-out-center",
    direction: "zoom-out",
    baseZoomDelta: 0.20,
    startZoom: 1.25,
    buildZ: (speed, start) => `if(eq(on,1),${start},max(zoom-${speed},1.0))`,
    buildX: () => "iw/2-(iw/zoom/2)",
    buildY: () => "ih/2-(ih/zoom/2)",
  },
  {
    // Slow pan left→right with slight zoom
    name: "pan-right-zoom",
    direction: "pan-right",
    baseZoomDelta: 0.10,
    startZoom: 1.15,
    buildZ: (speed, start) => `if(eq(on,1),${start},min(zoom+${speed},1.30))`,
    buildX: (panSpeed) => `if(eq(on,1),0,min(x+${panSpeed},iw-iw/zoom))`,
    buildY: () => "ih/2-(ih/zoom/2)",
  },
  {
    // Slow pan right→left with slight zoom
    name: "pan-left-zoom",
    direction: "pan-left",
    baseZoomDelta: 0.10,
    startZoom: 1.15,
    buildZ: (speed, start) => `if(eq(on,1),${start},min(zoom+${speed},1.30))`,
    buildX: (panSpeed) => `if(eq(on,1),iw/zoom*0.15,max(x-${panSpeed},0))`,
    buildY: () => "ih/2-(ih/zoom/2)",
  },
  {
    // Slow pan up→down with zoom in
    name: "pan-down-zoom",
    direction: "pan-down",
    baseZoomDelta: 0.12,
    startZoom: 1.12,
    buildZ: (speed, start) => `if(eq(on,1),${start},min(zoom+${speed},1.30))`,
    buildX: () => "iw/2-(iw/zoom/2)",
    buildY: (panSpeed) => `if(eq(on,1),0,min(y+${panSpeed},ih-ih/zoom))`,
  },
  {
    // Slow pan down→up with zoom in
    name: "pan-up-zoom",
    direction: "pan-up",
    baseZoomDelta: 0.12,
    startZoom: 1.12,
    buildZ: (speed, start) => `if(eq(on,1),${start},min(zoom+${speed},1.30))`,
    buildX: () => "iw/2-(iw/zoom/2)",
    buildY: (panSpeed) => `if(eq(on,1),ih/zoom*0.12,max(y-${panSpeed},0))`,
  },
  {
    // Diagonal: top-left to bottom-right + zoom in
    name: "diagonal-br-zoom",
    direction: "diagonal",
    baseZoomDelta: 0.15,
    startZoom: 1.10,
    buildZ: (speed, start) => `if(eq(on,1),${start},min(zoom+${speed},1.30))`,
    buildX: (panSpeed) => `if(eq(on,1),0,min(x+${panSpeed},iw-iw/zoom))`,
    buildY: (panSpeed) => `if(eq(on,1),0,min(y+${panSpeed},ih-ih/zoom))`,
  },
  {
    // Zoom out from off-center — dramatic reveal
    name: "zoom-out-offset",
    direction: "zoom-out",
    baseZoomDelta: 0.18,
    startZoom: 1.28,
    buildZ: (speed, start) => `if(eq(on,1),${start},max(zoom-${speed},1.0))`,
    buildX: () => "iw/3-(iw/zoom/2)",
    buildY: () => "ih/3-(ih/zoom/2)",
  },
];

// ── Public API ───────────────────────────────────────────────────────

/**
 * Select a Ken Burns preset for a given scene index.
 *
 * Uses deterministic selection (modulo) so the same scene always gets
 * the same effect — prevents jumps on re-export. Adjacent scenes get
 * different effects for visual variety.
 */
export function getKenBurnsPreset(sceneIndex: number): KenBurnsPreset {
  // Shuffle order for better visual variety between adjacent scenes
  const shuffledIndices = [0, 3, 5, 1, 6, 4, 2, 7];
  const idx = shuffledIndices[sceneIndex % shuffledIndices.length];
  return PRESETS[idx];
}

/**
 * Build the FFmpeg zoompan filter string for a Ken Burns effect.
 *
 * Zoom/pan speeds are automatically scaled to the clip duration so
 * the total motion feels natural regardless of scene length.
 *
 * @param preset     Ken Burns preset to apply
 * @param duration   Scene duration in seconds
 * @param fps        Output frame rate (default 24)
 * @param width      Output width in pixels
 * @param height     Output height in pixels
 * @returns          Complete zoompan filter value (without the "zoompan=" prefix)
 */
export function buildZoompanFilter(
  preset: KenBurnsPreset,
  duration: number,
  fps: number = 24,
  width: number = 1920,
  height: number = 1080
): string {
  const totalFrames = Math.ceil(duration * fps);

  // Calculate duration-adaptive zoom speed
  // Target: baseZoomDelta total change over the full duration
  const zoomSpeed = (preset.baseZoomDelta / totalFrames).toFixed(6);
  const startZoom = preset.startZoom.toFixed(2);

  // Calculate pan speed: move ~15% of image dimension over full duration
  const panFraction = 0.15;
  // Pan speed in zoompan coordinates (relative to image dimensions)
  // We use a fraction of iw/ih per frame, but express it as a pixel value
  // approximated from the target width/height
  const hPanSpeed = ((width * panFraction) / totalFrames).toFixed(4);
  const vPanSpeed = ((height * panFraction) / totalFrames).toFixed(4);

  const z = preset.buildZ(zoomSpeed, startZoom);
  const x = preset.buildX(hPanSpeed);
  const y = preset.buildY(vPanSpeed);

  return `z='${z}':x='${x}':y='${y}':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
}

/**
 * Build the complete FFmpeg -vf filter string for a Ken Burns scene.
 *
 * Combines zoompan with pixel format normalization.
 * Does NOT include -filter_complex — uses simple -vf for single-input.
 */
export function buildKenBurnsVf(
  preset: KenBurnsPreset,
  duration: number,
  fps: number = 24,
  width: number = 1920,
  height: number = 1080
): string {
  const zoompan = buildZoompanFilter(preset, duration, fps, width, height);
  // zoompan already sets output size; add format for consistent pixel format
  return `zoompan=${zoompan},format=yuv420p`;
}

/** Get the target resolution for a format string */
export function getTargetResolution(format: string): { width: number; height: number } {
  switch (format) {
    case "portrait": return { width: 1080, height: 1920 };
    case "square":   return { width: 1080, height: 1080 };
    default:         return { width: 1920, height: 1080 }; // landscape
  }
}

/** Log the selected preset for diagnostics */
export function logPreset(sceneIndex: number, preset: KenBurnsPreset, duration: number): void {
  console.log(
    `[KenBurns] Scene ${sceneIndex}: ${preset.name} (${preset.direction}) — ${duration.toFixed(1)}s`
  );
}
