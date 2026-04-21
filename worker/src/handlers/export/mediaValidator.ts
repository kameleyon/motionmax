/**
 * Media file validator — runs AFTER download, BEFORE ffmpeg.
 *
 * Problem this solves: a download can return HTTP 200 with garbage bytes
 * (HTML error page, truncated stream, wrong content-type) and ffmpeg then
 * dies with cryptic errors like "Format mp3 detected only with low score of 1"
 * that hide the real cause. We fail fast with a clear diagnostic instead.
 *
 * Checks, in order: file exists → size sane → magic bytes match expected kind.
 */
import fs from "fs";

export type MediaKind = "audio" | "image" | "video";

/** Minimum plausible size per kind. Anything smaller is certainly broken. */
const MIN_SIZE: Record<MediaKind, number> = {
  audio: 256,   // a 1-frame MP3 is ~200 bytes; anything less is junk
  image: 128,   // smallest valid PNG is ~67 bytes; use 128 for margin
  video: 1024,  // MP4 ftyp box alone is larger than this
};

export class MediaValidationError extends Error {
  constructor(
    message: string,
    public readonly kind: MediaKind,
    public readonly reason: "missing" | "empty" | "too_small" | "bad_magic",
    public readonly filePath: string,
    public readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "MediaValidationError";
  }
}

/** MP3 (ID3 / frame sync), WAV, OGG, FLAC, M4A (ftyp). */
function isValidAudioMagic(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // ID3v2 tag at start
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // MPEG audio frame sync (11 bits set): 0xFFE*
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;
  // RIFF + WAVE
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) return true;
  // OggS
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  // fLaC
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return true;
  // M4A ftyp box at offset 4
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
  return false;
}

/** PNG, JPEG, GIF, WebP, BMP. */
function isValidImageMagic(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: RIFF...WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
  return false;
}

/** MP4/MOV (ftyp box), WebM/Matroska (EBML header). */
function isValidVideoMagic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // ISO BMFF (MP4/MOV/M4V): "ftyp" at offset 4
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
  // EBML header for Matroska/WebM: 1A 45 DF A3
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return true;
  return false;
}

function checkMagic(buf: Buffer, kind: MediaKind): boolean {
  switch (kind) {
    case "audio": return isValidAudioMagic(buf);
    case "image": return isValidImageMagic(buf);
    case "video": return isValidVideoMagic(buf);
  }
}

/** Produce a short printable preview of the file head for diagnostics.
 *  Hex for first 16 bytes + ASCII-safe preview of first 120 bytes. */
function buildDiagnostic(buf: Buffer): string {
  const hex = buf.slice(0, 16).toString("hex");
  const ascii = buf.slice(0, 120).toString("utf8").replace(/[^\x20-\x7E]/g, ".");
  return `hex=${hex} preview=${ascii.slice(0, 120)}`;
}

/**
 * Validate a downloaded media file. Throws MediaValidationError on failure.
 * Pass this through `streamToFile` via the expectedKind param.
 */
export async function validateMedia(filePath: string, kind: MediaKind): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat) {
    throw new MediaValidationError(`${kind} file missing: ${filePath}`, kind, "missing", filePath);
  }
  if (stat.size === 0) {
    throw new MediaValidationError(`${kind} file is empty (0 bytes): ${filePath}`, kind, "empty", filePath);
  }
  if (stat.size < MIN_SIZE[kind]) {
    throw new MediaValidationError(
      `${kind} file too small (${stat.size} bytes, min ${MIN_SIZE[kind]}): ${filePath}`,
      kind, "too_small", filePath,
    );
  }

  // Read first 32 bytes + first 120 for diagnostics.
  const fd = await fs.promises.open(filePath, "r");
  let head: Buffer;
  try {
    const buf = Buffer.alloc(128);
    const { bytesRead } = await fd.read(buf, 0, 128, 0);
    head = buf.slice(0, bytesRead);
  } finally {
    await fd.close();
  }

  if (!checkMagic(head, kind)) {
    throw new MediaValidationError(
      `${kind} file has wrong magic bytes (got ${buildDiagnostic(head)})`,
      kind, "bad_magic", filePath, buildDiagnostic(head),
    );
  }
}

/** Convenience: predicate form of validateMedia. */
export async function isValidMedia(filePath: string, kind: MediaKind): Promise<boolean> {
  try {
    await validateMedia(filePath, kind);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate raw bytes (e.g., a TTS API response) before writing them to storage.
 * Prevents garbage — JSON error bodies, UTF-16 text, HTML, truncated streams —
 * from ever being uploaded as "audio.mp3". Callers should return an error
 * rather than uploading when this throws.
 */
export function validateMediaBytes(bytes: Uint8Array | Buffer, kind: MediaKind): void {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length === 0) {
    throw new MediaValidationError(`${kind} bytes are empty`, kind, "empty", "<buffer>");
  }
  if (buf.length < MIN_SIZE[kind]) {
    throw new MediaValidationError(
      `${kind} bytes too small (${buf.length} bytes, min ${MIN_SIZE[kind]})`,
      kind, "too_small", "<buffer>",
    );
  }
  const head = buf.slice(0, Math.min(128, buf.length));
  if (!checkMagic(head, kind)) {
    throw new MediaValidationError(
      `${kind} bytes have wrong magic (got ${buildDiagnostic(head)})`,
      kind, "bad_magic", "<buffer>", buildDiagnostic(head),
    );
  }
}

/** Predicate form of validateMediaBytes. */
export function isValidMediaBytes(bytes: Uint8Array | Buffer, kind: MediaKind): boolean {
  try {
    validateMediaBytes(bytes, kind);
    return true;
  } catch {
    return false;
  }
}
