/**
 * Signed OAuth state tokens, HMAC-SHA256, base64url-encoded.
 *
 * Format: `<payloadB64Url>.<sigB64Url>`
 *   payload = JSON {userId, platform, nonce, exp}  (exp = unix-ms epoch)
 *   sig     = HMAC_SHA256(OAUTH_STATE_SECRET, payloadB64Url)
 *
 * TTL: 10 minutes. We do NOT persist state in the DB — the signature alone
 * proves provenance. The 10-minute window is short enough that a leaked URL
 * has marginal value.
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`) so this works under Node 20+
 * on Vercel Fluid Compute without pulling in the full `crypto` module API.
 */

export type StatePayload = {
  userId: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  nonce: string;
  /** Unix-ms epoch at which the token expires (issuedAt + 10m). */
  exp: number;
};

const TTL_MS = 10 * 60 * 1000;

function getSecret(): string {
  const s = process.env.OAUTH_STATE_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'OAUTH_STATE_SECRET env var must be set and at least 32 characters. ' +
        'Generate with `openssl rand -hex 32`.'
    );
  }
  return s;
}

function b64UrlEncode(buf: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof buf === 'string') {
    bytes = new TextEncoder().encode(buf);
  } else if (buf instanceof Uint8Array) {
    bytes = buf;
  } else {
    bytes = new Uint8Array(buf);
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return Buffer.from(binary, 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64UrlDecodeToString(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function b64UrlDecodeToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice((s.length + 3) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i]! ^ b[i]!);
  }
  return diff === 0;
}

export function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return b64UrlEncode(arr);
}

export async function signState(
  payload: Omit<StatePayload, 'exp' | 'nonce'> & Partial<Pick<StatePayload, 'exp' | 'nonce'>>
): Promise<string> {
  const full: StatePayload = {
    userId: payload.userId,
    platform: payload.platform,
    nonce: payload.nonce ?? generateNonce(),
    exp: payload.exp ?? Date.now() + TTL_MS,
  };
  const json = JSON.stringify(full);
  const payloadB64 = b64UrlEncode(json);
  const key = await importKey(getSecret());
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const sigB64 = b64UrlEncode(sigBuf);
  return `${payloadB64}.${sigB64}`;
}

export type VerifyOk = { ok: true; payload: StatePayload };
export type VerifyErr = { ok: false; reason: 'malformed' | 'bad_sig' | 'expired' | 'parse_error' };

export async function verifyState(token: string | null | undefined): Promise<VerifyOk | VerifyErr> {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts as [string, string];

  const key = await importKey(getSecret());
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  );
  const provided = b64UrlDecodeToBytes(sigB64);
  if (!timingSafeEqual(expected, provided)) return { ok: false, reason: 'bad_sig' };

  let payload: StatePayload;
  try {
    payload = JSON.parse(b64UrlDecodeToString(payloadB64));
  } catch {
    return { ok: false, reason: 'parse_error' };
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.userId !== 'string' ||
    typeof payload.platform !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'parse_error' };
  }

  if (Date.now() > payload.exp) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}
