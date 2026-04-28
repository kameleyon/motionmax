/**
 * Shared types for the My Automations dashboard + its modal dialogs.
 *
 * `config_snapshot` is a JSONB column added by Wave B1 — it captures the
 * full intake-form payload at schedule creation time so we can re-render
 * editable fields in the Edit modal without re-deriving them. The
 * supabase generated types may not yet include the column at edit time,
 * so we keep an explicit type for the row shape used by the dashboard
 * and cast at the query boundary.
 */

export interface AutomationSchedule {
  id: string;
  user_id: string;
  name: string;
  active: boolean;
  prompt_template: string;
  topic_pool: string[] | null;
  motion_preset: string | null;
  duration_seconds: number;
  resolution: string;
  cron_expression: string;
  timezone: string;
  next_fire_at: string;
  target_account_ids: string[];
  caption_template: string | null;
  hashtags: string[] | null;
  ai_disclosure: boolean;
  created_at: string;
  updated_at: string;
  /** Added by Wave B1; absent on rows created before the migration. */
  config_snapshot: Record<string, unknown> | null;
  /** Wave E — how rendered videos are delivered. Older rows default to 'social'. */
  delivery_method?: 'social' | 'email' | 'library_only';
  /** Wave E — recipient list used when delivery_method='email'. */
  email_recipients?: string[] | null;
}

/**
 * The slice of `config_snapshot` the Edit modal cares about. Anything
 * not listed here is preserved on save (we splice the patch back into
 * the original snapshot before writing).
 */
export interface IntakeSettings {
  prompt?: string;
  resolution?: string;
  duration_seconds?: number;
  caption_template?: string;
  hashtags?: string[];
  motion_preset?: string;
  [key: string]: unknown;
}
