/**
 * AES-256-GCM secret encryption (Deno / Edge Functions runtime).
 *
 * Wire format
 * -----------
 * Every encrypted value is stored as a single ASCII string of the form
 *
 *     v1:<base64-iv>:<base64-ciphertext-with-auth-tag>
 *
 *   * `v1` is the format version. Future revisions (e.g. `v2`) can change
 *     the IV size, KDF, or cipher without breaking existing rows.
 *   * `<base64-iv>` is a 12-byte nonce, base64-encoded (16 chars).
 *   * `<base64-ciphertext-with-auth-tag>` is the AES-256-GCM ciphertext
 *     concatenated with the 16-byte GCM auth tag (Web Crypto's encrypt()
 *     returns these joined automatically), base64-encoded.
 *
 * The Node helper at `worker/src/lib/encryption.ts` reads and writes the
 * exact same wire format, so a value encrypted in an Edge Function can be
 * decrypted by the worker and vice versa. KEEP THE TWO IMPLEMENTATIONS IN
 * SYNC. If you change one, change the other.
 *
 * Key handling
 * ------------
 * The 32-byte AES key is read from `ENCRYPTION_KEY_V1`, which MUST be a
 * base64-encoded 32-byte (256-bit) value. Generate one with:
 *
 *     openssl rand -base64 32
 *
 * The key is loaded once at module init. If it is missing or not exactly
 * 32 bytes after decoding, this module THROWS at import time so the
 * function fails loudly instead of silently writing plaintext.
 *
 * Threat model note: the auth tag means a flipped bit in the ciphertext
 * raises an exception in `decryptSecret` rather than returning corrupted
 * plaintext.  That is the property the storage-encryption migration
 * relies on.
 */

const KEY_ENV_VAR = "ENCRYPTION_KEY_V1";
const VERSION = "v1";

function loadKeyMaterial(): Uint8Array {
  const raw = Deno.env.get(KEY_ENV_VAR);
  if (!raw || raw.trim() === "") {
    throw new Error(
      `[encryption] ${KEY_ENV_VAR} is not set. ` +
        `Generate one with \`openssl rand -base64 32\` and configure it on the project ` +
        `(supabase secrets set ${KEY_ENV_VAR}=...).`
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
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

// Imported once; subsequent encrypt/decrypt calls reuse the CryptoKey.
const KEY_BYTES = loadKeyMaterial();
const KEY_PROMISE: Promise<CryptoKey> = crypto.subtle.importKey(
  "raw",
  KEY_BYTES,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"]
);

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid String.fromCharCode(...bytes) — that blows the call-stack on
  // large inputs. Build the binary string in a chunked loop instead.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encrypt a UTF-8 plaintext string and return the packed wire form
 * `v1:<base64-iv>:<base64-ciphertext>`.
 *
 * Empty/null input is rejected — callers should not write empty rows
 * through this helper. If you need to clear a value, write SQL NULL.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("[encryption] encryptSecret: plaintext must be a non-empty string");
  }
  const key = await KEY_PROMISE;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${VERSION}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`;
}

/**
 * Reverse of `encryptSecret`. Throws if the wire format is malformed,
 * the version is unknown, or the GCM auth tag fails to verify (which
 * means the ciphertext was tampered with or the key is wrong).
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
  const key = await KEY_PROMISE;
  const iv = base64ToBytes(ivB64);
  if (iv.length !== 12) {
    throw new Error("[encryption] decryptSecret: IV must be 12 bytes");
  }
  const ct = base64ToBytes(ctB64);
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch (e) {
    throw new Error(
      `[encryption] decryptSecret: AES-GCM decrypt failed (auth tag mismatch or wrong key): ${(e as Error).message}`
    );
  }
  return new TextDecoder().decode(pt);
}

/**
 * Lightweight check: does this value look like an already-packed v1
 * ciphertext string? Used by callers that may need to migrate plaintext
 * rows lazily on read. NOT a security check — the regex matches any
 * `v1:base64:base64` shape without verifying the auth tag.
 */
export function looksEncrypted(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(value);
}
