import { useMemo, useEffect } from "react";
import type { Experiment } from "@/lib/experiments";

const ASSIGNMENTS_KEY = "mm_experiments";
const VISITOR_KEY = "mm_visitor_id";

function getVisitorId(): string {
  const existing = localStorage.getItem(VISITOR_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(VISITOR_KEY, id);
  return id;
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function readAssignments(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ASSIGNMENTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeAssignment(experimentId: string, variant: string): void {
  const current = readAssignments();
  current[experimentId] = variant;
  localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(current));
}

type GtagFn = (command: string, event: string, params: Record<string, string>) => void;

function fireGtag(experimentId: string, variant: string): void {
  if (typeof window !== "undefined" && typeof (window as Window & { gtag?: GtagFn }).gtag === "function") {
    (window as Window & { gtag: GtagFn }).gtag("event", "experiment_impression", {
      experiment_id: experimentId,
      variant_id: variant,
    });
  }
}

/**
 * Returns the assigned variant for an experiment, assigning one deterministically
 * on first call. Fires a GA4 `experiment_impression` event on exposure.
 *
 * SSR-safe: returns control variant when localStorage is unavailable.
 */
export function useExperiment(experiment: Experiment): string {
  const variant = useMemo((): string => {
    if (typeof window === "undefined") return experiment.variants[0];

    const stored = readAssignments();
    if (stored[experiment.id]) return stored[experiment.id];

    const trafficFraction = experiment.trafficFraction ?? 1;
    const hash = hashString(`${getVisitorId()}:${experiment.id}`);

    // Exclude from test if outside traffic fraction — always show control
    if ((hash % 100) / 100 >= trafficFraction) {
      return experiment.variants[0];
    }

    const assigned = experiment.variants[hash % experiment.variants.length];
    writeAssignment(experiment.id, assigned);
    return assigned;
  }, [experiment]);

  useEffect(() => {
    fireGtag(experiment.id, variant);
  }, [experiment.id, variant]);

  return variant;
}
