/**
 * ASS (Advanced SubStation Alpha) caption builder for video export.
 *
 * Generates word-level timed captions from scene voiceovers and burns them
 * into the exported video via ffmpeg's ass filter.
 *
 * Supports multiple visual styles:
 *   - classic: White text, black outline, bottom center
 *   - bold: Large white text, heavy black border, uppercase
 *   - neon: Colored glow (aqua), dark background
 *   - karaoke: Word-by-word highlight — current word changes color
 *   - minimal: Small gray text, no background, lower third
 *   - box: White text inside colored rounded rectangle
 */

import fs from "fs";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────

export type CaptionStyle = "classic" | "bold" | "neon" | "karaoke" | "minimal" | "box" | "none";

export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SceneCaption {
  sceneIndex: number;
  voiceover: string;
  startMs: number;   // Scene start time in the final video timeline
  durationMs: number; // Scene duration in ms
  words: CaptionWord[];
}

// ── Word Timing Estimation ─────────────────────────────────────────

/**
 * Estimate word-level timing from voiceover text and scene duration.
 * Distributes words evenly across the duration with natural pauses at punctuation.
 */
function estimateWordTimings(voiceover: string, startMs: number, durationMs: number): CaptionWord[] {
  const words = voiceover.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Leave 200ms padding at start and end
  const PAD = 200;
  const usableDuration = durationMs - PAD * 2;
  const baseWordDur = usableDuration / words.length;

  const result: CaptionWord[] = [];
  let cursor = startMs + PAD;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // Add slight pause after punctuation
    const endsWithPause = /[.!?,;:]$/.test(word);
    const wordDur = endsWithPause ? baseWordDur * 1.3 : baseWordDur;

    result.push({
      text: word,
      startMs: Math.round(cursor),
      endMs: Math.round(cursor + wordDur * 0.9), // Small gap between words
    });
    cursor += wordDur;
  }

  return result;
}

// ── ASS Style Definitions ──────────────────────────────────────────

/** ASS color format: &HAABBGGRR (hex, reversed RGB, AA = alpha 00=opaque FF=transparent) */
function assColor(r: number, g: number, b: number, a = 0): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${hex(a)}${hex(b)}${hex(g)}${hex(r)}`;
}

const WHITE = assColor(255, 255, 255);
const BLACK = assColor(0, 0, 0);
const AQUA = assColor(0x11, 0xC4, 0xD0);
const YELLOW = assColor(0xE4, 0xC8, 0x75);
const GRAY = assColor(180, 180, 180);
const DARK_BG = assColor(0, 0, 0, 0x80); // semi-transparent black

interface AssStyleDef {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  secondaryColor: string;   // Used for karaoke highlight
  outlineColor: string;
  backColor: string;
  bold: boolean;
  outline: number;
  shadow: number;
  alignment: number;        // 1=left-bottom, 2=center-bottom, 5=center-top, 8=center-middle
  marginV: number;
  borderStyle: number;      // 1=outline+shadow, 3=opaque box
  uppercase?: boolean;
}

const STYLE_DEFS: Record<Exclude<CaptionStyle, "none">, AssStyleDef> = {
  classic: {
    fontName: "Arial", fontSize: 48, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0xA0), bold: true,
    outline: 2, shadow: 1, alignment: 2, marginV: 40, borderStyle: 1,
  },
  bold: {
    fontName: "Arial Black", fontSize: 60, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: BLACK, backColor: BLACK, bold: true,
    outline: 4, shadow: 2, alignment: 2, marginV: 50, borderStyle: 1, uppercase: true,
  },
  neon: {
    fontName: "Arial", fontSize: 50, primaryColor: AQUA, secondaryColor: WHITE,
    outlineColor: assColor(0x08, 0x80, 0x88), backColor: assColor(0, 0, 0, 0x90), bold: true,
    outline: 3, shadow: 0, alignment: 2, marginV: 40, borderStyle: 3,
  },
  karaoke: {
    fontName: "Arial", fontSize: 48, primaryColor: WHITE, secondaryColor: AQUA,
    outlineColor: BLACK, backColor: assColor(0, 0, 0, 0xA0), bold: true,
    outline: 2, shadow: 1, alignment: 2, marginV: 40, borderStyle: 1,
  },
  minimal: {
    fontName: "Helvetica Neue", fontSize: 36, primaryColor: GRAY, secondaryColor: WHITE,
    outlineColor: assColor(0, 0, 0, 0x60), backColor: assColor(0, 0, 0, 0), bold: false,
    outline: 1, shadow: 0, alignment: 2, marginV: 30, borderStyle: 1,
  },
  box: {
    fontName: "Arial", fontSize: 46, primaryColor: WHITE, secondaryColor: YELLOW,
    outlineColor: assColor(0x11, 0xC4, 0xD0), backColor: assColor(0x11, 0xC4, 0xD0, 0x30), bold: true,
    outline: 12, shadow: 0, alignment: 2, marginV: 45, borderStyle: 3,
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
Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.secondaryColor},${s.outlineColor},${s.backColor},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${s.borderStyle},${s.outline},${s.shadow},${s.alignment},20,20,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
}

/**
 * Build dialogue lines for a scene's captions.
 * Groups words into subtitle lines (max ~6 words per line for readability).
 */
function buildDialogueLines(
  caption: SceneCaption,
  style: Exclude<CaptionStyle, "none">,
): string[] {
  const styleDef = STYLE_DEFS[style];
  const words = caption.words;
  if (words.length === 0) return [];

  const lines: string[] = [];
  const WORDS_PER_LINE = 6;

  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    const chunk = words.slice(i, i + WORDS_PER_LINE);
    const startTime = msToAssTime(chunk[0].startMs);
    const endTime = msToAssTime(chunk[chunk.length - 1].endMs);

    let text: string;

    if (style === "karaoke") {
      // Karaoke: each word gets a \k tag with duration in centiseconds
      text = chunk.map((w, idx) => {
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
 * Returns the full .ass file content as a string.
 */
export function generateAssSubtitles(
  scenes: Array<{ voiceover: string; duration: number }>,
  style: CaptionStyle,
  width = 1920,
  height = 1080,
): string | null {
  if (style === "none") return null;

  // Build scene captions with word-level timing
  const captions: SceneCaption[] = [];
  let timelineMs = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const durationMs = (scene.duration || 10) * 1000;
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

  // Build ASS file
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
  { id: "classic", label: "Classic", description: "White text, black outline" },
  { id: "bold", label: "Bold", description: "Large uppercase, heavy border" },
  { id: "neon", label: "Neon", description: "Aqua glow, dark background" },
  { id: "karaoke", label: "Karaoke", description: "Word-by-word highlight" },
  { id: "minimal", label: "Minimal", description: "Small, subtle, clean" },
  { id: "box", label: "Box", description: "Text in colored rectangle" },
];
