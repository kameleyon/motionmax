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
  // Core styles
  | "classic" | "bold" | "neon" | "karaoke" | "minimal" | "box"
  // Text effects
  | "typewriter" | "gradient" | "subtitleBar" | "outlineOnly" | "shadowPop"
  | "handwritten" | "topCenter" | "allCapsGlow"
  // Colorful (from caption.png)
  | "whiteStroke" | "blueStroke" | "redFire" | "orangeGlow"
  | "yellowOutline" | "greenPill" | "goldScript" | "comicPop"
  | "blueWhite" | "redBlack" | "yellowRed";

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SceneCaption {
  sceneIndex: number;
  voiceover: string;
  startMs: number;
  durationMs: number;
  words: CaptionWord[];
}

// ── Word Timing Estimation ─────────────────────────────────────────

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

const STYLE_DEFS: Record<Exclude<CaptionStyle, "none">, AssStyleDef> = {
  // ── Core ──
  classic: {
    fontName: "DejaVu Sans", fontSize: 44, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0xA0), bold: true,
    outline: 2, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  bold: {
    fontName: "Liberation Sans", fontSize: 56, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: BLACK, bold: true,
    outline: 4, shadow: 2, alignment: 2, marginV: 300, borderStyle: 1, uppercase: true,
  },
  neon: {
    fontName: "DejaVu Sans", fontSize: 46, primaryColor: AQUA, secondaryColor: WHITE,
    outlineColor: assColor(0x08, 0x60, 0x68), backColor: assColor(0, 0, 0, 0x90), bold: true,
    outline: 3, shadow: 0, alignment: 2, marginV: 280, borderStyle: 3,
  },
  karaoke: {
    fontName: "DejaVu Sans", fontSize: 44, primaryColor: WHITE, secondaryColor: AQUA,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0xA0), bold: true,
    outline: 2, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  minimal: {
    fontName: "DejaVu Sans", fontSize: 34, primaryColor: GRAY, secondaryColor: WHITE,
    outlineColor: assColor(0, 0, 0, 0x60), backColor: assColor(0, 0, 0, 0), bold: false,
    outline: 1, shadow: 0, alignment: 2, marginV: 260, borderStyle: 1,
  },
  box: {
    fontName: "DejaVu Sans", fontSize: 42, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: assColor(0x11, 0xC4, 0xD0), backColor: assColor(0x11, 0xC4, 0xD0, 0x40), bold: true,
    outline: 14, shadow: 0, alignment: 2, marginV: 280, borderStyle: 3,
  },
  // ── Text effects ──
  typewriter: {
    fontName: "DejaVu Sans Mono", fontSize: 38, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0x80), bold: false,
    outline: 1, shadow: 0, alignment: 2, marginV: 280, borderStyle: 1,
  },
  gradient: {
    fontName: "Liberation Sans", fontSize: 48, primaryColor: AQUA, secondaryColor: GOLD,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 3, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  subtitleBar: {
    fontName: "DejaVu Sans", fontSize: 40, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: assColor(0, 0, 0, 0), backColor: assColor(0, 0, 0, 0x99), bold: false,
    outline: 20, shadow: 0, alignment: 2, marginV: 0, borderStyle: 3,
  },
  outlineOnly: {
    fontName: "Liberation Sans", fontSize: 50, primaryColor: assColor(0, 0, 0, 0xFE), secondaryColor: AQUA,
    outlineColor: WHITE, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 3, shadow: 0, alignment: 2, marginV: 280, borderStyle: 1,
  },
  shadowPop: {
    fontName: "Liberation Sans", fontSize: 52, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: assColor(0, 0, 0, 0), backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 0, shadow: 4, alignment: 2, marginV: 280, borderStyle: 1,
  },
  handwritten: {
    fontName: "DejaVu Serif", fontSize: 42, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: false, italic: true,
    outline: 2, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  topCenter: {
    fontName: "DejaVu Sans", fontSize: 42, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0xA0), bold: true,
    outline: 2, shadow: 1, alignment: 8, marginV: 40, borderStyle: 1,
  },
  allCapsGlow: {
    fontName: "Liberation Sans", fontSize: 48, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: AQUA, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 3, alignment: 2, marginV: 280, borderStyle: 1, uppercase: true,
  },
  // ── Colorful (from caption.png) ──
  whiteStroke: {
    fontName: "Liberation Sans", fontSize: 52, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 5, shadow: 0, alignment: 2, marginV: 280, borderStyle: 1,
  },
  blueStroke: {
    fontName: "Liberation Sans", fontSize: 50, primaryColor: BLUE, secondaryColor: WHITE,
    outlineColor: WHITE, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  redFire: {
    fontName: "Liberation Sans", fontSize: 52, primaryColor: RED, secondaryColor: YELLOW,
    outlineColor: YELLOW, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 3, shadow: 2, alignment: 2, marginV: 280, borderStyle: 1,
  },
  orangeGlow: {
    fontName: "Liberation Sans", fontSize: 50, primaryColor: ORANGE, secondaryColor: WHITE,
    outlineColor: WHITE, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  yellowOutline: {
    fontName: "Liberation Sans", fontSize: 50, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: YELLOW, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  greenPill: {
    fontName: "DejaVu Sans", fontSize: 42, primaryColor: WHITE, secondaryColor: WHITE,
    outlineColor: GREEN, backColor: GREEN, bold: true,
    outline: 16, shadow: 0, alignment: 2, marginV: 280, borderStyle: 3,
  },
  goldScript: {
    fontName: "DejaVu Serif", fontSize: 46, primaryColor: GOLD, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: false, italic: true,
    outline: 2, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
  },
  comicPop: {
    fontName: "Liberation Sans", fontSize: 54, primaryColor: RED, secondaryColor: WHITE,
    outlineColor: YELLOW, backColor: YELLOW, bold: true,
    outline: 5, shadow: 3, alignment: 2, marginV: 280, borderStyle: 1, uppercase: true,
  },
  blueWhite: {
    fontName: "Liberation Sans", fontSize: 50, primaryColor: WHITE, secondaryColor: BLUE,
    outlineColor: BLUE, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 0, alignment: 2, marginV: 280, borderStyle: 1,
  },
  redBlack: {
    fontName: "Liberation Sans", fontSize: 52, primaryColor: RED, secondaryColor: WHITE,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 2, alignment: 2, marginV: 280, borderStyle: 1,
  },
  yellowRed: {
    fontName: "Liberation Sans", fontSize: 50, primaryColor: YELLOW, secondaryColor: RED,
    outlineColor: RED, backColor: assColor(0, 0, 0, 0), bold: true,
    outline: 4, shadow: 1, alignment: 2, marginV: 280, borderStyle: 1,
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
 * Build dialogue lines. Groups words into readable subtitle lines
 * (max ~5 words per line, ~2 lines visible at a time).
 */
function buildDialogueLines(
  caption: SceneCaption,
  style: Exclude<CaptionStyle, "none">,
): string[] {
  const styleDef = STYLE_DEFS[style];
  const words = caption.words;
  if (words.length === 0) return [];

  const lines: string[] = [];
  const WORDS_PER_LINE = 5;

  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    const chunk = words.slice(i, i + WORDS_PER_LINE);
    const startTime = msToAssTime(chunk[0].startMs);
    const endTime = msToAssTime(chunk[chunk.length - 1].endMs);

    let text: string;

    if (style === "karaoke") {
      text = chunk.map(w => {
        const durCs = Math.round((w.endMs - w.startMs) / 10);
        return `{\\kf${durCs}}${w.text}`;
      }).join(" ");
    } else {
      text = chunk.map(w => w.text).join(" ");
      if (styleDef.uppercase) text = text.toUpperCase();
    }

    lines.push(`Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}`);
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
 *        (from audio probe). If not provided, falls back to scene.duration.
 */
export function generateAssSubtitles(
  scenes: Array<{ voiceover: string; duration: number }>,
  style: CaptionStyle,
  width = 1920,
  height = 1080,
  actualDurations?: number[],
): string | null {
  if (style === "none") return null;

  const captions: SceneCaption[] = [];
  let timelineMs = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    // Use actual duration if available (from audio probe), otherwise config value
    const durationSec = actualDurations?.[i] ?? scene.duration ?? 10;
    const durationMs = durationSec * 1000;
    const words = estimateWordTimings(scene.voiceover || "", timelineMs, durationMs);

    captions.push({
      sceneIndex: i,
      voiceover: scene.voiceover || "",
      startMs: timelineMs,
      durationMs,
      words,
    });

    timelineMs += durationMs;
  }

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
  // Core
  { id: "classic", label: "Classic", description: "White text, black outline" },
  { id: "bold", label: "Bold", description: "Large uppercase, heavy border" },
  { id: "neon", label: "Neon", description: "Aqua glow, dark background" },
  { id: "karaoke", label: "Karaoke", description: "Word-by-word highlight" },
  { id: "minimal", label: "Minimal", description: "Small, subtle, clean" },
  { id: "box", label: "Box", description: "Text in aqua rectangle" },
  // Text effects
  { id: "typewriter", label: "Typewriter", description: "Monospace font" },
  { id: "gradient", label: "Gradient", description: "Aqua to gold" },
  { id: "subtitleBar", label: "Subtitle Bar", description: "Dark bar across bottom" },
  { id: "outlineOnly", label: "Outline Only", description: "No fill, white outline" },
  { id: "shadowPop", label: "Shadow Pop", description: "White text, heavy shadow" },
  { id: "handwritten", label: "Handwritten", description: "Italic serif font" },
  { id: "topCenter", label: "Top Center", description: "White text at top" },
  { id: "allCapsGlow", label: "All Caps Glow", description: "Uppercase, aqua glow" },
  // Colorful
  { id: "whiteStroke", label: "White Stroke", description: "White, thick black outline" },
  { id: "blueStroke", label: "Blue Stroke", description: "Blue text, white outline" },
  { id: "redFire", label: "Red Fire", description: "Red text, yellow outline" },
  { id: "orangeGlow", label: "Orange Glow", description: "Orange text, white glow" },
  { id: "yellowOutline", label: "Yellow Outline", description: "White text, yellow border" },
  { id: "greenPill", label: "Green Pill", description: "White text in green badge" },
  { id: "goldScript", label: "Gold Script", description: "Elegant gold italic" },
  { id: "comicPop", label: "Comic Pop", description: "Red text, yellow burst" },
  { id: "blueWhite", label: "Blue White", description: "White text, blue outline" },
  { id: "redBlack", label: "Red Black", description: "Red text, black outline" },
  { id: "yellowRed", label: "Yellow Red", description: "Yellow text, red outline" },
];
