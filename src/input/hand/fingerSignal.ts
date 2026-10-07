/**
 * Turns hand landmarks into a 0..100 power value. Pure: no DOM, no MediaPipe.
 *
 * Landmarks are MediaPipe normalized image coordinates of the unmirrored frame.
 * Only differences and ratios are used, so mirroring the preview never changes the result.
 */

export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

export const WRIST = 0;
export const INDEX_TIP = 8;
export const MIDDLE_MCP = 9;

export const MIN_PALM_SCALE = 0.02;
export const MIN_DT_S = 1 / 120;
export const MAX_DT_S = 0.2;
export const MEDIAN_WINDOW_MS = 150;
export const DEFAULT_ALPHA = 0.25;
export const HAND_LOSS_HOLD_MS = 300;
export const HAND_LOSS_DECAY_MS = 500;

export interface Calibration {
  /** Speeds at or below this (palm lengths per second) count as no movement. */
  deadZone: number;
  /** Speed that maps to power 100. */
  maxSpeed: number;
  usedDefaults: boolean;
}

export const DEFAULT_CALIBRATION: Calibration = { deadZone: 0.8, maxSpeed: 9, usedDefaults: true };

interface Point {
  x: number;
  y: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Index tip relative to the wrist, so moving the whole hand or camera cancels out. */
export function relativeTip(landmarks: Landmark[]): Point {
  const tip = landmarks[INDEX_TIP];
  const wrist = landmarks[WRIST];
  return { x: tip.x - wrist.x, y: tip.y - wrist.y };
}

/** Wrist to middle-finger MCP distance; normalizes for hand size and camera distance. */
export function palmScale(landmarks: Landmark[]): number {
  return Math.max(dist(landmarks[WRIST], landmarks[MIDDLE_MCP]), MIN_PALM_SCALE);
}

/** Palm-normalized index tip speed in palm lengths per second. */
export function fingerSpeed(prevRel: Point, nowRel: Point, scale: number, dtS: number): number {
  return dist(nowRel, prevRel) / scale / dtS;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Monotonic speed to power mapping with a dead zone, clamped to 0..100. */
export function speedToPower(speed: number, cal: Calibration): number {
  if (!Number.isFinite(speed) || speed <= cal.deadZone) return 0;
  const t = (speed - cal.deadZone) / (cal.maxSpeed - cal.deadZone);
  return Math.min(100, Math.max(0, 100 * t ** 0.8));
}

export function isValidLandmarks(landmarks: Landmark[] | null | undefined): landmarks is Landmark[] {
  if (!landmarks || landmarks.length <= INDEX_TIP || landmarks.length <= MIDDLE_MCP) return false;
  for (const i of [WRIST, INDEX_TIP, MIDDLE_MCP]) {
    const p = landmarks[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

export interface SignalReading {
  power: number;
  /** Last instantaneous speed (palm lengths/s), or 0 when unavailable. */
  rawSpeed: number;
  smoothedSpeed: number;
  handVisible: boolean;
  /** Index tip in normalized image coordinates, for the preview dot. */
  tip: Point | null;
}

export class FingerPowerSignal {
  private prevRel: Point | null = null;
  private prevT = 0;
  private window: Array<{ t: number; speed: number }> = [];
  private ema = 0;
  private power = 0;
  private rawSpeed = 0;
  private lastSeenT: number | null = null;
  private powerAtLoss = 0;

  constructor(
    private calibration: Calibration = DEFAULT_CALIBRATION,
    private readonly alpha = DEFAULT_ALPHA,
  ) {}

  setCalibration(calibration: Calibration) {
    this.calibration = calibration;
  }

  getCalibration(): Calibration {
    return this.calibration;
  }

  reset() {
    this.prevRel = null;
    this.window = [];
    this.ema = 0;
    this.power = 0;
    this.rawSpeed = 0;
    this.lastSeenT = null;
    this.powerAtLoss = 0;
  }

  /** Feed one inference result. `landmarks` is null when no hand was found. */
  update(landmarks: Landmark[] | null, tMs: number): SignalReading {
    if (!isValidLandmarks(landmarks)) return this.handMissing(tMs);

    const rel = relativeTip(landmarks);
    const scale = palmScale(landmarks);
    this.lastSeenT = tMs;

    if (this.prevRel === null) {
      // First frame after (re)detection: no speed yet, so power cannot spike.
      this.prevRel = rel;
      this.prevT = tMs;
      this.rawSpeed = 0;
    } else {
      const dt = (tMs - this.prevT) / 1000;
      if (dt > MAX_DT_S) {
        // Too long a gap to trust; restart from here.
        this.prevRel = rel;
        this.prevT = tMs;
      } else if (dt >= MIN_DT_S) {
        const speed = fingerSpeed(this.prevRel, rel, scale, dt);
        this.rawSpeed = speed;
        this.prevRel = rel;
        this.prevT = tMs;
        this.window.push({ t: tMs, speed });
      }
      // dt < MIN_DT_S: keep the older reference so the next frame spans a longer interval.
    }

    this.window = this.window.filter((s) => tMs - s.t <= MEDIAN_WINDOW_MS);
    if (this.window.length > 0) {
      this.ema += this.alpha * (median(this.window.map((s) => s.speed)) - this.ema);
    }
    this.power = speedToPower(this.ema, this.calibration);
    this.powerAtLoss = this.power;
    return this.reading(true, { x: landmarks[INDEX_TIP].x, y: landmarks[INDEX_TIP].y });
  }

  private handMissing(tMs: number): SignalReading {
    // Forget the previous position so redetection starts from zero speed.
    this.prevRel = null;
    this.window = [];
    this.rawSpeed = 0;
    if (this.lastSeenT === null) {
      this.power = 0;
      this.ema = 0;
      return this.reading(false, null);
    }
    const lostFor = tMs - this.lastSeenT;
    if (lostFor > HAND_LOSS_HOLD_MS) {
      const k = Math.max(0, 1 - (lostFor - HAND_LOSS_HOLD_MS) / HAND_LOSS_DECAY_MS);
      this.power = this.powerAtLoss * k;
      this.ema = 0;
    }
    return this.reading(false, null);
  }

  private reading(handVisible: boolean, tip: Point | null): SignalReading {
    return {
      power: this.power,
      rawSpeed: this.rawSpeed,
      smoothedSpeed: this.ema,
      handVisible,
      tip,
    };
  }
}

/** Percentile of a sample list (0..1), or NaN when empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export const CALIBRATION_REST_MS = 1000;
export const CALIBRATION_SHAKE_MS = 1000;

/**
 * Two-second calibration: 1s with the hand relaxed (noise floor), then 1s of fast
 * finger wiggling (upper bound). Falls back to defaults if the range is implausible.
 */
export class CalibrationSession {
  private rest: number[] = [];
  private shake: number[] = [];
  private startT: number | null = null;

  phaseAt(tMs: number): "REST" | "SHAKE" | "DONE" {
    if (this.startT === null) this.startT = tMs;
    const elapsed = tMs - this.startT;
    if (elapsed < CALIBRATION_REST_MS) return "REST";
    if (elapsed < CALIBRATION_REST_MS + CALIBRATION_SHAKE_MS) return "SHAKE";
    return "DONE";
  }

  /** Record a raw speed sample; returns the phase it was recorded in. */
  add(speed: number, tMs: number): "REST" | "SHAKE" | "DONE" {
    const phase = this.phaseAt(tMs);
    if (Number.isFinite(speed) && speed >= 0) {
      if (phase === "REST") this.rest.push(speed);
      else if (phase === "SHAKE") this.shake.push(speed);
    }
    return phase;
  }

  result(): Calibration {
    return calibrationFromSamples(this.rest, this.shake);
  }
}

export function calibrationFromSamples(rest: number[], shake: number[]): Calibration {
  const noise = percentile(rest, 0.9);
  const top = percentile(shake, 0.9);
  const deadZone = Math.max(DEFAULT_CALIBRATION.deadZone * 0.5, noise * 1.5);
  const valid =
    rest.length >= 5 &&
    shake.length >= 5 &&
    Number.isFinite(noise) &&
    Number.isFinite(top) &&
    deadZone < 5 &&
    top > deadZone * 2.5 &&
    top < 60;
  if (!valid) return DEFAULT_CALIBRATION;
  return { deadZone, maxSpeed: top, usedDefaults: false };
}
