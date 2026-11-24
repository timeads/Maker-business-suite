/** The worker looks once an hour; three missed looks means something's wrong. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export type SyncHealthLevel = "off" | "ok" | "stale" | "never";

export interface SyncHealth {
  level: SyncHealthLevel;
  lastSuccessAt: Date | null;
  lastRunAt: Date | null;
  /** The most recent run's error, if it failed. */
  lastError: string | null;
}

/**
 * Is the connector actually looking? Pure, so the threshold is testable
 * (ported from TuftStock). "stale" covers both a stopped worker (no runs at
 * all) and runs that keep failing (no successful run): either way nothing is
 * being checked.
 */
export function syncHealth(
  input: {
    enabled: boolean;
    lastSuccessAt: Date | null;
    lastRunAt: Date | null;
    lastError: string | null;
  },
  now: Date = new Date(),
  staleAfterMs: number = STALE_AFTER_MS,
): SyncHealth {
  const { enabled, lastSuccessAt, lastRunAt, lastError } = input;
  const base = { lastSuccessAt, lastRunAt, lastError };
  if (!enabled) return { level: "off", ...base };
  if (!lastSuccessAt) return { level: "never", ...base };
  return {
    level: now.getTime() - lastSuccessAt.getTime() > staleAfterMs ? "stale" : "ok",
    ...base,
  };
}
