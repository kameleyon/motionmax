/**
 * Low-level ffmpeg / ffprobe runner via child_process.execFile.
 * Avoids fluent-ffmpeg's automatic complex-filter mode that causes
 * "Error initializing complex filters" on many Render/Docker setups.
 */
import { execFile } from "child_process";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min

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

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs + 2000);

    proc.on("close", () => clearTimeout(timer));
  });
}

/** Quick metadata-based probe (can be inaccurate for VBR MP3). */
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

/**
 * Get the EXACT audio duration by fully decoding the file.
 * This is the gold-standard method — it does NOT rely on container
 * metadata, which is often wrong for VBR MP3 from TTS APIs.
 *
 * Runs: ffmpeg -i file -f null -
 * Then parses the final "time=HH:MM:SS.xx" from stderr.
 */
export function getExactAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG_BIN,
      ["-i", filePath, "-f", "null", "-"],
      { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        // ffmpeg writes progress to stderr even on success;
        // exit code may be non-zero if file has minor issues — parse anyway
        const output = stderr ?? "";
        const matches = output.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
        if (matches && matches.length > 0) {
          const last = matches[matches.length - 1];
          const parts = last.replace("time=", "").split(":");
          const h = parseFloat(parts[0]);
          const m = parseFloat(parts[1]);
          const s = parseFloat(parts[2]);
          const total = h * 3600 + m * 60 + s;
          if (total > 0) {
            console.log(`[ffmpegCmd] Exact decode duration: ${total.toFixed(3)}s for ${filePath}`);
            return resolve(total);
          }
        }
        // Fallback to ffprobe if decode-parse fails
        if (error) {
          console.warn(`[ffmpegCmd] Decode-duration failed, falling back to ffprobe`);
        }
        probeDuration(filePath).then(resolve).catch(reject);
      }
    );
  });
}

/** Memory-safe x264 flags — keeps libx264 under ~40 MB */
export const X264_MEM_FLAGS = [
  "-threads", "2",
  "-refs", "1",
  "-rc-lookahead", "0",
  "-g", "24",
  "-bf", "0",
  "-x264-params", "rc-lookahead=0:threads=2",
];
