import { RACE_DISTANCE_M } from "./raceEngine";
import type { GhostSample, RaceSnapshot, StoredBest } from "./types";

export const STORAGE_KEY = "finger-run.best.v1";
/** 10Hz over 60s plus the 0ms and finish endpoints. */
export const MAX_SAMPLES = 602;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isNonNegativeFinite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Returns a validated StoredBest, or null for anything malformed. */
export function parseStoredBest(value: unknown): StoredBest | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, timeMs, samples } = value as Record<string, unknown>;
  if (version !== 1 || !isNonNegativeFinite(timeMs) || timeMs === 0) return null;
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > MAX_SAMPLES) return null;

  const clean: GhostSample[] = [];
  for (const raw of samples) {
    if (typeof raw !== "object" || raw === null) return null;
    const { elapsedMs, distanceM, smoothedPower } = raw as Record<string, unknown>;
    if (
      !isNonNegativeFinite(elapsedMs) ||
      !isNonNegativeFinite(distanceM) ||
      !isNonNegativeFinite(smoothedPower) ||
      distanceM > RACE_DISTANCE_M ||
      smoothedPower > 100
    ) {
      return null;
    }
    const prev = clean[clean.length - 1];
    if (prev && elapsedMs <= prev.elapsedMs) return null;
    clean.push({ elapsedMs, distanceM, smoothedPower });
  }

  const first = clean[0];
  const last = clean[clean.length - 1];
  if (first.elapsedMs !== 0 || first.distanceM !== 0) return null;
  if (last.elapsedMs !== timeMs || last.distanceM !== RACE_DISTANCE_M) return null;

  return { version: 1, timeMs, samples: clean };
}

export interface LoadResult {
  best: StoredBest | null;
  /** True when stored data existed but was unreadable or invalid. */
  corrupt: boolean;
}

export function loadBest(storage: StorageLike | null): LoadResult {
  if (!storage) return { best: null, corrupt: false };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { best: null, corrupt: false };
  }
  if (raw === null) return { best: null, corrupt: false };
  try {
    const best = parseStoredBest(JSON.parse(raw));
    return { best, corrupt: best === null };
  } catch {
    return { best: null, corrupt: true };
  }
}

/** The finished run as a StoredBest, or null if the race did not finish. */
export function completedRun(state: RaceSnapshot): StoredBest | null {
  if (state.phase !== "FINISHED" || state.finishTimeMs === null) return null;
  return parseStoredBest({ version: 1, timeMs: state.finishTimeMs, samples: state.samples });
}

/**
 * Persists the run as one object when it beats the current best.
 * Returns the best to keep in memory afterwards.
 */
export function saveBestIfBetter(
  storage: StorageLike | null,
  current: StoredBest | null,
  candidate: StoredBest | null,
): { best: StoredBest | null; improved: boolean } {
  if (!candidate || (current && candidate.timeMs >= current.timeMs)) {
    return { best: current, improved: false };
  }
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(candidate));
  } catch {
    // Storage full or blocked: keep the best in memory for this session.
  }
  return { best: candidate, improved: true };
}

export function clearStoredBest(storage: StorageLike | null): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

export interface GhostPose {
  distanceM: number;
  smoothedPower: number;
  /** True once the ghost has passed its final sample; its animation pauses. */
  done: boolean;
}

/** Ghost position at a race time: clamped at both ends, linear in between. */
export function ghostAt(best: StoredBest, elapsedMs: number): GhostPose {
  const { samples } = best;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!(elapsedMs > first.elapsedMs)) {
    return { distanceM: first.distanceM, smoothedPower: first.smoothedPower, done: false };
  }
  if (elapsedMs >= last.elapsedMs) {
    return { distanceM: last.distanceM, smoothedPower: last.smoothedPower, done: true };
  }
  // Binary search for the enclosing pair.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].elapsedMs <= elapsedMs) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const t = (elapsedMs - a.elapsedMs) / (b.elapsedMs - a.elapsedMs);
  return {
    distanceM: a.distanceM + (b.distanceM - a.distanceM) * t,
    smoothedPower: a.smoothedPower + (b.smoothedPower - a.smoothedPower) * t,
    done: false,
  };
}
