# Phase 19.3 — performance verification procedures

The Phase 19.3 quality gates need a browser to actually verify. This doc gives you the one-command-or-click procedure for each.

## 1. Lighthouse score on `/admin` ≥ 90 perf, ≥ 95 a11y

**One-command run:**

```bash
# Make sure the dev server is up first.
npm run dev          # in one terminal
# Then in another:
npx lhci autorun --config=./lighthouserc.cjs
```

The CI config at `lighthouserc.cjs` enforces the spec gates:

| Audit | Threshold |
|---|---|
| `categories:performance` | ≥ 0.90 |
| `categories:accessibility` | ≥ 0.95 |
| `interactive` (TTI) | ≤ 1500 ms |
| `categories:best-practices` | ≥ 0.90 (warn-only) |

Reports land in `.lighthouseci/`.

**Caveat for `/admin` specifically:** Lighthouse runs unauthenticated by default. Because `AdminRoute` redirects non-admins, the unauth'd Lighthouse runner will land on the access-denied screen, not the admin shell. Two ways around:

- **Run against a deployed preview** with the admin session cookie pre-set in the Lighthouse `extraHeaders` config.
- **Use a Puppeteer pre-auth script** (`puppeteerScript` field in the Lighthouse config) that logs in before each audit.

The simplest first run: temporarily add a feature flag bypass for the admin gate in dev only, run Lighthouse, then revert. Honor the gate in production.

## 2. React Profiler — no tab renders > 5 ms commit time

**Procedure:**

1. Build the app in production mode (`npm run build`) or use the dev server with the React DevTools `Profiler` enabled.
2. Open `/admin` in Chrome with React DevTools installed.
3. Switch to the **Profiler** tab in DevTools.
4. Click **Record**.
5. Tab through all 15 admin tabs in order (Overview → Analytics → ... → Kill switches).
6. Click **Stop**.
7. Sort the flamegraph by "Render duration" — none of the top frames should exceed 5 ms.

**Data-set caveat:** the spec says "data-set-sized payloads (1k users, 500 messages, 1k notifications)". If the dev/staging DB is sparse, the commit times will be artificially low. Either:

- Seed the DB with the target data shapes, or
- Run against production (with read-only profiling — don't trigger any writes).

**Common offenders if a tab fails the 5ms gate:**
- A `useMemo` whose deps array includes an object literal (re-creates every render).
- A `.map()` over a large array without virtualization. `TabConsole` already uses `@tanstack/react-virtual` (commit `61dfb73`); other large-list tabs may need the same treatment.
- A heavy chart re-render on each tab switch — confirm the chart wrapper memoizes its data prop.

## 3. Realtime: Console sustains 100 logs/sec for 60 s

**One-command load test:**

```bash
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key> \
RATE=100 DURATION=60 \
npx tsx scripts/console-sustain-test.ts
```

The script inserts synthetic `system_logs` rows at the target rate. While it runs, open `/admin?tab=console&live=1` in a browser and watch:

1. **No visible freeze.** The live tail keeps rendering new rows in real time.
2. **No dropped rows.** Use the test_run_id printed by the script to verify all inserted rows are present:
   ```sql
   SELECT COUNT(*) FROM public.system_logs
    WHERE details->>'test_run_id' = '<test_run_id>';
   ```
   Should equal `RATE * DURATION` = 6000 by default.
3. **Browser stays responsive.** DevTools Performance tab shows commit times < 16 ms (60 fps).

**Cleanup after the test:**

```sql
DELETE FROM public.system_logs
 WHERE category = 'console_sustain_test'
   AND details->>'test_run_id' = '<test_run_id>';
```

The script prints the cleanup query with the run's UUID at the end.

**What failure looks like + how to fix:**

| Symptom | Likely cause |
|---|---|
| Live tail visibly freezes | The realtime channel buffer is overrun — try reducing the BUFFER_CAP in `TabConsole.tsx` from 500 to 200 |
| Dropped rows in DB count | Rate-limit on the admin client's realtime channel — bump the channel's `max_messages_per_second` setting |
| Browser CPU pegs | Virtualization isn't kicking in — confirm `useVirtualizer` is rendering only ~20 rows; if not, check the `count` and `getScrollElement` props |
| Worker memory grows unbounded | Worker's own log buffer leak — check the per-process `_promptCache` or any other in-process Map |

## 4. Time-to-Interactive on Overview ≤ 1.5 s p95 on 4G

This is folded into the Lighthouse run above (the `interactive` audit). The `lighthouserc.cjs` config explicitly throttles to 4G-equivalent latency + bandwidth. The 1500 ms threshold is enforced as an `error` gate.

If the gate fails:
- Run with `--collect.numberOfRuns=10` and inspect the variance — TTI is noisy.
- Profile with `lhci collect --collect.url=/admin --collect.psiStrategy=mobile` to get the raw breakdown.
- Common fix: lazy-load any tab content the Overview shouldn't be paying for. The lazy-load already lands per `Admin.tsx:23-107` — verify with `npx vite-bundle-visualizer` that the Overview chunk is under ~80 KB gzipped.
