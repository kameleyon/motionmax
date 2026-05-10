/**
 * AES-256-GCM secret encryption for Vercel `api/` functions (Node 20+).
 *
 * Wire format (shared with worker/src/lib/encryption.ts and
 * supabase/functions/_shared/encryption.ts):
 *
 *     v1:<base64-iv>:<base64-ciphertext-with-auth-tag>
 *
 * Reads `process.env.ENCRYPTION_KEY_V1` (base64 of 32 random bytes).
 * Generate with `openssl rand -base64 32`.
 *
 * KEEP THIS FILE IN SYNC with the worker and Edge Function helpers — a
 * value encrypted by any of the three must be decryptable by the other
 * two.  See worker/src/lib/encryption.ts for the canonical comments.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ENV_VAR = 'ENCRYPTION_KEY_V1';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[KEY_ENV_VAR];
  if (!raw || raw.trim() === '') {
    throw new Error(
      `[encryption] ${KEY_ENV_VAR} is not set. Generate one with \`openssl rand -base64 32\` and add it to Vercel project env (encrypted).`
    );
  }
  const bytes = Buffer.from(raw.trim(), 'base64');
  if (bytes.length !== 32) {
    throw new Error(
      `[encryption] ${KEY_ENV_VAR} must decode to exactly 32 bytes (got ${bytes.length}).`
    );
  }
  cachedKey = bytes;
  return cachedKey;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('[encryption] encryptSecret: plaintext must be a non-empty string');
  }
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([ct, tag]).toString('base64');
  return `${VERSION}:${iv.toString('base64')}:${packed}`;
}

export async function decryptSecret(packed: string): Promise<string> {
  if (typeof packed !== 'string' || packed.length === 0) {
    throw new Error('[encryption] decryptSecret: packed must be a non-empty string');
  }
  const parts = packed.split(':');
  if (parts.length !== 3) {
    throw new Error('[encryption] decryptSecret: malformed packed value (expected 3 parts)');
  }
  const [version, ivB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`[encryption] decryptSecret: unsupported version "${version}"`);
  }
  const key = loadKey();
  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error('[encryption] decryptSecret: IV must be 12 bytes');
  }
  const blob = Buffer.from(ctB64, 'base64');
  if (blob.length < TAG_BYTES + 1) {
    throw new Error('[encryption] decryptSecret: ciphertext too short (no auth tag)');
  }
  const ct = blob.subarray(0, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error(
      `[encryption] decryptSecret: AES-GCM decrypt failed (auth tag mismatch or wrong key): ${(e as Error).message}`
    );
  }
}

export function looksEncrypted(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(value);
}
