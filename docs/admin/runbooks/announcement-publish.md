# Announcement Publish Runbook

Use this when you need to surface a message to all (or some) authenticated users — maintenance windows, feature launches, billing changes, incident comms.

## Channels — pick one

| Channel | Best for | Lifespan |
|---|---|---|
| **Banner** | Maintenance windows, incident comms, billing-deadline reminders | Until dismissed or `ends_at` passes |
| **Modal** | Major feature launches, ToS updates | One-time per user |
| **Toast** | Casual nudges (new template available, etc.) | Auto-dismiss after a few seconds |
| **Email** | Long-form announcements that need archive value | Permanent in inbox |
| **Push** | Urgent in-app pings | One-time |

Pick the smallest channel that does the job. Modals and emails feel intrusive for non-essential news.

## Pre-flight

1. **Severity matches content.** `info` for normal news, `warn` for maintenance, `critical` for incidents that affect generation, `feature` for product launches. Severity colors the banner / icon tile and feeds `current_announcements_for_me` ordering.
2. **Audience predicate.** Default `{"all": true}` reaches every authenticated user. To target by plan, use `{"plan": "studio"}` or `{"plan": "pro"}`. Multi-segment audiences need raw JSON via the composer's "Custom" target.
3. **CTA URL is wrapped through `announcement-click`.** The composer auto-wraps the URL via the redirect endpoint so click-rate populates. If you paste a raw URL into the body markdown instead of using the CTA field, clicks won't be tracked.
4. **Schedule vs. publish-now.** If `starts_at` is in the future, the announcement stays dormant until `starts_at`. If you want it live immediately, use **Publish now**.

## Templates

### Maintenance window

```
**Scheduled maintenance — {{date}} {{time_window_utc}}**

We're upgrading our render workers. During the window:
- New generations will be queued and start automatically when we're back
- In-flight work continues; nothing is cancelled
- The app stays browsable

Thanks for your patience.
```
Severity: `warn` · Channel: Banner · Audience: All

### Feature launch

```
**New: {{feature_name}}**

{{1-2 sentences on what it does and who benefits.}}
```
Severity: `feature` · Channel: Modal · CTA: "Try it" → relevant page

### Incident comms (post-resolution)

```
**Service restored**

We had a brief disruption to {{subsystem}} starting at {{start_time_utc}}. Affected jobs were queued and are now processing normally. If your render didn't complete, retry it from the project page.

Sorry for the disruption.
```
Severity: `info` · Channel: Banner · Audience: All

### Plan change / billing

```
**{{plan_name}} plan now includes {{new_feature}}**

Effective {{date}}. No action needed — this lands automatically on your next billing cycle.
```
Severity: `info` · Channel: Modal · Audience: `{"plan": "studio"}` (or pro/free)

## Live monitoring

1. The Live announcements section at the bottom of the Announcements tab shows every active row with views + clicks live-updating.
2. Click rate < 5% on a CTA-bearing announcement usually means the message wasn't compelling — iterate on the wording before re-running.
3. Watch `announcement_dismissals` for the dismissal rate. >50% within an hour = users actively rejecting it; consider archiving early via **End now**.

## End-now / archive

`admin_archive_announcement(id)` flips `active=false` and stamps `ends_at=NOW()`. The banner disappears from `current_announcements_for_me` for all users on next refresh (~5 s via realtime).

## What doesn't go through this flow

- **Master kill switch** auto-creates a `severity='critical'` announcement when engaged. Don't manually pre-create one for the same incident.
- **Account-specific notices** ("your card declined", "your subscription will renew") use the Notifications tab, not Announcements. Announcements are broadcast; Notifications are 1:1.

## Audit

Every `admin_create_announcement` / `admin_update_announcement` / `admin_archive_announcement` writes one `admin_logs` row with `action='announcement.*'` and the row id in `target_id`.
