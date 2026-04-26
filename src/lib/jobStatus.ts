/**
 * Status enum reference — `generations` and `video_generation_jobs`
 * use DIFFERENT terminal-state spellings and they MUST stay synced
 * across the codebase or rows silently disappear from filters.
 *
 *   generations.status:           pending | processing | complete | error | deleted
 *   video_generation_jobs.status: pending | processing | completed | failed
 *
 * Do not freelance these strings inline. Import the constants below.
 */

export const GENERATION_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETE: "complete",
  ERROR: "error",
  DELETED: "deleted",
} as const;

export type GenerationStatus = (typeof GENERATION_STATUS)[keyof typeof GENERATION_STATUS];

export const JOB_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** A generation row is "done" when status === 'complete'. */
export const isGenerationDone = (status: string | null | undefined): boolean =>
  status === GENERATION_STATUS.COMPLETE;

/** A job row is "done" when status === 'completed'. */
export const isJobDone = (status: string | null | undefined): boolean =>
  status === JOB_STATUS.COMPLETED;

/** Either type is in a terminal state (success OR failure). Useful for
 *  "is this still in flight?" checks. */
export const isTerminal = (status: string | null | undefined): boolean =>
  status === GENERATION_STATUS.COMPLETE
  || status === GENERATION_STATUS.ERROR
  || status === GENERATION_STATUS.DELETED
  || status === JOB_STATUS.COMPLETED
  || status === JOB_STATUS.FAILED;
