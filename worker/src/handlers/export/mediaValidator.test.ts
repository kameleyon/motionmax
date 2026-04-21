/**
 * Sanity tests for mediaValidator. Run with:
 *   npx tsx worker/src/handlers/export/mediaValidator.test.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { validateMedia, MediaValidationError } from "./mediaValidator.js";

let passed = 0;
let failed = 0;

async function t(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${(err as Error).message}`);
    failed++;
  }
}

function tmpFile(bytes: Buffer): string {
  const p = path.join(os.tmpdir(), `mv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(p, bytes);
  return p;
}

async function expectThrows(fn: () => Promise<void>, reasonPattern?: RegExp): Promise<MediaValidationError> {
  try {
    await fn();
    throw new Error("expected validateMedia to throw, but it resolved");
  } catch (err) {
    if (!(err instanceof MediaValidationError)) throw err;
    if (reasonPattern && !reasonPattern.test(err.reason)) {
      throw new Error(`expected reason to match ${reasonPattern}, got ${err.reason}`);
    }
    return err;
  }
}

await t("valid MP3 with ID3v2 tag passes audio check", async () => {
  // ID3 header + padding to pass size check
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(400)]));
  await validateMedia(file, "audio");
});

await t("valid MP3 frame sync passes audio check", async () => {
  const head = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(400)]));
  await validateMedia(file, "audio");
});

await t("valid WAV (RIFF+WAVE) passes audio check", async () => {
  const head = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WAVE"),
  ]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(400)]));
  await validateMedia(file, "audio");
});

await t("HTML error page rejected as audio", async () => {
  const file = tmpFile(Buffer.from("<html><body>403 Forbidden</body></html>".padEnd(500)));
  const err = await expectThrows(() => validateMedia(file, "audio"), /bad_magic/);
  if (!err.diagnostic?.includes("html")) throw new Error(`diagnostic should mention html: ${err.diagnostic}`);
});

await t("JSON error body rejected as audio", async () => {
  const file = tmpFile(Buffer.from(JSON.stringify({ error: "Object not found" }).padEnd(500)));
  await expectThrows(() => validateMedia(file, "audio"), /bad_magic/);
});

await t("empty file rejected as audio", async () => {
  const file = tmpFile(Buffer.alloc(0));
  await expectThrows(() => validateMedia(file, "audio"), /empty/);
});

await t("too-small file rejected as audio", async () => {
  const file = tmpFile(Buffer.from([0x49, 0x44, 0x33])); // 3 bytes — real ID3 but too small
  await expectThrows(() => validateMedia(file, "audio"), /too_small/);
});

await t("valid PNG passes image check", async () => {
  const head = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(200)]));
  await validateMedia(file, "image");
});

await t("valid JPEG passes image check", async () => {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(200)]));
  await validateMedia(file, "image");
});

await t("HTML rejected as image", async () => {
  const file = tmpFile(Buffer.from("<!DOCTYPE html>".padEnd(300)));
  await expectThrows(() => validateMedia(file, "image"), /bad_magic/);
});

await t("valid MP4 (ftyp box) passes video check", async () => {
  // 4-byte size + "ftyp" + "isom" + minor version + brand list
  const head = Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from("ftyp"),
    Buffer.from("isom"),
    Buffer.from([0, 0, 0, 0x01]),
    Buffer.from("mp41"),
  ]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(2000)]));
  await validateMedia(file, "video");
});

await t("WebM (EBML header) passes video check", async () => {
  const head = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
  const file = tmpFile(Buffer.concat([head, Buffer.alloc(2000)]));
  await validateMedia(file, "video");
});

await t("ffmpeg-confusing garbage rejected as audio", async () => {
  // This is roughly the shape ffmpeg saw: "low score of 1, misdetection possible"
  // — mostly zeros with occasional bytes that look MP3-ish but aren't.
  const bad = Buffer.alloc(500);
  bad[100] = 0xFF; // looks sort of like an MP3 frame sync but at wrong offset
  bad[101] = 0x10; // wrong top bits (not 0xE*)
  const file = tmpFile(bad);
  await expectThrows(() => validateMedia(file, "audio"), /bad_magic/);
});

await t("UTF-16 LE text rejected as audio bytes (real prod failure)", async () => {
  // Exact pattern from the production failure: 2f 00 2f 00 30 00 ...
  // which is UTF-16 LE "/" "/" "0" ... — not audio.
  const { validateMediaBytes } = await import("./mediaValidator.js");
  const bytes = Buffer.alloc(500);
  const pattern = [0x2f, 0x00, 0x2f, 0x00, 0x30, 0x00, 0x2d, 0x00, 0x30, 0x00, 0x2e, 0x00];
  for (let i = 0; i < pattern.length; i++) bytes[i] = pattern[i];
  let caught: MediaValidationError | null = null;
  try { validateMediaBytes(bytes, "audio"); } catch (e) { caught = e as MediaValidationError; }
  if (!caught) throw new Error("should have thrown");
  if (caught.reason !== "bad_magic") throw new Error(`wrong reason: ${caught.reason}`);
});

await t("validateMediaBytes passes real MP3 bytes", async () => {
  const { validateMediaBytes } = await import("./mediaValidator.js");
  const bytes = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x04]),
    Buffer.alloc(400),
  ]);
  validateMediaBytes(bytes, "audio"); // should not throw
});

await t("validateMediaBytes rejects empty buffer", async () => {
  const { validateMediaBytes } = await import("./mediaValidator.js");
  let caught: MediaValidationError | null = null;
  try { validateMediaBytes(Buffer.alloc(0), "audio"); } catch (e) { caught = e as MediaValidationError; }
  if (!caught || caught.reason !== "empty") throw new Error(`expected empty error, got ${caught?.reason}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
