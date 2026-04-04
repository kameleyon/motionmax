/**
 * ASS (Advanced SubStation Alpha) caption builder for video export.
 *
 * Generates word-level timed captions from scene voiceovers and burns them
 * into the exported video via ffmpeg's ass filter.
 *
 * Timing: Uses actual scene clip durations (from audio probe) — NOT the
 * configured `duration` field — so captions sync with the spoken audio.
 */

import fs from "fs";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────

export type CaptionStyle =
  | "none"
  | "orangeBox" | "yellowSlanted" | "redSlantedBox" | "cyanOutline"
  | "motionBlur" | "yellowSmall" | "thickStroke" | "karaokePop"
  | "typewriter" | "neonTeal" | "goldLuxury" | "bouncyPill"
  | "glitch" | "cinematicFade" | "redTag" | "blackBox"
  | "comicBurst" | "retroTerminal" | "heavyDropShadow";

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** ASR result per scene — from Hypereal audio-asr */
export interface ASRSceneResult {
  words: Array<{ word: string; start: number; end: number }>;
}

export interface SceneCaption {
  sceneIndex: number;
  voiceover: string;
  startMs: number;
  durationMs: number;
  words: CaptionWord[];
}

// ── Word Timing: ASR (exact) or Estimation (fallback) ──────────────

/**
 * Convert ASR word timestamps to CaptionWords, offset to the scene's position in the timeline.
 * ASR timestamps are already accurate — no artificial delay needed.
 */
function asrWordsToCaptionWords(asrWords: Array<{ word: string; start: number; end: number }>, timelineOffsetMs: number): CaptionWord[] {
  return asrWords
    .filter(w => w.word.trim().length > 0)
    .map(w => ({
      text: w.word.trim(),
      startMs: Math.round(w.start * 1000 + timelineOffsetMs),
      endMs: Math.round(w.end * 1000 + timelineOffsetMs),
    }));
}

// ── Word Timing Estimation (fallback) ──────────────────────────────

/**
 * Estimate word-level timing from voiceover text and actual clip duration.
 * Words are distributed proportionally — shorter words get less time,
 * longer words get more. Punctuation adds natural pauses.
 */
function estimateWordTimings(voiceover: string, startMs: number, durationMs: number): CaptionWord[] {
  const words = voiceover.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Leave 300ms at start (TTS ramp-up) and 500ms at end (natural tail)
  const START_PAD = 300;
  const END_PAD = 500;
  const usableDuration = Math.max(durationMs - START_PAD - END_PAD, durationMs * 0.5);

  // Weight words by character length + punctuation pauses
  const weights = words.map(w => {
    let weight = w.length;
    if (/[.!?]$/.test(w)) weight += 4; // sentence end = longer pause
    if (/[,;:]$/.test(w)) weight += 2; // mid-sentence pause
    return weight;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const result: CaptionWord[] = [];
  let cursor = startMs + START_PAD;

  for (let i = 0; i < words.length; i++) {
    const wordDur = (weights[i] / totalWeight) * usableDuration;
    const GAP = 30; // 30ms gap between words

    result.push({
      text: words[i],
      startMs: Math.round(cursor),
      endMs: Math.round(cursor + wordDur - GAP),
    });
    cursor += wordDur;
  }

  return result;
}

// ── ASS Style Definitions ──────────────────────────────────────────

/** ASS color format: &HAABBGGRR */
function assColor(r: number, g: number, b: number, a = 0): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${hex(a)}${hex(b)}${hex(g)}${hex(r)}`;
}

const WHITE = assColor(255, 255, 255);
const BLACK = assColor(0, 0, 0);
const AQUA = assColor(0x11, 0xC4, 0xD0);
const YELLOW = assColor(0xE4, 0xC8, 0x75);
const GOLD = assColor(0xD4, 0xA9, 0x29);
const RED = assColor(0xE0, 0x30, 0x30);
const ORANGE = assColor(0xFF, 0x8C, 0x00);
const BLUE = assColor(0x30, 0x60, 0xE0);
const GREEN = assColor(0x2E, 0xA8, 0x4E);
const GRAY = assColor(180, 180, 180);

interface AssStyleDef {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  secondaryColor: string;
  outlineColor: string;
  backColor: string;
  bold: boolean;
  italic?: boolean;
  outline: number;
  shadow: number;
  alignment: number;  // 2=bottom-center, 8=top-center, 5=middle-center
  marginV: number;
  borderStyle: number; // 1=outline+shadow, 3=opaque box
  uppercase?: boolean;
}

// marginV=640 on 1920px tall canvas = 1/3 from bottom
// Font sizes scaled up for social media readability (80-100px range)
const MV = 640; // Default vertical margin (1/3 from bottom on 1080x1920)

const STYLE_DEFS: Record<Exclude<CaptionStyle, "none">, AssStyleDef> = {
  // ── From Reference Visuals ──
  orangeBox: {
    fontName: "Montserrat", fontSize: 82, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: ORANGE, backColor: ORANGE, bold: true,
    outline: 18, shadow: 0, alignment: 2, marginV: MV, borderStyle: 3, uppercase: true,
  },
  yellowSlanted: {
    fontName: "Montserrat", fontSize: 90, primaryColor: assColor(0xFF, 0xEB, 0x3B), secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true, italic: true,
    outline: 7, shadow: 5, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  redSlantedBox: {
    fontName: "Montserrat", fontSize: 82, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: RED, backColor: RED, bold: true, italic: true,
    outline: 18, shadow: 0, alignment: 2, marginV: MV, borderStyle: 3, uppercase: true,
  },
  cyanOutline: {
    fontName: "Montserrat", fontSize: 86, primaryColor: assColor(0x00, 0xBC, 0xD4), secondaryColor: WHITE,
    outlineColor: WHITE, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 5, shadow: 0, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  motionBlur: {
    fontName: "Montserrat", fontSize: 86, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 3, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  yellowSmall: {
    fontName: "Montserrat", fontSize: 64, primaryColor: assColor(0xFF, 0xEB, 0x3B), secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 3, shadow: 1, alignment: 2, marginV: MV - 40, borderStyle: 1, uppercase: true,
  },
  // ── Trending / Premium ──
  thickStroke: {
    fontName: "Poppins", fontSize: 90, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 8, shadow: 0, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  karaokePop: {
    fontName: "Montserrat", fontSize: 84, primaryColor: WHITE, secondaryColor: assColor(0xFF, 0xEB, 0x3B),
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0xA0), bold: true,
    outline: 4, shadow: 1, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  typewriter: {
    fontName: "DejaVu Sans Mono", fontSize: 64, primaryColor: assColor(0x39, 0xFF, 0x14), secondaryColor: WHITE,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0x80), bold: true,
    outline: 2, shadow: 0, alignment: 2, marginV: MV, borderStyle: 1,
  },
  neonTeal: {
    fontName: "Poppins", fontSize: 84, primaryColor: assColor(0x00, 0xE5, 0xFF), secondaryColor: WHITE,
    outlineColor: assColor(0x00, 0x80, 0x90), backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 5, shadow: 8, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  goldLuxury: {
    fontName: "Pacifico", fontSize: 78, primaryColor: assColor(0xFF, 0xD7, 0x00), secondaryColor: YELLOW,
    outlineColor: assColor(0x8B, 0x65, 0x08), backColor: assColor(0, 0, 0, 0), bold: false, italic: true,
    outline: 3, shadow: 3, alignment: 2, marginV: MV, borderStyle: 1,
  },
  bouncyPill: {
    fontName: "Montserrat", fontSize: 72, primaryColor: assColor(0x1A, 0x1A, 0x1A), secondaryColor: BLACK,
    outlineColor: WHITE, backColor: WHITE, bold: true,
    outline: 20, shadow: 0, alignment: 2, marginV: MV, borderStyle: 3,
  },
  glitch: {
    fontName: "Montserrat", fontSize: 86, primaryColor: WHITE, secondaryColor: assColor(0xFF, 0x00, 0x00),
    outlineColor: assColor(0x00, 0x00, 0xFF), backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 0, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  cinematicFade: {
    fontName: "Montserrat", fontSize: 68, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: assColor(0, 0, 0, 0x60), backColor: assColor(0, 0, 0, 0), bold: false,
    outline: 2, shadow: 0, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  redTag: {
    fontName: "Poppins", fontSize: 72, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: RED, backColor: RED, bold: true,
    outline: 18, shadow: 0, alignment: 2, marginV: MV, borderStyle: 3,
  },
  blackBox: {
    fontName: "Liberation Sans", fontSize: 68, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: assColor(0, 0, 0, 0), backColor: assColor(0, 0, 0, 0xCC), bold: false,
    outline: 20, shadow: 0, alignment: 2, marginV: MV, borderStyle: 3,
  },
  comicBurst: {
    fontName: "Bangers", fontSize: 94, primaryColor: assColor(0xFF, 0xEB, 0x3B), secondaryColor: RED,
    outlineColor: RED, backColor: assColor(0, 0, 0, 0), bold: false,
    outline: 5, shadow: 4, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
  retroTerminal: {
    fontName: "DejaVu Sans Mono", fontSize: 60, primaryColor: assColor(0x39, 0xFF, 0x14), secondaryColor: WHITE,
    outlineColor: assColor(0, 0x40, 0), backColor: assColor(0, 0, 0, 0x90), bold: true,
    outline: 2, shadow: 0, alignment: 2, marginV: MV, borderStyle: 1,
  },
  heavyDropShadow: {
    fontName: "Bebas Neue", fontSize: 96, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: assColor(0, 0, 0, 0), backColor: assColor(0, 0, 0, 0), bold: false,
    outline: 0, shadow: 7, alignment: 2, marginV: MV, borderStyle: 1, uppercase: true,
  },
};

// ── ASS File Generation ────────────────────────────────────────────

function msToAssTime(ms: number): string {
  const totalSec = ms / 1000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function buildAssHeader(style: Exclude<CaptionStyle, "none">, width: number, height: number): string {
  const s = STYLE_DEFS[style];

  return `[Script Info]
Title: MotionMax Captions
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.secondaryColor},${s.outlineColor},${s.backColor},${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,100,0,0,${s.borderStyle},${s.outline},${s.shadow},${s.alignment},30,30,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/**
 * Styles that show one word at a time (pop on / pop off) — CapCut style.
 * All other styles show 3-word groups with karaoke highlight on the active word.
 */
const SINGLE_WORD_STYLES: Set<string> = new Set([
  "orangeBox", "yellowSlanted", "redSlantedBox", "motionBlur",
  "thickStroke", "comicBurst", "heavyDropShadow", "glitch", "bouncyPill",
]);

/** Subtitle-like styles that show longer lines (documentary / cinematic) */
const SUBTITLE_STYLES: Set<string> = new Set([
  "blackBox", "cinematicFade", "retroTerminal", "typewriter",
]);

/**
 * Build dialogue lines with word-level timing.
 *
 * Three modes depending on style:
 * 1. Single-word: one word at a time, each word = one dialogue event
 * 2. Karaoke group: 3 words shown, active word highlighted via \kf tag
 * 3. Subtitle: 5-word chunks, static text (documentary style)
 */
function buildDialogueLines(
  caption: SceneCaption,
  style: Exclude<CaptionStyle, "none">,
): string[] {
  const styleDef = STYLE_DEFS[style];
  const words = caption.words;
  if (words.length === 0) return [];

  const lines: string[] = [];

  if (SINGLE_WORD_STYLES.has(style)) {
    // ── Mode 1: One word at a time ──
    for (const w of words) {
      let text = w.text;
      if (styleDef.uppercase) text = text.toUpperCase();
      lines.push(`Dialogue: 0,${msToAssTime(w.startMs)},${msToAssTime(w.endMs)},Default,,0,0,0,,${text}`);
    }
  } else if (SUBTITLE_STYLES.has(style)) {
    // ── Mode 3: 5-word subtitle chunks (documentary) ──
    const WORDS_PER_LINE = 5;
    for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
      const chunk = words.slice(i, i + WORDS_PER_LINE);
      const startTime = msToAssTime(chunk[0].startMs);
      const endTime = msToAssTime(chunk[chunk.length - 1].endMs);
      let text = chunk.map(w => w.text).join(" ");
      if (styleDef.uppercase) text = text.toUpperCase();
      lines.push(`Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}`);
    }
  } else {
    // ── Mode 2: 3-word karaoke groups (active word highlights) ──
    const WORDS_PER_GROUP = 3;
    for (let i = 0; i < words.length; i += WORDS_PER_GROUP) {
      const chunk = words.slice(i, i + WORDS_PER_GROUP);
      const startTime = msToAssTime(chunk[0].startMs);
      const endTime = msToAssTime(chunk[chunk.length - 1].endMs);

      // Each word gets a \kf duration tag — the secondary color sweeps across
      const text = chunk.map(w => {
        const durCs = Math.round((w.endMs - w.startMs) / 10);
        let word = w.text;
        if (styleDef.uppercase) word = word.toUpperCase();
        return `{\\kf${durCs}}${word}`;
      }).join(" ");

      lines.push(`Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}`);
    }
  }

  return lines;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Generate ASS subtitle content from scene data.
 *
 * @param scenes Array of scene objects with voiceover text
 * @param style Caption style preset
 * @param width Video width
 * @param height Video height
 * @param actualDurations Optional array of actual clip durations in seconds
 * @param asrResults Optional ASR transcription results for exact word timing
 */
export function generateAssSubtitles(
  scenes: Array<{ voiceover: string; duration: number }>,
  style: CaptionStyle,
  width = 1920,
  height = 1080,
  actualDurations?: number[],
  asrResults?: (ASRSceneResult | null)[],
): string | null {
  if (style === "none") return null;

  const captions: SceneCaption[] = [];
  let timelineMs = 0;
  let asrUsed = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const durationSec = actualDurations?.[i] ?? scene.duration ?? 10;
    const durationMs = durationSec * 1000;

    // Use ASR word timestamps if available, otherwise fall back to estimation
    const asr = asrResults?.[i];
    let words: CaptionWord[];

    if (asr && asr.words && asr.words.length > 0) {
      words = asrWordsToCaptionWords(asr.words, timelineMs);
      asrUsed++;
    } else {
      words = estimateWordTimings(scene.voiceover || "", timelineMs, durationMs);
    }

    captions.push({
      sceneIndex: i,
      voiceover: scene.voiceover || "",
      startMs: timelineMs,
      durationMs,
      words,
    });

    timelineMs += durationMs;
  }

  console.log(`[Captions] Word timing: ${asrUsed}/${scenes.length} scenes from ASR, ${scenes.length - asrUsed} estimated`);

  const header = buildAssHeader(style, width, height);
  const dialogues = captions.flatMap(c => buildDialogueLines(c, style));

  return header + "\n" + dialogues.join("\n") + "\n";
}

/**
 * Write ASS subtitle file to disk and return the path.
 */
export async function writeAssFile(
  assContent: string,
  tempDir: string,
  filename = "captions.ass",
): Promise<string> {
  const filePath = path.join(tempDir, filename);
  await fs.promises.writeFile(filePath, assContent, "utf-8");
  console.log(`[Captions] ASS file written: ${filePath} (${assContent.length} chars)`);
  return filePath;
}

/** List of available caption styles for the frontend */
export const CAPTION_STYLES: Array<{ id: CaptionStyle; label: string; description: string }> = [
  { id: "none", label: "None", description: "No captions" },
  { id: "orangeBox", label: "Orange Box", description: "White text, orange background" },
  { id: "yellowSlanted", label: "Yellow Slanted", description: "Heavy italic, thick black outline" },
  { id: "redSlantedBox", label: "Red Slanted", description: "White text, red italic box" },
  { id: "cyanOutline", label: "Cyan Outline", description: "Cyan text, white outline" },
  { id: "motionBlur", label: "Motion Blur", description: "White text, high-speed entry" },
  { id: "yellowSmall", label: "Small Yellow", description: "Minimalist yellow text" },
  { id: "thickStroke", label: "Thick Stroke", description: "White text, heavy black border" },
  { id: "karaokePop", label: "Karaoke Pop", description: "Word-by-word dynamic scale" },
  { id: "neonTeal", label: "Neon Teal", description: "Aqua/Teal glowing text" },
  { id: "goldLuxury", label: "Gold Luxury", description: "Elegant gold metallic look" },
  { id: "bouncyPill", label: "Bouncy Pill", description: "Text inside a rounded pill" },
  { id: "glitch", label: "Glitch Offset", description: "RGB split shift effect" },
  { id: "comicBurst", label: "Comic Burst", description: "Explosive superhero style" },
  { id: "redTag", label: "Red Tag", description: "High-contrast red highlight" },
  { id: "blackBox", label: "Classic Black Box", description: "Documentary style" },
  { id: "typewriter", label: "Typewriter", description: "Monospace rigid entry" },
  { id: "cinematicFade", label: "Cinematic Fade", description: "Slow elegant reveal" },
  { id: "retroTerminal", label: "Retro Terminal", description: "Green pixel font" },
  { id: "heavyDropShadow", label: "Heavy Shadow", description: "Thick diagonal shadow" },
];
