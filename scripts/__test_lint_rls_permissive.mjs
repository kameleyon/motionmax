#!/usr/bin/env node
/**
 * Quick smoke test for lint-rls-permissive.mjs.
 *
 * Writes a synthetic fixture into a temp dir, runs the lint
 * against it, and asserts that it reports exactly the expected
 * violation set.
 *
 * Run: node scripts/__test_lint_rls_permissive.mjs
 *
 * Not wired into CI because the production CI already runs the
 * real lint against the migrations dir — this test is for local
 * verification when editing the lint itself.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const fixture = `
-- VIOLATION 1
CREATE POLICY "bad_open_select" ON public.foo FOR SELECT TO anon USING (true);

-- VIOLATION 2
CREATE POLICY "bad_open_insert" ON public.foo FOR INSERT TO authenticated WITH CHECK (true);

-- VIOLATION 3 (no TO clause => defaults to PUBLIC)
CREATE POLICY "bad_no_to_clause" ON public.foo FOR SELECT USING (true);

-- OK: service_role only
CREATE POLICY "ok_svc" ON public.foo FOR ALL TO service_role USING (true);

-- OK: row-scoped expression
CREATE POLICY "ok_owner" ON public.foo FOR SELECT TO authenticated USING (user_id = auth.uid());

-- OK: allowlisted with the marker
-- rls-permissive-lint: allow (reason: anon needs to read public referral codes)
CREATE POLICY "ok_allowlisted" ON public.foo FOR SELECT TO anon USING (true);
`;

const tmp = mkdtempSync(join(tmpdir(), 'rls-lint-test-'));
const migrationsDir = join(tmp, 'supabase', 'migrations');
mkdirSync(migrationsDir, { recursive: true });
// Filename dated >= baseline so the lint examines it.
const file = join(migrationsDir, '20260510000000_fixture.sql');
writeFileSync(file, fixture);

let stdout = '';
let exitCode = 0;
try {
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'lint-rls-permissive.mjs')],
    { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (e) {
  stdout = (e.stdout || '') + (e.stderr || '');
  exitCode = e.status ?? 1;
}

const expectViolations = ['bad_open_select', 'bad_open_insert', 'bad_no_to_clause'];
const unexpect = ['ok_svc', 'ok_owner', 'ok_allowlisted'];

let pass = true;
if (exitCode !== 1) {
  console.error(`FAIL: expected exit code 1, got ${exitCode}`);
  console.error(stdout);
  pass = false;
}
for (const name of expectViolations) {
  if (!stdout.includes(`"${name}"`)) {
    console.error(`FAIL: expected violation "${name}" not reported`);
    pass = false;
  }
}
for (const name of unexpect) {
  if (stdout.includes(`"${name}"`)) {
    console.error(`FAIL: unexpected violation "${name}" reported`);
    pass = false;
  }
}

rmSync(tmp, { recursive: true, force: true });

if (pass) {
  console.log('OK: lint-rls-permissive passes smoke test (3 expected violations, 3 valid policies accepted)');
  process.exit(0);
} else {
  process.exit(1);
}
