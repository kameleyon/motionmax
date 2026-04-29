/**
 * Adapter that bridges Web-standard handlers (`(req: Request) =>
 * Promise<Response>`) to Vercel's Node.js function signature
 * (`(req: IncomingMessage, res: ServerResponse) => void`).
 *
 * Without this, Vercel's Node runtime invokes the handlers with
 * IncomingMessage and ServerResponse, but our handlers call
 * `req.headers.get(...)` (a Web Headers method that doesn't exist on
 * Node's plain-object headers) — so every function 500s with
 * FUNCTION_INVOCATION_FAILED before its first line of real logic.
 *
 * Wrap the export:
 *   export default webHandler(async (req) => {
 *     const origin = req.headers.get('origin');
 *     // ...
 *     return new Response(...);
 *   });
 *
 * The adapter takes care of:
 *   - Building a Web Request from the Node IncomingMessage (headers,
 *     method, full URL, raw body bytes).
 *   - Reading the Response body, status, and headers and writing them
 *     back through the Node ServerResponse.
 *   - Catching uncaught errors and converting them to 500 JSON.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

type WebHandler = (req: Request) => Promise<Response>;

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function nodeHeadersToWeb(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildUrl(req: IncomingMessage): string {
  const host = (req.headers["x-forwarded-host"] as string)
    || (req.headers.host as string)
    || "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}${req.url || "/"}`;
}

export function webHandler(handler: WebHandler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = await readBody(req);
      const webReq = new Request(buildUrl(req), {
        method: req.method,
        headers: nodeHeadersToWeb(req),
        body: body as BodyInit | undefined,
      });

      const webRes = await handler(webReq);

      res.statusCode = webRes.status;
      webRes.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      // Stream the response body back. arrayBuffer() handles both text
      // and binary cleanly; Response.redirect() returns a body-less
      // response and arrayBuffer() returns an empty buffer there.
      const buf = Buffer.from(await webRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      // Supabase / pg / Stripe etc. throw plain objects with a `.message`
      // field but are NOT Error instances, so `String(err)` would yield
      // the unhelpful "[object Object]". Walk the common shapes first.
      let message = "unknown error";
      if (err instanceof Error) {
        message = err.message;
      } else if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        if (typeof e.message === "string") message = e.message;
        else if (typeof e.error === "string") message = e.error;
        else if (typeof e.code === "string") message = e.code;
        else {
          try { message = JSON.stringify(err); } catch { message = String(err); }
        }
      } else if (err !== undefined && err !== null) {
        message = String(err);
      }
      console.error(JSON.stringify({
        at: "webHandler.uncaught",
        err: message,
        raw: err && typeof err === "object" ? Object.keys(err) : undefined,
        stack: err instanceof Error ? err.stack : undefined,
      }));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "internal_error", message }));
      } else {
        res.end();
      }
    }
  };
}
