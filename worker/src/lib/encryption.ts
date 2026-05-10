/**
 * AES-256-GCM secret encryption (Node 20+ runtime, used by the Render worker
 * and the api/ Vercel functions).
 *
 * Wire format
 * -----------
 * Every encrypted value is stored as a single ASCII string of the form
 *
 *     v1:<base64-iv>:<base64-ciphertext-with-auth-tag>
 *
 *   * `v1` is the format version. Future revisions can change the IV
 *     size, KDF, or cipher without breaking existing rows.
 *   * `<base64-iv>` is a 12-byte nonce, base64-encoded.
 *   * `<base64-ciphertext-with-auth-tag>` is the AES-256-GCM ciphertext
 *     concatenated with the 16-byte GCM auth tag, base64-encoded.
 *
 * The Deno helper at `supabase/functions/_shared/encryption.ts` reads and
 * writes the EXACT same wire format, so a value written by the worker can
 * be read by an Edge Function and vice versa. KEEP THE TWO IMPLEMENTATIONS
 * IN SYNC. If you change one, change the other.
 *
 * Key handling
 * ------------
 * The 32-byte AES key is read from `process.env.ENCRYPTION_KEY_V1`, which
 * MUST be a base64-encoded 32-byte (256-bit) value. Generate one with:
 *
 *     openssl rand -base64 32
 *
 * The key is loaded once at module init. If it is missing or not exactly
 * 32 bytes after decoding, this module THROWS at import time so the
 * worker fails loudly instead of silently writing plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ENV_VAR = "ENCRYPTION_KEY_V1";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKeyMaterial(): Buffer {
  const raw = process.env[KEY_ENV_VAR];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `[encryption] ${KEY_ENV_VAR} is not set. ` +
        `Generate one with \`openssl rand -base64 32\` and configure it on the worker host.`
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw.trim(), "base64");
  } catch (e) {
    throw new Error(
      `[encryption] ${KEY_ENV_VAR} is not valid base64: ${(e as Error).message}`
    );
  }
  if (bytes.length !== 32) {
    throw new Error(
      `[encryption] ${KEY_ENV_VAR} must decode to exactly 32 bytes (got ${bytes.length}). ` +
        `Generate with \`openssl rand -base64 32\`.`
    );
  }
  return bytes;
}

const KEY_BYTES = loadKeyMaterial();

/**
 * Encrypt a UTF-8 plaintext string and return the packed wire form
 * `v1:<base64-iv>:<base64-ciphertext>`.
 *
 * Empty input is rejected — callers should not write empty rows through
 * this helper. If you need to clear a value, write SQL NULL.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("[encryption] encryptSecret: plaintext must be a non-empty string");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", KEY_BYTES, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Match Web Crypto's format: ciphertext || authTag, base64-encoded.
  const packed = Buffer.concat([ct, tag]).toString("base64");
  return `${VERSION}:${iv.toString("base64")}:${packed}`;
}

/**
 * Reverse of `encryptSecret`. Throws if the wire format is malformed, the
 * version is unknown, or the GCM auth tag fails to verify (which means
 * the ciphertext was tampered with or the key is wrong).
 */
export async function decryptSecret(packed: string): Promise<string> {
  if (typeof packed !== "string" || packed.length === 0) {
    throw new Error("[encryption] decryptSecret: packed must be a non-empty string");
  }
  const parts = packed.split(":");
  if (parts.length !== 3) {
    throw new Error("[encryption] decryptSecret: malformed packed value (expected 3 parts)");
  }
  const [version, ivB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`[encryption] decryptSecret: unsupported version "${version}"`);
  }
  const iv = Buffer.from(ivB64, "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("[encryption] decryptSecret: IV must be 12 bytes");
  }
  const blob = Buffer.from(ctB64, "base64");
  if (blob.length < TAG_BYTES + 1) {
    throw new Error("[encryption] decryptSecret: ciphertext too short (no auth tag)");
  }
  // Web Crypto returns ciphertext || authTag; split them back apart for
  // node:crypto's GCM API.
  const ct = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", KEY_BYTES, iv);
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    throw new Error(
      `[encryption] decryptSecret: AES-GCM decrypt failed (auth tag mismatch or wrong key): ${(e as Error).message}`
    );
  }
  return pt.toString("utf8");
}

/**
 * Lightweight check: does this value look like an already-packed v1
 * ciphertext string? Used by callers that may need to handle a
 * mid-migration mix of plaintext and ciphertext rows. NOT a security
 * check — the regex matches any `v1:base64:base64` shape without
 * verifying the auth tag.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(value);
}
