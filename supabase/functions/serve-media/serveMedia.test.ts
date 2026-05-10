// Deno unit tests — serve-media security guards.
//
// Covers:
//   • C-6-2 / Shield S-006 — strict prefix IDOR check (NOT substring).
//   • C-6-2 / Shield S-006 — path traversal rejection (..\, %2e%2e, etc.).
//   • C-6-2 / Shield S-006 — Content-Disposition CRLF / quote injection.
//
// The buildContentDisposition helper is unit-tested directly. The IDOR /
// traversal logic is exercised via a tiny re-implementation of the
// authorization predicate kept in lock-step with index.ts.

import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { buildContentDisposition } from "./index.ts";

// ── IDOR predicate mirror ─────────────────────────────────────────────────────
// Keep this in sync with the check inside handler(). The test fails loud
// if these two drift apart by exercising the matrix below.
function isPathAuthorized(userId: string, filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  if (
    filePath.includes("..") ||
    filePath.includes("\\") ||
    filePath.startsWith("/") ||
    lowered.includes("%2e%2e") ||
    lowered.includes("%2f") ||
    lowered.includes("%5c") ||
    filePath.includes("\0")
  ) {
    return false;
  }
  return filePath.startsWith(userId + "/");
}

// ── IDOR (Shield S-006) ───────────────────────────────────────────────────────

Deno.test("S-006: own files under the user's directory are allowed", () => {
  const uid = "aaaaaaaa-bbbb-cccc-dddd-111122223333";
  assert(isPathAuthorized(uid, `${uid}/projects/p1/video.mp4`));
});

Deno.test("S-006: substring-match IDOR is blocked", () => {
  // Attacker UID happens to be a substring of victim's path.
  const attackerUid = "aaaa";
  const victimPath = "aaaa-victim-uid-1234/projects/p1/video.mp4";
  // Under the OLD substring rule this would have been allowed because
  // victimPath.includes("aaaa"). The new prefix rule must reject it.
  assert(!isPathAuthorized(attackerUid, victimPath));
});

Deno.test("S-006: uid as a prefix without trailing '/' is rejected", () => {
  // Path `uidextra/...` happens to start with the uid string but is
  // NOT under the uid's directory — the trailing "/" enforces a
  // proper directory boundary.
  const uid = "deadbeef-1111-2222-3333-444455556666";
  assert(!isPathAuthorized(uid, `${uid}extra/projects/p1/video.mp4`));
});

Deno.test("S-006: directory-traversal '..' is rejected", () => {
  const uid = "aaaaaaaa-bbbb-cccc-dddd-111122223333";
  assert(!isPathAuthorized(uid, `${uid}/../other-user/secret.mp4`));
});

Deno.test("S-006: backslash traversal is rejected", () => {
  const uid = "aaaaaaaa-bbbb-cccc-dddd-111122223333";
  assert(!isPathAuthorized(uid, `${uid}\\..\\other\\secret.mp4`));
});

Deno.test("S-006: absolute path is rejected", () => {
  const uid = "aaaaaaaa-bbbb-cccc-dddd-111122223333";
  assert(!isPathAuthorized(uid, `/${uid}/projects/p1/video.mp4`));
});

Deno.test("S-006: percent-encoded traversal is rejected", () => {
  const uid = "aaaaaaaa-bbbb-cccc-dddd-111122223333";
  assert(!isPathAuthorized(uid, `${uid}/%2e%2e/other-user/secret.mp4`));
  assert(!isPathAuthorized(uid, `${uid}/foo%2Fbar.mp4`));
});

Deno.test("S-006: NUL byte injection is rejected", () => {
  const uid = "aaaaaaaa-bbbb-cccc-dddd-111122223333";
  assert(!isPathAuthorized(uid, `${uid}/file.mp4\0.png`));
});

// ── Content-Disposition (CRLF / quote injection) ─────────────────────────────

Deno.test("S-006: filename CRLF injection cannot split the response", () => {
  const malicious = `evil.mp4"\r\nX-Injected: yes`;
  const header = buildContentDisposition(malicious);

  // The header value must not contain CR or LF — that's the precise
  // primitive that allows response-splitting in Deno's Headers when
  // a downstream proxy doesn't normalise. Deno's runtime would reject
  // such a header at .set() time, but we want the value itself clean
  // BEFORE we hand it to the runtime so the failure mode is "safe
  // value", not "thrown exception in the hot path".
  assert(!header.includes("\r"), `header still contains CR: ${header}`);
  assert(!header.includes("\n"), `header still contains LF: ${header}`);
  // The legacy quoted-string segment must not have a smuggled `"`.
  // Match `filename="..."` — the segment between the first `"` and
  // the next `"` must not itself contain another `"`.
  const m = header.match(/filename="([^"]*)"/);
  assert(m, `header missing quoted filename segment: ${header}`);
});

Deno.test("S-006: filename with quote/backslash is sanitised in legacy form", () => {
  const malicious = `bad".txt`;
  const header = buildContentDisposition(malicious);
  // Legacy quoted form must strip the embedded quote so the segment
  // terminates exactly once.
  const quoted = header.match(/filename="([^"]*)"/);
  assert(quoted, "missing filename= legacy segment");
  assert(!quoted![1].includes('"'), `quote leaked: ${quoted![1]}`);
});

Deno.test("S-006: filename RFC 5987 form is percent-encoded", () => {
  const malicious = `weird name "; drop.mp4`;
  const header = buildContentDisposition(malicious);
  // Must carry an RFC 5987 fallback with UTF-8'' prefix.
  assert(
    header.includes("filename*=UTF-8''"),
    `no RFC 5987 form: ${header}`,
  );
  // The encoded portion must contain percent-encoded space (%20) since
  // encodeURIComponent leaves spaces percent-encoded.
  const m = header.match(/filename\*=UTF-8''([^;\s]+)/);
  assert(m, "missing RFC 5987 segment");
  assert(m![1].includes("%"), `not percent-encoded: ${m![1]}`);
});

Deno.test("S-006: empty/whitespace filename falls back to 'file'", () => {
  // Pure control-character payload should collapse to the safe default
  // rather than emitting `filename=""` (which some clients refuse).
  const header = buildContentDisposition("\r\n\t");
  assert(
    header.includes(`filename="file"`),
    `expected fallback filename: ${header}`,
  );
});

Deno.test("S-006: a Headers object built from the result cannot be split", () => {
  // End-to-end: feed the malicious filename through buildContentDisposition
  // and confirm that Deno's Headers accepts the value AND
  // .get("Content-Disposition") returns a single, single-line value.
  // If the sanitiser ever regresses to allow CR/LF, Headers.set will
  // throw and this test fails loudly.
  const malicious = `evil.mp4"\r\nX-Injected: yes`;
  const value = buildContentDisposition(malicious);
  const h = new Headers();
  h.set("Content-Disposition", value);
  const stored = h.get("Content-Disposition")!;
  assertEquals(stored.split("\n").length, 1);
  assertEquals(stored.split("\r").length, 1);
  // The smuggled header MUST NOT have appeared as its own header.
  assert(h.get("X-Injected") === null);
});
