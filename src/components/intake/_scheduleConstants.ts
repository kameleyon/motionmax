/**
 * Shared constants for the intake-form ScheduleBlock and any downstream
 * editor/admin modals that render or edit autopost schedules.
 *
 * Lives next to ScheduleBlock.tsx because the dropdown wording is part
 * of the intake UX contract — but exported widely so the editor's
 * "Edit schedule" modal (Wave B2) and the admin /lab/autopost page can
 * reuse the SAME label text and cron mappings without re-implementing
 * either side and drifting.
 */

export type ScheduleInterval =
  | 'every_3_min'
  | 'every_15_min'
  | 'every_hour'
  | 'every_6_hours'
  | 'every_12_hours'
  | 'daily'
  | 'weekly';

/**
 * Dropdown options for the "How often?" picker. Mirrors the Autonomux
 * pattern exactly — each row has a `label` (selected text) and a
 * `hint` (gray helper text rendered after an em-dash). Order is from
 * shortest to longest interval so power-users find the high-frequency
 * options first.
 */
export const SCHEDULE_INTERVALS: ReadonlyArray<{
  value: ScheduleInterval;
  label: string;
  hint: string;
}> = [
  { value: 'every_3_min',    label: 'Every 3 minutes',         hint: 'For testing only' },
  { value: 'every_15_min',   label: 'Every 15 minutes',        hint: 'Best for real-time monitoring' },
  { value: 'every_hour',     label: 'Hourly',                  hint: 'Good for email & social media' },
  { value: 'every_6_hours',  label: 'Every 6 hours',           hint: '4 times per day' },
  { value: 'every_12_hours', label: 'Every 12 hours',          hint: 'Morning & evening' },
  { value: 'daily',          label: 'Daily (9 AM UTC)',        hint: 'Most popular — once per day' },
  { value: 'weekly',         label: 'Weekly (Mon 9 AM UTC)',   hint: 'Great for reports & summaries' },
] as const;

/**
 * Maps a ScheduleInterval to a 5-field cron expression (minute hour
 * day-of-month month day-of-week). All times are UTC — the
 * autopost_schedules.timezone column is set to 'UTC' on insert so
 * pg_cron evaluates the expression in the same frame.
 */
export const INTERVAL_TO_CRON: Record<ScheduleInterval, string> = {
  every_3_min:    '*/3 * * * *',
  every_15_min:   '*/15 * * * *',
  every_hour:     '0 * * * *',
  every_6_hours:  '0 */6 * * *',
  every_12_hours: '0 */12 * * *',
  daily:          '0 9 * * *',
  weekly:         '0 9 * * 1',
};

/**
 * Rough monthly run count per interval — used in the "Estimated cost"
 * helper text under the dropdown so creators see how big a bill they
 * are signing up for before they hit Create.
 */
export const RUNS_PER_MONTH: Record<ScheduleInterval, number> = {
  every_3_min:    14_400,  // 60/3 * 24 * 30
  every_15_min:    2_880,
  every_hour:        720,
  every_6_hours:     120,
  every_12_hours:     60,
  daily:              30,
  weekly:              4,
};
