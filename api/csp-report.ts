/**
 * POST /api/csp-report
 *
 * Receiver for Content-Security-Policy violation reports. The browser POSTs
 * a JSON body when our policy (defined in vercel.json) blocks something —
 * inline script, disallowed connect-src, frame-ancestors violation, etc.
 *
 * What we do with reports:
 *   - Always 204 (the browser does not retry, and we do not want a noisy
 *     log feedback loop on bad parses).
 *   - Forward to Sentry IF SENTRY_CSP_REPORT_DSN is set (Sentry exposes a
 *     dedicated CSP-report ingest endpoint per project: see
 *     https://docs.sentry.io/security-legal-pii/security/security-policy-reporting/).
 *     Otherwise we just `console.warn` so it shows up in Vercel function logs.
 *
 * Wired up via:
 *   vercel.json -> Content-Security-Policy -> "report-uri /api/csp-report"
 *
 * NOTE on `report-uri` vs `report-to`: Chrome >= 96 prefers `Reporting-Endpoints`
 * + `report-to`, but `report-uri` is still the most broadly supported and is
 * what the audit (Shield S-001) explicitly cited as missing. We can layer
 * `report-to` on top later (covered by C-6-6 Critical follow-up).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IncomingMessage, ServerResponse } from "node:http";

const SENTRY_CSP_REPORT_URL = process.env.SENTRY_CSP_REPORT_URL ?? "";

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }

  let raw = "";
  try {
    raw = await readBody(req);
  } catch {
    // Bad request body — silently 204 to avoid a feedback loop.
    res.statusCode = 204;
    res.end();
    return;
  }

  // Best-effort: parse and log a compact summary; never throw to the browser.
  try {
    const body = raw ? JSON.parse(raw) : null;
    const report = (body && (body["csp-report"] ?? body)) as Record<string, unknown> | null;
    if (report) {
      const summary = {
        documentURI: report["document-uri"] ?? report["documentURL"],
        violatedDirective: report["violated-directive"] ?? report["effectiveDirective"],
        blockedURI: report["blocked-uri"] ?? report["blockedURL"],
        sourceFile: report["source-file"] ?? report["sourceFile"],
        lineNumber: report["line-number"] ?? report["lineNumber"],
        columnNumber: report["column-number"] ?? report["columnNumber"],
      };
      // Vercel function logs surface this as a warning — alert noise stays in Sentry.
      console.warn("[CSP] violation:", JSON.stringify(summary));
    }

    if (SENTRY_CSP_REPORT_URL && raw) {
      // Forward verbatim to Sentry's dedicated CSP ingest endpoint.
      void fetch(SENTRY_CSP_REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body: raw,
      }).catch(() => { /* best-effort */ });
    }
  } catch {
    // Malformed report — drop it.
  }

  res.statusCode = 204;
  res.end();
}
