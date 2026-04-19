# supabase/scripts

These are **manual, one-time SQL scripts**. They are NOT auto-run migrations.

The Supabase CLI re-runs every file in `migrations/` on each fresh environment reset.
Scripts in this directory must be run manually via the Supabase SQL Editor or `psql`
against a specific target database.

## Files

| File | Purpose |
|------|---------|
| 20260327000003_cleanup_incomplete_projects.sql | Delete incomplete/stale projects |
| 20260327000004_inspect_projects.sql            | Inspect project state (read-only) |
| 20260327000005_cleanup_projects_alternative.sql| Alternative cleanup approach |
| 20260327000006_cleanup_failed_projects.sql     | Delete failed-status projects |

## How to run

```bash
psql "$DATABASE_URL" -f supabase/scripts/<filename>.sql
```

Or paste into the Supabase SQL Editor for the target project.
