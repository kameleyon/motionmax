// Tiny static server that mirrors the production CSP from vercel.json so we
// can verify locally that the landing page still works under the same CSP
// constraints as production. Used only for one-off verification — not part
// of the deploy pipeline.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "..", "dist");

// Pulled verbatim from vercel.json -> headers -> Content-Security-Policy.
// If this changes in vercel.json, copy it here.
const PROD_CSP =
  "default-src 'self'; script-src 'self' https://js.stripe.com https://www.googletagmanager.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; " +
  "img-src 'self' data: blob: https://*.supabase.co https://*.replicate.delivery https://replicate.delivery " +
  "https://oaidalleapiprodscus.blob.core.windows.net https://*.googleusercontent.com " +
  "https://pub-d259d1d2737843cb8bcb2b1ff98fc9c6.r2.dev; " +
  "media-src 'self' blob: https://*.supabase.co; " +
  "connect-src 'self' blob: https://*.supabase.co wss://*.supabase.co https://api.replicate.com " +
  "https://api.openai.com https://api.stripe.com https://js.stripe.com https://openrouter.ai " +
  "https://api.hypereal.cloud https://*.google-analytics.com https://*.analytics.google.com " +
  "https://*.googletagmanager.com; " +
  "frame-src https://js.stripe.com https://hooks.stripe.com https://embed.app.guidde.com; " +
  "frame-ancestors 'none'; worker-src 'self' blob:;";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
};

function tryFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  let file = path.join(dist, urlPath);
  if (!tryFile(file) && tryFile(file + "/index.html")) file = file + "/index.html";
  if (!tryFile(file)) {
    res.statusCode = 404;
    res.end("not found: " + urlPath);
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  res.setHeader("Content-Security-Policy", PROD_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.statusCode = 200;
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT) || 5501;
server.listen(port, () => {
  console.log(`prod-CSP static server listening on http://localhost:${port}`);
  console.log(`serving: ${dist}`);
});
