/**
 * Handles stale-chunk errors that occur after a new deployment.
 * Returns true if a reload was triggered (caller should bail out of further
 * error handling), false otherwise.
 */
export function handleChunkError(error: Error, sessionKey: string): boolean {
  if (
    !error.message?.includes("Failed to fetch dynamically imported module") &&
    !error.message?.includes("Loading chunk") &&
    !error.message?.includes("Loading CSS chunk")
  ) {
    return false;
  }

  const lastReload = sessionStorage.getItem(sessionKey);
  const now = Date.now();
  if (!lastReload || now - Number(lastReload) > 30_000) {
    sessionStorage.setItem(sessionKey, String(now));
    window.location.reload();
    return true;
  }
  return false;
}
