# Runbooks

Incident response runbooks for MotionMax. One file per third-party
dependency that can break us. Each runbook follows the same template:
**Symptoms → Detection → Triage → Mitigation → Customer comms → Restore →
Post-incident**.

## Severity matrix

| Severity | Customer impact                              | Page?      | Status page update |
|----------|----------------------------------------------|------------|--------------------|
| **SEV-1**| Core flow broken (login, checkout, render)   | Yes — primary + secondary  | "Major outage"     |
| **SEV-2**| Degraded (slow, partial features unavailable)| Yes — primary             | "Partial outage"   |
| **SEV-3**| Affects <10% of users or non-critical path   | Slack only                 | "Investigating"     |
| **SEV-4**| Cosmetic / informational                     | Ticket                     | none                |

## Active runbooks

| Provider     | Runbook                              | Typical SEV when down |
|--------------|--------------------------------------|------------------------|
| Stripe       | [stripe-outage.md](./stripe-outage.md)         | SEV-1 (checkout) or SEV-2 (subscription mgmt) |
| OpenRouter   | [openrouter-outage.md](./openrouter-outage.md) | SEV-2 (cinematic prompts; failover available) |
| Supabase     | [supabase-outage.md](./supabase-outage.md)     | SEV-1 (DB + Auth + storage; no failover) |
| ElevenLabs   | [elevenlabs-outage.md](./elevenlabs-outage.md) | SEV-2 (TTS; queue can hold) |
| Hypereal     | [hypereal-outage.md](./hypereal-outage.md)     | SEV-2 (video render queue can hold) |

## Escalation contacts

| Role                  | How to reach                                  |
|-----------------------|-----------------------------------------------|
| Primary on-call       | PagerDuty schedule `motionmax-primary`        |
| Secondary on-call     | PagerDuty schedule `motionmax-secondary`      |
| Founder               | PagerDuty escalation policy step 4            |
| #incidents            | Slack channel — single source of truth during incident |
| Legal (data exposure) | `[REDACTED — see PagerDuty]`                  |
| Comms / status page   | BetterStack admin                              |

Phone numbers and personal Slack handles deliberately live in PagerDuty,
not in git. See `docs/on-call-rotation.md`.

## How to use a runbook during an incident

1. **Acknowledge the page within 5 min.** Even a "I see it, investigating"
   ack stops the escalation timer.
2. **Open #incidents.** Pin a thread for THIS incident. All updates,
   queries, and findings go in that thread.
3. **Open the relevant runbook.** Don't rely on memory. The triage step
   will tell you whether the problem is theirs or ours.
4. **Post status-page update within 10 min** of confirming an outage.
   Use the copy templates in each runbook's "Customer comms" section.
5. **Mitigate first, root-cause later.** Page-handling is about restoring
   service. The post-incident review covers root cause.

## Adding a new runbook

When a new third-party dependency goes critical-path:

1. Copy `stripe-outage.md` as a template (richest of the five).
2. Fill in **Symptoms / Detection / Triage / Mitigation / Comms /
   Restore / Post-incident**.
3. Add a row to the table above and update `docs/observability-setup.md`.
4. Link from the corresponding Sentry alert rule in
   `iac/sentry/alert-rules.json` via the `name` field.

## Drills

Run a tabletop exercise once per quarter. Pick one runbook at random and
walk through it as if the outage just started. Time how long it takes
to:
- Acknowledge the page.
- Identify which runbook applies.
- Post the first status-page update.
- Reach a mitigation decision.

Aim for under 15 minutes from page → first comms.
