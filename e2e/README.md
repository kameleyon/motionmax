# MotionMax E2E Tests

Playwright tests for the user-facing flows: auth, generation, admin.

## Quick start

```bash
# Install Playwright browsers (one-time)
npx playwright install chromium webkit

# Boot a local Supabase stack (one-time per machine; requires Docker)
supabase start --no-studio

# Run all E2E tests across the full device matrix (auto-starts vite on :8080)
npm run test:e2e

# Open the Playwright UI runner (interactive)
npm run test:e2e:ui
```

The Playwright config at the repo root (`playwright.config.ts`) starts
`npm run dev` automatically — you do **not** need a separate `vite` process
running.

## Device matrix (C-10-1)

Every spec runs against four projects by default. The motionmax UI has
eight explicit mobile breakpoints + 60 %+ mobile traffic in production,
so the E2E pipeline exercises both desktop and mobile/tablet viewports.

| Project          | Device emulation     | Engine            | Notes                            |
| ---------------- | -------------------- | ----------------- | -------------------------------- |
| `chromium`       | Desktop Chrome       | Chromium          | Fastest; default for local dev   |
| `mobile-chrome`  | Pixel 5              | Chromium (mobile) | Touch + Chrome-Android quirks    |
| `mobile-safari`  | iPhone 13            | WebKit            | iOS Safari rendering & gestures  |
| `tablet`         | iPad (gen 7)         | WebKit            | md → lg breakpoint coverage      |

### Running a single device

```bash
# Only the mobile-chrome project
npx playwright test --project=mobile-chrome

# Only desktop (the fastest pre-commit smoke)
npx playwright test --project=chromium

# Only the mobile pair (chrome + safari)
npx playwright test --project=mobile-chrome --project=mobile-safari

# Re-run a single failing spec on every project
npx playwright test e2e/auth.spec.ts
```

### Known mobile-flaky candidates (TODO)

The existing specs were written desktop-first. The following selectors
and patterns are likely to need mobile-aware tweaks; surface a real
failure first, then fix per spec rather than pre-emptively branching:

- `e2e/auth.spec.ts` —
  - `getByRole("link", { name: /sign up/i })` may be inside a hamburger
    on mobile (`md:` shows the inline nav, `<md` collapses to a menu
    trigger). If the test fails on `mobile-chrome` / `mobile-safari`,
    open the burger first.
- `e2e/generate.spec.ts` —
  - "New project" CTA position differs on mobile (FAB vs sidebar).
    The regex `/new project|create project|\+/i` covers both, but the
    selector resolution may pick the wrong one on viewport switch.
  - "Generate" button enabled state assertion (`toBeEnabled`) is OK,
    but mobile keyboards push the button below the fold — add an
    explicit `scrollIntoViewIfNeeded()` if a timeout shows up.
- `e2e/admin.spec.ts` —
  - The admin tab strip uses horizontal-scroll on `<sm` and a sidebar
    on `>=md`. Selectors like `#admin-tabpanel-${tab}` work either way
    but the tab CLICK affordance is different.
  - 19.1.9 / 19.1.11 / 19.1.13 — pause/resume buttons, "send to self"
    chips and dialog overlays sometimes get covered by the mobile
    keyboard. If flake appears, dismiss the on-screen keyboard with
    `page.keyboard.press("Escape")` before clicking.
  - **Hover-state assertions are not mobile-safe** — there are none
    in the current specs (good), but be aware as new tests land:
    use tap/focus instead of hover when targeting mobile.

When a spec is genuinely incompatible with mobile, prefer
`test.skip(({ isMobile }) => isMobile, "desktop-only flow")` over
splitting the spec — keeps the matrix readable.

## Test-Supabase isolation

E2E tests MUST NEVER hit the production Supabase project. Signing up real
test users to the prod backend pollutes auth, fills `deletion_requests`,
and risks rate-limiting prod for real users.

We support two isolation modes, selected via `TEST_SUPABASE_MODE`:

### Mode 1 — `local` (default; CI default)

A full Supabase stack runs on the test machine via `supabase start`. This
gives every E2E run a fresh, isolated database that's torn down at the
end. **Requires Docker** (the Supabase CLI uses Docker to run Postgres,
GoTrue, PostgREST, Storage, etc.).

Setup:

1. Install the Supabase CLI: `npm i -g supabase` (already in devDeps).
2. Start Docker Desktop.
3. `supabase start --no-studio` — first run pulls Docker images
   (~300 MB), takes ~2 minutes. Subsequent runs are fast.
4. Seed minimal test data: `psql $(supabase status -o json | jq -r .DB_URL) -f supabase/seed.test.sql`
5. The CLI prints the local URL (`http://localhost:54321`) and anon key.
   Export them:
   ```bash
   export TEST_SUPABASE_URL=http://localhost:54321
   export TEST_SUPABASE_ANON_KEY=<anon-key-from-supabase-status>
   ```

In CI we use the `supabase/setup-cli` action and `supabase db reset` to
apply migrations + seed. See `.github/workflows/ci.yml` job `e2e`.

**Why local over a shadow project**: it's free, faster (no network),
fully isolated per-run, and CI-friendly. The only cost is Docker.

### Mode 2 — `shadow` (optional; staging-grade)

Use a dedicated Supabase TEST project (separate from production) when you
need to test against the real edge-function deploy + real Stripe test mode
+ real Resend sandbox. Runs against project ref `islqnpbdkfbaexwtuppt`
(`sb1-myra81at`).

Setup CI secrets:

- `TEST_SUPABASE_URL` — `https://islqnpbdkfbaexwtuppt.supabase.co`
- `TEST_SUPABASE_ANON_KEY` — the anon key from that project's Settings
- `TEST_SUPABASE_SERVICE_ROLE_KEY` — for cleanup between runs

Trigger via:

```bash
TEST_SUPABASE_MODE=shadow \
TEST_SUPABASE_URL=https://islqnpbdkfbaexwtuppt.supabase.co \
TEST_SUPABASE_ANON_KEY=... \
npm run test:e2e
```

This mode runs nightly in CI to catch deploy regressions, but is **not**
on every PR — too slow and rate-limited.

## Test data

Test users are created with a `+e2e-${Date.now()}` email suffix so they
are easy to identify and clean up. The local-mode database is dropped at
the end of every CI run, so cleanup is automatic.

For shadow mode, a nightly cron runs
`supabase/scripts/cleanup-test-users.ts` to purge accounts older than 24h
matching the e2e suffix.

## Writing new tests

- Use `page.getByRole`/`getByLabel` over CSS selectors when possible.
- Always call `await page.waitForURL(...)` after navigation, never sleep.
- For flows that mutate Supabase (signup, project create), make sure you
  understand which Mode the test will run in and that it cleans up after
  itself if it has external side effects (emails, Stripe).
- New specs go in `e2e/*.spec.ts`. Group related tests with
  `test.describe`.

## CI integration

The `e2e` job in `.github/workflows/ci.yml`:

1. Boots a local Supabase via `supabase/setup-cli` + `supabase db reset`.
2. Installs Playwright Chromium.
3. Runs `npm run test:e2e` (which starts vite via the `webServer` block).
4. Uploads the HTML report as an artifact on failure.
5. The `deploy` job declares `needs: [test-build, e2e]`, so a red E2E
   blocks production deploy.
