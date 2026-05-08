# Master Kill Switch Runbook

The master kill switch is the largest blast radius the admin tooling exposes. Treat it as a "stop the world" lever.

## When to engage

Engage **only** when one of the following is true:
- Active credential leak / unauthorized worker access — stop new jobs while you rotate keys.
- Active billing-system incident — stop new generations + new sign-ups so refund + reconciliation can finish without a moving target.
- Provider-side incident causing visible user-data corruption (Hypereal misrouting outputs, ElevenLabs leaking voice clones across users, etc.).

Do **not** engage for:
- Normal degraded performance (use the per-subsystem kill switch instead — `video_generation`, `image_generation`, etc.).
- Provider rate-limiting (the worker handles 429s via backoff already).
- Single-feature outages (use the relevant subsystem switch).

## How to engage

1. Admin → **Kill Switches** tab.
2. Type **`ENGAGE`** in the master-kill confirm modal and click the toggle.
3. The RPC `admin_set_master_kill_switch(true, '<message>')` runs `admin_cancel_all_active_jobs()` + auto-creates a `severity='critical'` announcement.
4. Within ≤5 s the worker's `isMasterKillEngaged()` poll catches the flip and stops claiming new jobs (existing in-flight work either drains via the resume-checkpoint mechanism or is cancelled by the bulk-cancel above).

## What users see

- **Public site:** maintenance announcement banner (auto-created by the RPC) plus 503 responses on edge functions that consult the flag.
- **Authenticated app:** the announcement modal + a yellow strip across `/app`. New generation submissions return a 503 with the message text.
- **Admin tools:** unaffected — admins can still sign in, run reconciliation, etc.

## Disengage

1. Admin → **Kill Switches** tab → type **`DISENGAGE`**.
2. The announcement auto-archives. Worker resumes claiming within ≤15 s.
3. Manually retry any cancelled jobs from the Generations tab if users complain.

## Comms templates

**Status page / banner** (when engaging):
> We've temporarily paused video generation while we investigate an incident. New generations are queued for when we're back online; existing in-flight work continues. We'll update this banner once we've cleared the issue.

**Status page / banner** (when disengaging):
> Service restored — we've cleared the incident and queued generations are now flowing. Sorry for the disruption.

**Direct support reply** (for users who hit the 503):
> We had a brief platform-wide pause earlier today to address an issue. Your project is safe in your library and your credits are intact. You can re-run the generation now and it will go through normally.

## Audit

Every flip writes one `admin_logs` row with `action='master_kill.engaged'` (or `disengaged`), `target_id=NULL`, `details={ from, to, message }`. Check the Activity tab or query `admin_logs WHERE action LIKE 'master_kill%' ORDER BY created_at DESC LIMIT 5`.
