/**
 * Shared types, platform config, audio config, and rendering utilities for video export.
 * Extracted from useVideoExport for modularity and testability.
 */

export type ExportStatus = "idle" | "loading" | "rendering" | "encoding" | "complete" | "error";

export interface ExportState {
  status: ExportStatus;
  progress: number;
  error?: string;
  warning?: string;
  videoUrl?: string;
}

export interface ExportCallbacks {
  setState: (state: ExportState) => void;
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  err: (...args: any[]) => void;
  isAborted: () => boolean;
}

export interface PlatformConfig {
  isIOS: boolean;
  isAndroid: boolean;
  isMobile: boolean;
  dim: { w: number; h: number };
  fps: number;
  videoBitrate: number;
}

// ---- Yield helpers for memory management ----

export const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export const longYield = () => new Promise<void>((resolve) => setTimeout(resolve, 16));
export const gcYield = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

/** Wait for encoder queue to drain to prevent memory buildup */
export const waitForEncoderDrain = async (encoder: VideoEncoder, maxQueue = 10) => {
  while (encoder.encodeQueueSize > maxQueue) {
    await longYield();
  }
};

// ---- Platform Configuration ----

/** Detect platform and return appropriate export configuration */
export function getPlatformConfig(format: "landscape" | "portrait" | "square"): PlatformConfig {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isMobile = isIOS || isAndroid;

  const dimensions = isIOS
    ? { landscape: { w: 1280, h: 720 }, portrait: { w: 720, h: 1280 }, square: { w: 960, h: 960 } }
    : { landscape: { w: 1920, h: 1080 }, portrait: { w: 1080, h: 1920 }, square: { w: 1080, h: 1080 } };

  const config: PlatformConfig = {
    isIOS,
    isAndroid,
    isMobile,
    dim: dimensions[format],
    fps: isIOS ? 24 : 30,
    videoBitrate: isIOS ? 2_500_000 : 6_000_000,
  };

  console.log("[Export:Platform]", "Config resolved", config);
  return config;
}

// ---- Audio Configuration ----

/** Audio encoder configuration candidates, ordered by preference */
export const AUDIO_CANDIDATES = [
  { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
  { codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000 },
  { codec: "aac", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
  { codec: "aac", sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000 },
];

/** Find the first supported audio configuration */
export async function findSupportedAudioConfig(
  AudioEncoderCtor: any,
  warn: (...args: any[]) => void
): Promise<any | null> {
  for (const cfg of AUDIO_CANDIDATES) {
    try {
      const result = await AudioEncoderCtor.isConfigSupported(cfg);
      if (result?.supported) {
        console.log("[Export:Audio]", "Found supported config:", cfg);
        return cfg;
      }
    } catch { /* ignore */ }
  }
  warn("[Export:Audio]", "No supported audio configuration found. Exporting silent video.");
  return null;
}

/**
 * Generate AAC AudioSpecificConfig (2 bytes).
 * Fixes the iOS bug where AudioEncoder returns a 39-byte ES_Descriptor instead of raw ASC.
 */
export function generateAACAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const objectType = 2; // AAC LC
  const frequencyIndex = {
    96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6,
    22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
  }[sampleRate] ?? 4;

  const channelConfig = channels;
  const config = new Uint8Array(2);
  config[0] = (objectType << 3) | ((frequencyIndex >> 1) & 0x07);
  config[1] = ((frequencyIndex & 0x01) << 7) | (channelConfig << 3);

  return config;
}

// ---- Brand Watermark ----

/**
 * Draw a brand mark watermark on the canvas.
 * Uses Montserrat Medium font, 35% black background, 95% white text.
 */
export function drawBrandWatermark(
  ctx: CanvasRenderingContext2D,
  brandMark: string,
  canvasWidth: number,
  canvasHeight: number
) {
  const fontSize = Math.max(18, Math.round(canvasWidth * 0.028));
  const paddingX = Math.round(fontSize * 1.0);
  const paddingY = Math.round(fontSize * 0.5);
  const borderRadius = Math.round(fontSize * 0.5);
  const bottomMargin = Math.round(canvasHeight * 0.035);

  ctx.font = `500 ${fontSize}px Montserrat, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const textMetrics = ctx.measureText(brandMark);
  const textWidth = textMetrics.width;
  const textHeight = fontSize;

  const pillWidth = textWidth + paddingX * 2;
  const pillHeight = textHeight + paddingY * 2;
  const pillX = (canvasWidth - pillWidth) / 2;
  const pillY = canvasHeight - bottomMargin - pillHeight;

  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillWidth, pillHeight, borderRadius);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fillText(brandMark, canvasWidth / 2, pillY + pillHeight / 2);
}
