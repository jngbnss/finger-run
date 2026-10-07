import { describe, expect, it } from "vitest";
import {
  CalibrationSession,
  DEFAULT_CALIBRATION,
  FingerPowerSignal,
  INDEX_TIP,
  MIDDLE_MCP,
  WRIST,
  calibrationFromSamples,
  fingerSpeed,
  median,
  palmScale,
  relativeTip,
  speedToPower,
  type Landmark,
} from "./fingerSignal";

/** 21 landmarks with the wrist at (wx, wy), palm length `palm`, index tip offset (tx, ty). */
function hand(wx: number, wy: number, tx: number, ty: number, palm = 0.2): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
  lm[WRIST] = { x: wx, y: wy };
  lm[MIDDLE_MCP] = { x: wx, y: wy - palm };
  lm[INDEX_TIP] = { x: wx + tx, y: wy + ty };
  return lm;
}

const mirror = (lm: Landmark[]) => lm.map((p) => ({ x: 1 - p.x, y: p.y }));

/** Feeds a tip oscillating with amplitude `amp` (normalized units) at `hz`, sampled at `fps`. */
function feed(signal: FingerPowerSignal, ms: number, opts: { amp: number; hz: number; fps?: number; t0?: number; palm?: number }) {
  const fps = opts.fps ?? 30;
  const t0 = opts.t0 ?? 0;
  let last = signal.update(null, t0);
  for (let t = t0; t <= t0 + ms; t += 1000 / fps) {
    const y = -0.15 + opts.amp * Math.sin((2 * Math.PI * opts.hz * t) / 1000);
    last = signal.update(hand(0.5, 0.7, 0.02, y, opts.palm ?? 0.2), t);
  }
  return last;
}

describe("landmark speed", () => {
  it("uses the index tip relative to the wrist and normalizes by palm size", () => {
    const a = hand(0.5, 0.5, 0, -0.1, 0.2);
    const b = hand(0.5, 0.5, 0, -0.14, 0.2);
    expect(relativeTip(a).x).toBeCloseTo(0);
    expect(relativeTip(a).y).toBeCloseTo(-0.1);
    expect(palmScale(a)).toBeCloseTo(0.2);
    // 0.04 tip movement / 0.2 palm / 0.1s = 2 palm lengths per second
    expect(fingerSpeed(relativeTip(a), relativeTip(b), palmScale(a), 0.1)).toBeCloseTo(2);
  });

  it("ignores whole-hand movement", () => {
    const signal = new FingerPowerSignal();
    // Hand slides across the frame but the finger does not move relative to the wrist.
    for (let i = 0; i <= 30; i++) signal.update(hand(0.2 + i * 0.02, 0.6, 0.03, -0.15), i * 33);
    expect(signal.update(hand(0.82, 0.6, 0.03, -0.15), 31 * 33).power).toBe(0);
  });

  it("gives the same speed for a hand twice as far away", () => {
    const near = new FingerPowerSignal();
    const far = new FingerPowerSignal();
    near.update(hand(0.5, 0.5, 0, -0.1, 0.2), 0);
    far.update(hand(0.5, 0.5, 0, -0.05, 0.1), 0);
    const n = near.update(hand(0.5, 0.5, 0, -0.14, 0.2), 50);
    const f = far.update(hand(0.5, 0.5, 0, -0.07, 0.1), 50);
    expect(n.rawSpeed).toBeCloseTo(f.rawSpeed);
  });

  it("clamps palm scale to at least 0.02", () => {
    expect(palmScale(hand(0.5, 0.5, 0, 0, 0.001))).toBe(0.02);
  });

  it("is unchanged by a mirrored preview", () => {
    const a = new FingerPowerSignal();
    const b = new FingerPowerSignal();
    let ra = a.update(null, 0);
    let rb = b.update(null, 0);
    for (let t = 0; t < 600; t += 33) {
      const lm = hand(0.4, 0.6, 0.05 * Math.sin(t / 40), -0.15, 0.2);
      ra = a.update(lm, t);
      rb = b.update(mirror(lm), t);
    }
    expect(ra.power).toBeGreaterThan(0);
    expect(rb.power).toBeCloseTo(ra.power, 9);
  });
});

describe("filtering and mapping", () => {
  it("drops samples with dt below 1/120s or above 0.2s", () => {
    const signal = new FingerPowerSignal();
    signal.update(hand(0.5, 0.5, 0, -0.1), 0);
    // 4ms later: too soon, no speed sample.
    expect(signal.update(hand(0.5, 0.5, 0, -0.2), 4).rawSpeed).toBe(0);
    // 400ms gap: too long, restarts instead of reporting a huge or tiny speed.
    expect(signal.update(hand(0.5, 0.5, 0, -0.3), 404).rawSpeed).toBe(0);
    // Normal 33ms frame is measured.
    expect(signal.update(hand(0.5, 0.5, 0, -0.32), 437).rawSpeed).toBeGreaterThan(0);
  });

  it("median rejects a single-frame outlier", () => {
    expect(median([1, 1.2, 50, 0.9, 1.1])).toBe(1.1);
    expect(median([])).toBe(0);
    expect(median([2, 4])).toBe(3);
  });

  it("smooths with an EMA instead of jumping", () => {
    const signal = new FingerPowerSignal();
    signal.update(hand(0.5, 0.5, 0, -0.1), 0);
    const first = signal.update(hand(0.5, 0.5, 0, -0.2), 33);
    // EMA alpha 0.25: smoothed speed is a quarter of the median on the first sample.
    expect(first.smoothedSpeed).toBeCloseTo(first.rawSpeed * 0.25);
  });

  it("maps speed monotonically with a dead zone and clamps to 0..100", () => {
    const cal = DEFAULT_CALIBRATION;
    expect(speedToPower(0, cal)).toBe(0);
    expect(speedToPower(cal.deadZone, cal)).toBe(0);
    expect(speedToPower(cal.maxSpeed, cal)).toBeCloseTo(100);
    expect(speedToPower(cal.maxSpeed * 5, cal)).toBe(100);
    expect(speedToPower(-3, cal)).toBe(0);
    expect(speedToPower(Number.NaN, cal)).toBe(0);
    let prev = -1;
    for (let s = 0; s < 20; s += 0.1) {
      const p = speedToPower(s, cal);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(100);
      prev = p;
    }
  });

  it("faster finger movement gives more power", () => {
    const slow = feed(new FingerPowerSignal(), 1000, { amp: 0.02, hz: 2 });
    const fast = feed(new FingerPowerSignal(), 1000, { amp: 0.06, hz: 4 });
    expect(fast.power).toBeGreaterThan(slow.power);
    expect(fast.power).toBeGreaterThan(50);
  });

  it("holds still hands at zero power", () => {
    const still = feed(new FingerPowerSignal(), 1000, { amp: 0.001, hz: 1 });
    expect(still.power).toBe(0);
  });
});

describe("hand loss", () => {
  it("holds power for 300ms, then decays to zero over 500ms", () => {
    const signal = new FingerPowerSignal();
    const moving = feed(signal, 1000, { amp: 0.06, hz: 4 });
    expect(moving.power).toBeGreaterThan(50);
    const lostAt = 1000;
    expect(signal.update(null, lostAt + 200).power).toBeCloseTo(moving.power);
    const mid = signal.update(null, lostAt + 300 + 250).power;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(moving.power);
    expect(signal.update(null, lostAt + 300 + 500).power).toBe(0);
    expect(signal.update(null, lostAt + 2000).handVisible).toBe(false);
  });

  it("does not spike when the hand reappears somewhere else", () => {
    const signal = new FingerPowerSignal();
    feed(signal, 500, { amp: 0.001, hz: 1 });
    signal.update(null, 600);
    signal.update(null, 1000);
    // Reappears with the finger far from its last position.
    const back = signal.update(hand(0.3, 0.4, 0.1, 0.1), 1033);
    expect(back.handVisible).toBe(true);
    expect(back.rawSpeed).toBe(0);
    expect(back.power).toBe(0);
    const next = signal.update(hand(0.3, 0.4, 0.1, 0.1), 1066);
    expect(next.power).toBe(0);
  });
});

describe("calibration", () => {
  it("derives dead zone and maximum from rest and shake samples", () => {
    const rest = Array.from({ length: 30 }, (_, i) => 0.2 + (i % 5) * 0.05);
    const shake = Array.from({ length: 30 }, (_, i) => 6 + (i % 6));
    const cal = calibrationFromSamples(rest, shake);
    expect(cal.usedDefaults).toBe(false);
    expect(cal.deadZone).toBeCloseTo(0.4 * 1.5);
    expect(cal.maxSpeed).toBeGreaterThan(9);
  });

  it("falls back to safe defaults on an implausible range", () => {
    expect(calibrationFromSamples([], [])).toEqual(DEFAULT_CALIBRATION);
    const same = Array.from({ length: 30 }, () => 3);
    expect(calibrationFromSamples(same, same)).toEqual(DEFAULT_CALIBRATION);
    const huge = Array.from({ length: 30 }, () => 500);
    expect(calibrationFromSamples(same.map(() => 0.1), huge)).toEqual(DEFAULT_CALIBRATION);
  });

  it("runs REST for 1s then SHAKE for 1s", () => {
    const session = new CalibrationSession();
    expect(session.add(0.1, 0)).toBe("REST");
    expect(session.add(0.1, 999)).toBe("REST");
    expect(session.add(8, 1000)).toBe("SHAKE");
    expect(session.add(8, 1999)).toBe("SHAKE");
    expect(session.add(8, 2000)).toBe("DONE");
  });
});
