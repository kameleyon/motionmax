# Incident Response Runbook

Use this when the **Errors** tab spikes, when Sentry pages, or when a user reports broken behavior that's not isolated to their account.

## Triage (first 5 minutes)

1. **Open Admin → Errors.** The KPI tiles surface `Errors · 1h`, `Affected users · 1h`, `Open signatures`. If `Affected users · 1h` is climbing fast, this is a multi-user incident.
2. **Check the top error signature.** Errors are grouped by `sha1(event_type + normalized_message)` — same root cause, same fingerprint. Click **Stack** on the top row to see the sample message + `details` jsonb.
3. **Check the surface card.** Errors-by-surface (Web app / Worker / Edge functions) tells you whether the problem is in the UI, the render pipeline, or an edge function.
4. **Look at the Performance tab.** If the worker is wedged (`Queue depth · now` >50 or `Memory · pod p95` >90 %) the error surge is downstream of an infra problem — not a code bug.

## Decide whether to incidentise

The `incidents` table auto-opens an incident when one fingerprint exceeds 30 events in 5 min (RPC `auto_open_incident_if_threshold`). For lighter spikes you can manually open one from the Errors drilldown.

Open an incident when:
- The same fingerprint is producing >5 events/min for >5 min.
- Multiple users (>3) are affected.
- The error breaks a user-facing flow (generate, export, billing, sign-in).

## Mitigate

Pick the minimal blast-radius lever:

| Symptom | Action |
|---|---|
| `voice_generation` errors spiking | Kill Switches → **Pause voice (TTS + clone)** |
| `image_generation` errors spiking | Kill Switches → **Pause image generation** |
| `video_generation` (Seedance/Kling) errors spiking | Kill Switches → **Pause video generation** |
| Stripe `payments` 5xx | Kill Switches → **Disable purchases** |
| Newsletter sends bouncing/complaining | Kill Switches → **Pause outbound email** |
| Sign-up flood / leaked invite link | Kill Switches → **Disable new sign-ups** |
| Cross-cutting (DB outage, credential leak, infra) | Master kill (see `master-kill.md`) |

## Resolve

1. Fix the root cause (deploy the patch).
2. Disengage the kill switch.
3. **Errors tab → Resolve** the fingerprint group. The `admin_resolve_error_group` RPC stamps `resolved_at` on every matching row.
4. Update the incident: status → `resolved`, fill in the `notes` field with one or two sentences (what broke, what fixed it).

## Comms

If the incident hit users:
- Update the matching announcement (or close it).
- Reach affected users individually via the Messages tab if it's <20 people. For larger reach, draft a Newsletter campaign with audience='all_opted_in' and the same content.

## Sentry deep-link

Every error group exposes an "Open in Sentry" button that links to `https://sentry.io/issues/?query=<fingerprint>`. Use it when the in-app stack-trace summary isn't enough.

## Audit

Every resolved fingerprint writes to `admin_logs` with `action='error_group_resolved'`, `target_type='error_fingerprint'`, `details={ fingerprint, rows_affected, notes }`. Resolutions are searchable in the Activity tab.
