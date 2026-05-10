#!/usr/bin/env node
/**
 * lint-rls-permissive.mjs
 *
 * Atlas F-D9 / C-6-9 regression guard.
 *
 * Scans every supabase/migrations/*.sql for any CREATE POLICY ...
 * USING (true) or WITH CHECK (true) that is grantable to `anon`,
 * `authenticated`, or `public` (i.e. unrestricted role qualifier).
 *
 * Exits non-zero if any are found, with a per-finding report.
 *
 * Allowed exception: USING (true) on a policy scoped to
 * `service_role` ONLY. service_role is a trusted server key that
 * bypasses RLS anyway, so the explicit policy is a defensive
 * fallback in case FORCE ROW LEVEL SECURITY is ever applied.
 *
 * Tolerated patterns (NOT a violation):
 *   CREATE POLICY ... TO service_role ... USING (true)
 *   CREATE POLICY ... USING (auth.uid() = user_id)
 *
 * Violations (FAIL):
 *   CREATE POLICY ... FOR SELECT USING (true);              -- no role
 *   CREATE POLICY ... FOR SELECT TO anon USING (true);      -- anon
 *   CREATE POLICY ... FOR SELECT TO authenticated USING (true);
 *   CREATE POLICY ... FOR SELECT TO public USING (true);
 *
 * Allowlist: if a migration KNOWINGLY ships a permissive policy
 * for some reason, prefix the CREATE POLICY with the marker
 *   -- rls-permissive-lint: allow (reason: ...)
 * on the immediately preceding line. The lint will skip that
 * single policy.
 *
 * BASELINE: this lint was introduced on 2026-05-10 alongside the
 * audit migrations for §6 C-6-5 / C-6-9 / C-6-10. Historical
 * violations in earlier migrations are tracked separately in the
 * audit migrations themselves (the offending policies are either
 * (a) already dropped by a later migration, (b) explicitly dropped
 * by 20260510210000_anon_access_audit.sql, or (c) intentional and
 * documented). To prevent a wall of pre-existing noise from
 * blocking the rollout, the lint by default scans only migrations
 * dated on or after RLS_LINT_BASELINE. Override with the
 * --include-pre-baseline flag to audit the full history.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';

const MIGRATIONS_DIR = 'supabase/migrations';
const ALLOWLIST_MARKER = /--\s*rls-permissive-lint:\s*allow\b/i;

// Cutoff: lint only catches violations introduced by migrations
// timestamped at or after 2026-05-10 (the date this lint was
// added). Earlier violations are already audited / mitigated by
// 20260510210000_anon_access_audit.sql.
const RLS_LINT_BASELINE = '20260510';
const INCLUDE_PRE_BASELINE = process.argv.includes('--include-pre-baseline');

function isInScope(filename) {
  if (INCLUDE_PRE_BASELINE) return true;
  const stem = basename(filename);
  // Migrations are named `YYYYMMDDhhmmss_*.sql`. Compare leading 8 chars.
  return stem.slice(0, 8) >= RLS_LINT_BASELINE;
}

// Match CREATE POLICY statements terminated by a bare ';' at end
// of line (not inside a quoted string — naive but sufficient for
// our hand-written migrations). The `s` (dotAll) flag lets `.`
// span newlines so we can capture multi-line policy bodies.
const POLICY_RE =
  /CREATE\s+POLICY\s+["']?([\w_\- ]+)["']?\s+ON\s+([^\s(;]+)([\s\S]*?);/gi;

function scanFile(path) {
  const src = readFileSync(path, 'utf8');
  const violations = [];

  // Capture line numbers for each match by counting newlines in
  // the prefix; cheap because files are small.
  for (const match of src.matchAll(POLICY_RE)) {
    const policyName = match[1].trim();
    const table = match[2].trim();
    const body = match[3];
    const stmt = match[0];
    const startIdx = match.index;
    const lineNo = src.slice(0, startIdx).split('\n').length;

    // Allowlist: look at the line immediately above the CREATE.
    const prefix = src.slice(0, startIdx);
    const lastNewline = prefix.lastIndexOf('\n');
    const prevLineStart = prefix.lastIndexOf('\n', lastNewline - 1);
    const prevLine = prefix.slice(prevLineStart + 1, lastNewline);
    if (ALLOWLIST_MARKER.test(prevLine)) {
      continue;
    }

    // Extract the TO clause (if any) — captures comma-separated
    // role list up to USING / WITH CHECK / FOR / WITH / end.
    const toMatch = body.match(/\bTO\s+([\s\S]*?)(?:\bUSING\b|\bWITH\s+CHECK\b|\bFOR\b|\bAS\b|$)/i);
    let roles = ['public']; // Postgres default when no TO clause
    if (toMatch) {
      roles = toMatch[1]
        .split(',')
        .map(s => s.trim().replace(/[;"'`]/g, '').toLowerCase())
        .filter(Boolean);
    }

    // Skip if the ONLY role is service_role (explicitly trusted).
    const dangerousRoles = roles.filter(
      r => r === 'anon' || r === 'authenticated' || r === 'public'
    );
    if (dangerousRoles.length === 0) continue;

    // Look for USING (true) or WITH CHECK (true). Allow whitespace
    // and case variation. Reject only literal `true` — `auth.uid()`,
    // `user_id = auth.uid()`, etc. are fine.
    const usingTrue = /\bUSING\s*\(\s*true\s*\)/i.test(body);
    const checkTrue = /\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(body);

    if (usingTrue || checkTrue) {
      violations.push({
        file: path,
        line: lineNo,
        policy: policyName,
        table,
        roles: dangerousRoles,
        kind: [usingTrue && 'USING(true)', checkTrue && 'WITH CHECK(true)']
          .filter(Boolean)
          .join(' + '),
      });
    }
  }
  return violations;
}

function main() {
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => join(MIGRATIONS_DIR, f));
  } catch (err) {
    console.error(`lint-rls-permissive: cannot read ${MIGRATIONS_DIR}: ${err.message}`);
    process.exit(2);
  }

  const inScope = files.filter(isInScope);
  const allViolations = [];
  for (const f of inScope) {
    allViolations.push(...scanFile(f));
  }

  if (allViolations.length === 0) {
    const scopeNote = INCLUDE_PRE_BASELINE
      ? `${files.length} migrations (full history)`
      : `${inScope.length}/${files.length} migrations (>= ${RLS_LINT_BASELINE}; pre-baseline skipped)`;
    console.log(`lint-rls-permissive: OK (scanned ${scopeNote}, 0 violations)`);
    process.exit(0);
  }

  console.error('lint-rls-permissive: FAIL — permissive RLS policies found:\n');
  for (const v of allViolations) {
    console.error(
      `  ${basename(v.file)}:${v.line}  policy="${v.policy}"  table=${v.table}  roles=${v.roles.join(',')}  ${v.kind}`
    );
  }
  console.error(`\nTotal violations: ${allViolations.length}`);
  console.error(
    '\nHow to fix:\n' +
      '  1. Replace USING(true) with a row-scoped expression (e.g. user_id = auth.uid()).\n' +
      '  2. If the policy MUST be permissive (service_role only), add `TO service_role` to the policy.\n' +
      '  3. If permissive is intentional and reviewed, prefix the CREATE POLICY with:\n' +
      '       -- rls-permissive-lint: allow (reason: <why>)\n'
  );
  process.exit(1);
}

main();
