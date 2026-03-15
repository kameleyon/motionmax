/**
 * Low-level ffmpeg / ffprobe runner via child_process.execFile.
 * Avoids fluent-ffmpeg's automatic complex-filter mode that causes
 * "Error initializing complex filters" on many Render/Docker setups.
 */
import { execFile } from "child_process";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 min

export interface FfmpegResult {
  stdout: string;
  stderr: string;
}

/** Run an ffmpeg command with a timeout. Rejects on non-zero exit. */
export function runFfmpeg(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      FFMPEG_BIN,
      ["-y", ...args],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.slice(-500) || error.message;
          return reject(new Error(`ffmpeg failed: ${msg}`));
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );

    // Safety: if timeout fires, SIGKILL the process tree
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs + 2000);

    proc.on("close", () => clearTimeout(timer));
  });
}

/** Probe a media file and return its duration in seconds. */
export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_BIN,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { timeout: 30_000 },
      (error, stdout) => {
        if (error) return reject(new Error(`ffprobe: ${error.message}`));
        const dur = parseFloat(stdout?.trim() ?? "");
        resolve(Number.isFinite(dur) && dur > 0 ? dur : 10);
      }
    );
  });
}

/** Memory-safe x264 flags — keeps libx264 under ~40 MB */
export const X264_MEM_FLAGS = [
  "-threads", "1",
  "-refs", "1",
  "-rc-lookahead", "0",
  "-g", "24",
  "-bf", "0",
  "-x264-params", "rc-lookahead=0:threads=1",
];
