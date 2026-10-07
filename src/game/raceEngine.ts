import {
  animationScaleFromPower,
  clamp,
  clampPower,
  smoothPower,
  speedFromPower,
} from "./powerCurve";
import type { GhostSample, RaceSnapshot } from "./types";

export const RACE_DISTANCE_M = 500;
/** Full power (9 m/s) needs about 56s, so the limit leaves room for slower runs. */
export const TIMEOUT_S = 180;
export const COUNTDOWN_S = 3;
export const GO_DISPLAY_S = 0.4;
export const MAX_FRAME_DT_S = 0.05;
export const SAMPLE_INTERVAL_MS = 100;

export function createRace(targetPower = 0): RaceSnapshot {
  return {
    phase: "IDLE",
    targetPower: clampPower(targetPower),
    smoothedPower: 0,
    speedMps: 0,
    animationScale: 0,
    distanceM: 0,
    countdownElapsedS: 0,
    elapsedS: 0,
    finishTimeMs: null,
    samples: [],
  };
}

export function setTargetPower(state: RaceSnapshot, power: number): RaceSnapshot {
  const targetPower = clampPower(power);
  return targetPower === state.targetPower ? state : { ...state, targetPower };
}

/** START is accepted only in IDLE. */
export function startRace(state: RaceSnapshot): RaceSnapshot {
  if (state.phase !== "IDLE") return state;
  return { ...state, phase: "COUNTDOWN", countdownElapsedS: 0 };
}

/** Back to IDLE: clears the run and smoothed power, keeps the slider target. */
export function resetRace(state: RaceSnapshot): RaceSnapshot {
  return createRace(state.targetPower);
}

function withPower(state: RaceSnapshot, smoothedPower: number): RaceSnapshot {
  return {
    ...state,
    smoothedPower,
    speedMps: speedFromPower(smoothedPower),
    animationScale: animationScaleFromPower(smoothedPower),
  };
}

/** Advances the simulation by one frame. Returns the same object when nothing changes. */
export function stepRace(state: RaceSnapshot, rawDt: number): RaceSnapshot {
  const dt = clamp(rawDt, 0, MAX_FRAME_DT_S);
  if (dt === 0) return state;

  if (state.phase === "COUNTDOWN") {
    const remaining = COUNTDOWN_S - state.countdownElapsedS;
    if (dt < remaining) {
      return withPower(
        { ...state, countdownElapsedS: state.countdownElapsedS + dt },
        smoothPower(state.smoothedPower, state.targetPower, dt),
      );
    }
    // Countdown ends inside this frame; the rest of the frame is race time.
    const smoothed = smoothPower(state.smoothedPower, state.targetPower, remaining);
    const running = withPower(
      {
        ...state,
        phase: "RUNNING",
        countdownElapsedS: COUNTDOWN_S,
        elapsedS: 0,
        distanceM: 0,
        samples: [{ elapsedMs: 0, distanceM: 0, smoothedPower: smoothed }],
      },
      smoothed,
    );
    return advanceRunning(running, dt - remaining);
  }

  if (state.phase === "RUNNING") return advanceRunning(state, dt);

  // IDLE, FINISHED and DNF freeze smoothing and distance.
  return state;
}

function advanceRunning(state: RaceSnapshot, dt: number): RaceSnapshot {
  if (dt <= 0) return state;

  const speed = speedFromPower(smoothPower(state.smoothedPower, state.targetPower, dt));
  const timeToFinish = speed > 0 ? (RACE_DISTANCE_M - state.distanceM) / speed : Infinity;
  const timeToTimeout = TIMEOUT_S - state.elapsedS;

  // Earliest of frame end, finish or timeout wins; an exact finish/timeout tie is a finish.
  const finishes = timeToFinish <= dt && timeToFinish <= timeToTimeout;
  const timesOut = !finishes && timeToTimeout <= dt;
  const consumed = finishes ? timeToFinish : timesOut ? timeToTimeout : dt;
  const smoothed = smoothPower(state.smoothedPower, state.targetPower, consumed);

  const startMs = state.elapsedS * 1000;
  const elapsedS = timesOut ? TIMEOUT_S : state.elapsedS + consumed;
  const endMs = elapsedS * 1000;

  let samples = state.samples;
  const lastMs = samples.length > 0 ? samples[samples.length - 1].elapsedMs : 0;
  for (
    let t = (Math.floor(lastMs / SAMPLE_INTERVAL_MS) + 1) * SAMPLE_INTERVAL_MS;
    t <= endMs;
    t += SAMPLE_INTERVAL_MS
  ) {
    if (samples === state.samples) samples = samples.slice();
    const offsetS = (t - startMs) / 1000;
    samples.push({
      elapsedMs: t,
      distanceM: Math.min(RACE_DISTANCE_M, state.distanceM + speed * offsetS),
      smoothedPower: smoothPower(state.smoothedPower, state.targetPower, offsetS),
    });
  }

  if (finishes) {
    const finishSample: GhostSample = {
      elapsedMs: endMs,
      distanceM: RACE_DISTANCE_M,
      smoothedPower: smoothed,
    };
    samples = samples === state.samples ? samples.slice() : samples;
    if (samples[samples.length - 1].elapsedMs === endMs) {
      samples[samples.length - 1] = finishSample;
    } else {
      samples.push(finishSample);
    }
    return withPower(
      {
        ...state,
        phase: "FINISHED",
        distanceM: RACE_DISTANCE_M,
        elapsedS,
        finishTimeMs: endMs,
        samples,
      },
      smoothed,
    );
  }

  return withPower(
    {
      ...state,
      phase: timesOut ? "DNF" : "RUNNING",
      distanceM: Math.min(RACE_DISTANCE_M, state.distanceM + speed * consumed),
      elapsedS,
      samples,
    },
    smoothed,
  );
}

/** Big centre-screen text: 3, 2, 1, then GO! for the first 400ms of the race. */
export function overlayLabel(state: RaceSnapshot): string | null {
  if (state.phase === "COUNTDOWN") {
    return String(COUNTDOWN_S - Math.floor(state.countdownElapsedS));
  }
  if (state.phase === "RUNNING" && state.elapsedS < GO_DISPLAY_S) return "GO!";
  return null;
}
