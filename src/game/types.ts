export type RacePhase = "IDLE" | "COUNTDOWN" | "RUNNING" | "FINISHED" | "DNF";

export interface GhostSample {
  elapsedMs: number;
  distanceM: number;
  smoothedPower: number;
}

export interface StoredBest {
  version: 1;
  timeMs: number;
  samples: GhostSample[];
}

/** Immutable engine state. Renderers read it as a snapshot and never redo power math. */
export interface RaceSnapshot {
  phase: RacePhase;
  /** Slider value, clamped to [0, 100]. */
  targetPower: number;
  smoothedPower: number;
  speedMps: number;
  animationScale: number;
  distanceM: number;
  /** Seconds spent in COUNTDOWN (0..3). */
  countdownElapsedS: number;
  /** Simulated race seconds; advances only in RUNNING. */
  elapsedS: number;
  /** Exact finish time, set only in FINISHED. */
  finishTimeMs: number | null;
  /** Ghost samples recorded during the current run. */
  samples: GhostSample[];
}
