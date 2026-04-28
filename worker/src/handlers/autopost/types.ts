/**
 * Autopost worker shared types.
 *
 * The DB enum on autopost_publish_jobs.status is:
 *   'pending' | 'uploading' | 'processing' | 'published' | 'failed' | 'rejected'
 *
 * The DB enum on autopost_social_accounts.status is:
 *   'connected' | 'expired' | 'revoked' | 'error'
 *
 * Wave 3a will replace stub publishers with real platform SDK calls.
 */

export type Platform = "youtube" | "instagram" | "tiktok";

export interface PublishJob {
  id: string;
  run_id: string;
  social_account_id: string;
  platform: Platform;
  status: string;
  attempts: number;
  scheduled_for?: string | null;
  caption?: string | null;
  /** Set when worker claims the row. */
  last_attempt_at?: string | null;
  platform_post_id?: string | null;
  platform_post_url?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SocialAccount {
  id: string;
  user_id: string;
  platform: Platform;
  platform_account_id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  access_token: string;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  scopes: string[];
  status: string;
  last_error?: string | null;
  provider_metadata?: Record<string, unknown> | null;
}

export interface PublishContext {
  job: PublishJob;
  account: SocialAccount;
  /** Final rendered video URL pulled from the run's video_generation_jobs row. */
  videoUrl: string;
  caption: string;
  runId: string;
  /** Optional video metadata, populated by the dispatcher from the
   *  video_generation_jobs.result/.payload jsonb when available. Publishers
   *  fall back to a HEAD probe of the videoUrl when these are missing. */
  width?: number;
  height?: number;
  durationMs?: number;
  sizeBytes?: number;
}

export type PublishResult =
  | { ok: true; postId: string; postUrl: string }
  | { ok: false; errorCode: string; errorMessage: string; retryable: boolean; retryAfterMs?: number };
