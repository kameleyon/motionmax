/**
 * Sentry breadcrumb helpers for user-facing actions.
 *
 * Call these at key interaction points so Sentry replays / error reports
 * include a rich action trail (generation start, provider switch, export).
 */

import * as Sentry from "@sentry/react";

/** Record that the user kicked off a new generation. */
export function breadcrumbGenerationStart(opts: {
  projectId: string;
  projectType: string;
  creditCost: number;
}): void {
  Sentry.addBreadcrumb({
    category: "generation",
    message: "Generation started",
    level: "info",
    data: opts,
  });
}

/** Record that the user chose a specific AI provider / model. */
export function breadcrumbProviderSelected(opts: {
  provider: string;
  model?: string;
}): void {
  Sentry.addBreadcrumb({
    category: "provider",
    message: `Provider selected: ${opts.provider}`,
    level: "info",
    data: opts,
  });
}

/** Record that the user triggered an export / download. */
export function breadcrumbExport(opts: {
  projectId: string;
  format: string;
  resolution?: string;
}): void {
  Sentry.addBreadcrumb({
    category: "export",
    message: `Export started: ${opts.format}`,
    level: "info",
    data: opts,
  });
}
