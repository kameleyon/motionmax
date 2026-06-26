/**
 * C2PA Content Credentials signing — SCAFFOLD (FLAGGED: needs-cert).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * STATUS: NO-OP until a signing certificate is provisioned.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * C2PA (https://c2pa.org) embeds a cryptographically signed manifest into the
 * MP4 ("Content Credentials") that records the asset's AI-generated origin and
 * provenance chain. It is the gold-standard, tamper-evident complement to the
 * XMP metadata we already write in `embedXmpProvenance` (exportVideo.ts).
 *
 * This module is an intentionally inert scaffold. Real signing requires BOTH of:
 *
 *   1. A provisioned signing certificate + private key (an X.509 cert chain
 *      issued for content provenance, e.g. from a CA on the C2PA trust list).
 *      Wired here via env: C2PA_CERT_PATH (PEM cert chain) and
 *      C2PA_PRIVATE_KEY (or C2PA_PRIVATE_KEY_PATH).
 *
 *   2. The `c2pa-node` toolchain (https://github.com/contentauth/c2pa-node) or
 *      the `c2patool` binary. DELIBERATELY NOT added as a dependency in this
 *      scaffold — pulling in the native toolchain is a separate, gated step so
 *      the worker build stays unchanged until signing is actually armed.
 *
 * Until a cert is configured, `signC2PA` is a NO-OP that returns
 * `{ signed: false, reason: 'no_cert' }` and NEVER throws — even for API jobs.
 *
 * IMPORTANT — provenance posture: C2PA is *additive*. The mandatory,
 * machine-readable disclosure for API jobs (/api/v1) is the XMP metadata
 * embedded by `embedXmpProvenance`, which re-throws on failure so a
 * non-compliant API asset is never shipped. C2PA strengthens that posture once
 * a cert exists but is never itself a hard gate — a missing/failed signature
 * must not fail an export.
 *
 * Mirrors the `isApiJob` split shape of `embedXmpProvenance` purely so future
 * signing logic (e.g. stricter assertions or logging on API jobs) has the flag
 * available; in the current NO-OP path the result is identical for both.
 *
 * To arm signing later:
 *   1. `npm i c2pa-node` (or install `c2patool` on the worker image).
 *   2. Set C2PA_CERT_PATH + C2PA_PRIVATE_KEY (or C2PA_PRIVATE_KEY_PATH).
 *   3. Replace the flagged TODO block below with a real
 *      `createC2pa().sign(...)` call that writes a signed manifest into the MP4.
 */

import fs from "fs";
import { wlog } from "../../lib/workerLogger.js";

export interface SignC2PAOptions {
  /** True for /api/v1-originated jobs. Mirrors embedXmpProvenance's split. */
  isApiJob: boolean;
}

export interface SignC2PAResult {
  /** Whether a signed C2PA manifest was embedded. */
  signed: boolean;
  /**
   * Machine-readable reason when `signed` is false. `'no_cert'` is the
   * expected steady-state value until a signing certificate is provisioned.
   */
  reason?: string;
}

/**
 * Resolve the configured signing certificate material from the environment.
 * Returns null when no cert is configured (the steady-state NO-OP condition).
 */
function resolveSigningCert(): { certPath: string; privateKey: string } | null {
  const certPath = process.env.C2PA_CERT_PATH?.trim();
  const inlineKey = process.env.C2PA_PRIVATE_KEY?.trim();
  const keyPath = process.env.C2PA_PRIVATE_KEY_PATH?.trim();

  if (!certPath) return null;

  let privateKey: string | undefined = inlineKey;
  if (!privateKey && keyPath) {
    try {
      privateKey = fs.readFileSync(keyPath, "utf8").trim();
    } catch {
      return null;
    }
  }
  if (!privateKey) return null;
  if (!fs.existsSync(certPath)) return null;

  return { certPath, privateKey };
}

/**
 * Sign the given MP4 with a C2PA Content Credentials manifest.
 *
 * SCAFFOLD: currently a NO-OP whenever no signing cert is configured (the
 * steady state). Returns `{ signed: false, reason: 'no_cert' }` and never
 * throws — C2PA is additive provenance and must never fail an export.
 *
 * @param filePath  Absolute path to the final MP4 to sign in-place.
 * @param opts      `{ isApiJob }` — mirrors embedXmpProvenance's split.
 */
export async function signC2PA(
  filePath: string,
  opts: SignC2PAOptions,
): Promise<SignC2PAResult> {
  const cert = resolveSigningCert();

  if (!cert) {
    // Steady-state NO-OP: no certificate provisioned. XMP provenance (written
    // by embedXmpProvenance) remains the mandatory machine-readable disclosure;
    // C2PA is additive and simply absent here. Do NOT throw, even for API jobs.
    wlog.debug("C2PA signing skipped — no certificate configured (no-op)", {
      filePath,
      isApiJob: opts.isApiJob,
    });
    return { signed: false, reason: "no_cert" };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TODO(needs-cert): real signing path. Requires the c2pa-node toolchain and
  // the provisioned cert in `cert`. Intentionally not implemented in this
  // scaffold so the worker build carries no native C2PA dependency. When armed,
  // build a manifest asserting `c2pa.ai_generative_training` / a
  // `com.motionmax.ai_generated` assertion and embed it into `filePath`.
  //
  //   const { createC2pa, ManifestBuilder } = await import("c2pa-node");
  //   const c2pa = createC2pa({ signer: { ... using cert.certPath / cert.privateKey ... } });
  //   const manifest = new ManifestBuilder({ claim_generator: "motionmax", assertions: [ ... ] });
  //   await c2pa.sign({ file: { path: filePath, mimeType: "video/mp4" }, manifest });
  //
  // Best-effort: any failure here must be caught and downgraded to
  // `{ signed: false, reason: 'sign_failed' }` — never rethrown.
  // ──────────────────────────────────────────────────────────────────────────
  wlog.warn(
    "C2PA certificate configured but signing toolchain not armed — returning no-op",
    { filePath, isApiJob: opts.isApiJob },
  );
  return { signed: false, reason: "toolchain_unavailable" };
}
