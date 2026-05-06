/**
 * composeFinal — single-pass FFmpeg composer for the final exported MP4.
 *
 * Replaces 4–5 sequential ffmpeg passes with ONE invocation that handles:
 *   1. Concat scenes (with optional crossfade transitions)
 *   2. Replace audio with continuous master narration mp3
 *   3. Mix Lyria music + SFX beds (additive, ducked under narration)
 *   4. Burn ASS captions
 *   5. Apply project-wide color grade
 *   6. Optionally overlay brand-mark / watermark text
 *
 * Why this exists: the legacy export pipeline encoded the same 3-min
 * video 4–5 times — once per stage. On a 2-vCPU Render pod with
 * libx264 ultrafast that's ~9× real-time per pass × 5 passes ≈ 27
 * minutes. Single-pass collapses every transformation into one filter
 * graph, encodes once, and ships. Measured ~5–6× speedup on cinematic
 * exports (3 min → ~5 min total instead of 27).
 *
 * Input contract: every clip in `clipPaths` is already a normalised
 * MP4 at the target resolution + framerate (the per-scene encoder
 * still runs first to produce these). composeFinal does NOT scale or
 * re-frame clips — only stitches + composites. Mismatched resolutions
 * will produce visual artefacts (xfade requires identical streams).
 *
 * Audio contract: when `masterAudioUrl` is provided, the per-clip
 * audio tracks are IGNORED — the final track is `master + music + sfx`
 * mixed at the top level. When `masterAudioUrl` is null, we fall back
 * to per-clip audio with the legacy crossfade audio chain (atrim +
 * afade + concat) so smartflow / pre-master-audio rows still work.
 *
 * Caller is expected to:
 *   - encode scenes first (sceneEncoder.processScene)
 *   - download master audio + music + sfx mp3s to local paths
 *   - generate the ASS subtitle file (captionBuilder.generateAssSubtitles)
 * Then hand all paths + the desired filter knobs to compose() and
 * upload the resulting MP4. Worker-side temp cleanup is the caller's
 * responsibility.
 */

import { runFfmpeg, X264_MEM_FLAGS } from "./ffmpegCmd.js";
import { resolveGradeFilter, type ColorGrade } from "./colorGrade.js";
import type { TransitionType } from "./transitions.js";

const AUDIO_FADE_SECONDS = 0.3;
const DEFAULT_MUSIC_VOLUME = 0.18;   // matches mixMusic.ts duck level
const DEFAULT_SFX_VOLUME   = 0.30;

export interface ComposeFinalInput {
  /** Already-normalised scene clips at target resolution + framerate. */
  clipPaths: string[];
  /** Probed actual durations of each clip (seconds, two-decimal precision). */
  clipDurations: number[];
  /** Output mp4 path (will be overwritten). */
  outputPath: string;
  /** Target output resolution. */
  width: number;
  height: number;
  fps: number;

  // ── Crossfade ──
  /** Crossfade duration in seconds (0 = hard cuts). */
  crossfadeDuration: number;
  /** xfade transition name when crossfadeDuration > 0. */
  crossfadeType: TransitionType;

  // ── Audio ──
  /** Continuous master narration mp3 (LOCAL FILE PATH). When provided,
   *  per-clip audio is ignored and replaced with master + beds. */
  masterAudioPath: string | null;
  /** Lyria music bed (LOCAL FILE PATH). Optional. */
  musicPath: string | null;
  /** Lyria SFX bed (LOCAL FILE PATH). Optional. */
  sfxPath: string | null;
  /** Music volume (0..1). Default 0.18 (ducked under narration). */
  musicVolume?: number;
  /** SFX volume (0..1). Default 0.30. */
  sfxVolume?: number;

  // ── Visual extras ──
  /** ASS subtitle file path (already written to disk). Null = no captions. */
  assPath: string | null;
  /** Fonts directory for ASS rendering (passed to libass via fontsdir=). */
  fontsDir: string | null;
  /** Color-grade preset id from intake_settings.grade. Null = no grade. */
  colorGrade: ColorGrade | null;
  /** Brand-mark / watermark text (drawtext overlay). Null = no overlay. */
  brandMark: string | null;

  // ── Encoder ──
  /** libx264 -crf value. Default 22 (visually lossless for screens). */
  crf?: number;
  /** Total ffmpeg timeout in ms. Default 30 min. */
  timeoutMs?: number;
}

export interface ComposeFinalResult {
  /** Total ffmpeg wall-time in seconds (parsed from no-op since execFile
   *  doesn't expose timing — caller measures around the call). */
  ok: true;
}

/** Escape a path for use inside an ffmpeg filter argument (windows + colons). */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Escape arbitrary text for drawtext (commas, colons, single-quotes, backslashes). */
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,");
}

/**
 * Build the video portion of the filter_complex.
 *
 * For N clips with crossfade duration X (0 = hard cuts via concat):
 *   • If X > 0 and N >= 2: chain xfade transitions, output [vmix].
 *   • Else: concat the video streams with concat filter, output [vmix].
 *
 * The output label is then post-processed by appendVideoPostFilters() to
 * apply ASS captions, color grade, brand mark, etc.
 */
function buildVideoChain(
  n: number,
  durations: number[],
  crossfadeDuration: number,
  crossfadeType: TransitionType,
): string[] {
  if (n < 1) throw new Error("composeFinal: at least 1 clip required");
  const chain: string[] = [];

  if (crossfadeDuration > 0 && n >= 2) {
    let prev = "[0:v]";
    let cumulative = 0;
    for (let i = 1; i < n; i++) {
      cumulative += durations[i - 1];
      const offset = Math.max(0, cumulative - crossfadeDuration * i);
      const outLabel = i === n - 1 ? "[vmix]" : `[v${i}]`;
      chain.push(
        `${prev}[${i}:v]xfade=transition=${crossfadeType}:` +
        `duration=${crossfadeDuration}:offset=${offset.toFixed(3)}${outLabel}`,
      );
      prev = outLabel;
    }
  } else if (n >= 2) {
    // Hard cuts via concat filter (re-encodes anyway since we're in
    // single-pass; the alternative concat-demuxer doesn't compose with
    // the rest of the filter graph).
    const inputs = Array.from({ length: n }, (_, i) => `[${i}:v]`).join("");
    chain.push(`${inputs}concat=n=${n}:v=1:a=0[vmix]`);
  } else {
    // Single clip — pass through.
    chain.push(`[0:v]copy[vmix]`);
  }

  return chain;
}

/**
 * Build the audio portion of the filter_complex.
 *
 * MASTER-AUDIO MODE (masterAudioPath provided):
 *   The narration is one continuous mp3. Per-clip audio is dropped.
 *   We use the master input plus optional music + sfx beds, mixed
 *   with `amix=inputs=N:duration=first`.
 *
 *     [N:a]aresample=48000,apad,atrim=0:TOTAL[narration]
 *     [N+1:a]volume=0.18,apad,atrim=0:TOTAL[bgm]
 *     [N+2:a]volume=0.30,apad,atrim=0:TOTAL[sfx]
 *     [narration][bgm][sfx]amix=inputs=3:duration=first:dropout_transition=0[aout]
 *
 * PER-CLIP MODE (masterAudioPath null):
 *   Use the legacy crossfade audio chain (atrim/afade/concat) so
 *   smartflow's per-scene audio still works.
 *
 * Returns { chain, audioInputCount } so the caller knows how many
 * extra `-i` inputs to add.
 */
function buildAudioChain(args: {
  n: number;
  durations: number[];
  crossfadeDuration: number;
  totalOutputDuration: number;
  masterAudioInputIdx: number | null;
  musicInputIdx: number | null;
  sfxInputIdx: number | null;
  musicVolume: number;
  sfxVolume: number;
}): string[] {
  const chain: string[] = [];
  const {
    n, durations, crossfadeDuration, totalOutputDuration,
    masterAudioInputIdx, musicInputIdx, sfxInputIdx,
    musicVolume, sfxVolume,
  } = args;

  if (masterAudioInputIdx !== null) {
    // Master audio replaces per-clip tracks entirely.
    const totalStr = totalOutputDuration.toFixed(3);

    chain.push(
      `[${masterAudioInputIdx}:a]aresample=48000,apad,atrim=0:${totalStr},asetpts=PTS-STARTPTS[narration]`,
    );

    const mixInputs: string[] = ["[narration]"];

    if (musicInputIdx !== null) {
      chain.push(
        `[${musicInputIdx}:a]aresample=48000,volume=${musicVolume.toFixed(3)},` +
        `apad,atrim=0:${totalStr},asetpts=PTS-STARTPTS[bgm]`,
      );
      mixInputs.push("[bgm]");
    }
    if (sfxInputIdx !== null) {
      chain.push(
        `[${sfxInputIdx}:a]aresample=48000,volume=${sfxVolume.toFixed(3)},` +
        `apad,atrim=0:${totalStr},asetpts=PTS-STARTPTS[sfx]`,
      );
      mixInputs.push("[sfx]");
    }

    if (mixInputs.length === 1) {
      chain.push(`[narration]anull[aout]`);
    } else {
      chain.push(
        `${mixInputs.join("")}amix=inputs=${mixInputs.length}:` +
        `duration=first:dropout_transition=0:normalize=0[aout]`,
      );
    }
    return chain;
  }

  // ── Per-clip mode (no master audio) ──
  // Replicates the legacy singlePassCrossfade audio chain: atrim each
  // clip's audio so segments don't overlap, fade in/out at the joins,
  // concat into one stream.
  if (crossfadeDuration <= 0 || n < 2) {
    // No crossfade — plain concat of per-clip audio.
    const inputs = Array.from({ length: n }, (_, i) => `[${i}:a]`).join("");
    chain.push(`${inputs}concat=n=${n}:v=0:a=1[aout]`);
    return chain;
  }

  const halfX = crossfadeDuration / 2;
  const audioFadeDur = Math.min(AUDIO_FADE_SECONDS, halfX);
  const audioInputs: string[] = [];
  for (let i = 0; i < n; i++) {
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const trimHead = isFirst ? 0 : halfX;
    const trimEnd = isLast ? durations[i] : durations[i] - halfX;
    const segLen = trimEnd - trimHead;
    const fades: string[] = [];
    if (!isFirst) fades.push(`afade=t=in:d=${audioFadeDur.toFixed(3)}`);
    if (!isLast) {
      const foStart = Math.max(0, segLen - audioFadeDur);
      fades.push(`afade=t=out:st=${foStart.toFixed(3)}:d=${audioFadeDur.toFixed(3)}`);
    }
    const trimExpr = `atrim=${trimHead.toFixed(3)}:${trimEnd.toFixed(3)},asetpts=PTS-STARTPTS`;
    const filters = [trimExpr, ...fades].join(",");
    const label = `[a${i}]`;
    chain.push(`[${i}:a]${filters}${label}`);
    audioInputs.push(label);
  }
  chain.push(`${audioInputs.join("")}concat=n=${n}:v=0:a=1[aout]`);
  return chain;
}

/**
 * Append post-process video filters: color grade → ASS captions →
 * brand-mark drawtext. Each takes [vmix] and produces a new label;
 * the last one in the chain is renamed back to [vfinal] so the -map
 * arg is stable regardless of which filters are active.
 */
function buildVideoPostChain(args: {
  colorGrade: ColorGrade | null;
  assPath: string | null;
  fontsDir: string | null;
  brandMark: string | null;
}): string[] {
  const { colorGrade, assPath, fontsDir, brandMark } = args;
  const chain: string[] = [];
  let prev = "[vmix]";
  let stage = 0;

  if (colorGrade) {
    const filter = resolveGradeFilter(colorGrade);
    if (filter) {
      const out = `[vp${stage++}]`;
      chain.push(`${prev}${filter}${out}`);
      prev = out;
    }
  }

  if (assPath) {
    let assArg = `ass=${escapeFilterPath(assPath)}`;
    if (fontsDir) assArg += `:fontsdir=${escapeFilterPath(fontsDir)}`;
    const out = `[vp${stage++}]`;
    chain.push(`${prev}${assArg}${out}`);
    prev = out;
  }

  if (brandMark) {
    const text = escapeDrawtext(brandMark);
    const out = `[vp${stage++}]`;
    chain.push(
      `${prev}drawtext=text='${text}':fontcolor=white:fontsize=20:` +
      `box=1:boxcolor=black@0.45:boxborderw=8:` +
      `x=w-tw-24:y=h-th-24${out}`,
    );
    prev = out;
  }

  // Rename the last label to [vfinal] so the -map arg is stable.
  if (chain.length === 0) {
    chain.push(`${prev}null[vfinal]`);
  } else {
    // Replace the last out-label in the previous filter with [vfinal].
    const lastIdx = chain.length - 1;
    chain[lastIdx] = chain[lastIdx].replace(/\[vp\d+\]$/, "[vfinal]");
  }
  return chain;
}

/**
 * Run the unified single-pass ffmpeg composition. Throws on failure;
 * the caller is expected to fall back to the legacy multi-pass path.
 */
export async function composeFinal(input: ComposeFinalInput): Promise<ComposeFinalResult> {
  const {
    clipPaths, clipDurations, outputPath,
    width, height, fps,
    crossfadeDuration, crossfadeType,
    masterAudioPath, musicPath, sfxPath,
    musicVolume = DEFAULT_MUSIC_VOLUME,
    sfxVolume = DEFAULT_SFX_VOLUME,
    assPath, fontsDir, colorGrade, brandMark,
    crf = 22,
    timeoutMs = 30 * 60 * 1000,
  } = input;

  if (clipPaths.length === 0) {
    throw new Error("composeFinal: no clips to compose");
  }
  if (clipDurations.length !== clipPaths.length) {
    throw new Error("composeFinal: clipDurations length must match clipPaths");
  }

  const n = clipPaths.length;

  // Compute total output duration. With crossfade, output = sum(durations) - (n-1)*X
  const sumDurations = clipDurations.reduce((a, b) => a + b, 0);
  const totalOutputDuration =
    crossfadeDuration > 0 && n >= 2
      ? Math.max(0, sumDurations - crossfadeDuration * (n - 1))
      : sumDurations;

  // ── Build the input list ──
  // Order: clips first (indices 0..n-1), then master, then music, then sfx.
  // This ordering keeps the audio filter labels stable across cases.
  const inputArgs: string[] = [];
  for (const p of clipPaths) inputArgs.push("-i", p);

  let masterIdx: number | null = null;
  let musicIdx: number | null = null;
  let sfxIdx: number | null = null;
  let nextIdx = n;

  if (masterAudioPath) {
    masterIdx = nextIdx++;
    inputArgs.push("-i", masterAudioPath);
  }
  if (musicPath) {
    musicIdx = nextIdx++;
    inputArgs.push("-i", musicPath);
  }
  if (sfxPath) {
    sfxIdx = nextIdx++;
    inputArgs.push("-i", sfxPath);
  }

  // ── Build the filter graph ──
  const videoChain = buildVideoChain(n, clipDurations, crossfadeDuration, crossfadeType);
  const videoPost = buildVideoPostChain({ colorGrade, assPath, fontsDir, brandMark });
  const audioChain = buildAudioChain({
    n,
    durations: clipDurations,
    crossfadeDuration,
    totalOutputDuration,
    masterAudioInputIdx: masterIdx,
    musicInputIdx: musicIdx,
    sfxInputIdx: sfxIdx,
    musicVolume,
    sfxVolume,
  });

  const filterComplex = [...videoChain, ...videoPost, ...audioChain].join(";");

  console.log(
    `[composeFinal] clips=${n} crossfade=${crossfadeDuration}s ` +
    `master=${!!masterAudioPath} music=${!!musicPath} sfx=${!!sfxPath} ` +
    `captions=${!!assPath} grade=${colorGrade ?? "none"} brand=${!!brandMark} ` +
    `totalDur=${totalOutputDuration.toFixed(1)}s ` +
    `filterChars=${filterComplex.length}`,
  );

  const args = [
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[vfinal]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-s", `${width}x${height}`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ];

  await runFfmpeg(args, timeoutMs);
  return { ok: true };
}
