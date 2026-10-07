import { describe, expect, it } from "vitest";
import {
  animationScaleFromPower,
  clampPower,
  effectivePower,
  smoothPower,
  speedFromPower,
} from "./powerCurve";
import {
  COUNTDOWN_S,
  createRace,
  overlayLabel,
  resetRace,
  setTargetPower,
  startRace,
  stepRace,
} from "./raceEngine";
import type { RaceSnapshot } from "./types";

function run(state: RaceSnapshot, seconds: number, dt = 1 / 60): RaceSnapshot {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) state = stepRace(state, dt);
  return state;
}

/** A race already RUNNING at steady full power. */
function runningAtFullPower(overrides: Partial<RaceSnapshot> = {}): RaceSnapshot {
  return {
    ...createRace(100),
    phase: "RUNNING",
    smoothedPower: 100,
    speedMps: 18,
    animationScale: 2.4,
    countdownElapsedS: COUNTDOWN_S,
    samples: [{ elapsedMs: 0, distanceM: 0, smoothedPower: 100 }],
    ...overrides,
  };
}

describe("power curve", () => {
  it("clamps power to [0, 100] and applies the dead zone", () => {
    expect(clampPower(-20)).toBe(0);
    expect(clampPower(150)).toBe(100);
    expect(clampPower(Number.NaN)).toBe(0);
    expect(setTargetPower(createRace(), 250).targetPower).toBe(100);
    expect(effectivePower(4.99)).toBe(0);
    expect(speedFromPower(4.99)).toBe(0);
    expect(animationScaleFromPower(4.99)).toBe(0);
    expect(effectivePower(5)).toBe(0);
    expect(effectivePower(100)).toBe(1);
    expect(speedFromPower(100)).toBeCloseTo(18);
    expect(animationScaleFromPower(100)).toBeCloseTo(2.4);
  });

  it("maps power to speed monotonically", () => {
    let prev = -1;
    for (let p = 0; p <= 100; p += 0.5) {
      const speed = speedFromPower(p);
      expect(speed).toBeGreaterThanOrEqual(prev);
      prev = speed;
    }
    expect(speedFromPower(80)).toBeGreaterThan(speedFromPower(40));
  });

  it("zero power produces zero speed and no movement", () => {
    expect(speedFromPower(0)).toBe(0);
    let race = startRace(createRace(0));
    race = run(race, COUNTDOWN_S + 5);
    expect(race.phase).toBe("RUNNING");
    expect(race.speedMps).toBe(0);
    expect(race.animationScale).toBe(0);
    expect(race.distanceM).toBe(0);
  });
});

describe("race engine", () => {
  it("counts down 3, 2, 1 then switches to RUNNING with GO!", () => {
    let race = startRace(createRace(50));
    expect(race.phase).toBe("COUNTDOWN");
    expect(overlayLabel(race)).toBe("3");
    // 1/32s frames sum exactly in binary floating point.
    const dt = 1 / 32;
    race = run(race, 1.0, dt);
    expect(overlayLabel(race)).toBe("2");
    race = run(race, 1.0, dt);
    expect(overlayLabel(race)).toBe("1");
    race = run(race, 1 - dt, dt);
    expect(race.phase).toBe("COUNTDOWN");
    expect(race.distanceM).toBe(0);
    expect(race.elapsedS).toBe(0);
    race = stepRace(race, dt);
    expect(race.phase).toBe("RUNNING");
    expect(overlayLabel(race)).toBe("GO!");
    race = run(race, 0.5, 0.05);
    expect(overlayLabel(race)).toBeNull();
  });

  it("smooths power during countdown but does not move", () => {
    const race = run(startRace(createRace(100)), 2);
    expect(race.smoothedPower).toBeGreaterThan(99);
    expect(race.distanceM).toBe(0);
  });

  it("integrates distance from speed", () => {
    let race = runningAtFullPower();
    race = stepRace(race, 0.05);
    expect(race.distanceM).toBeCloseTo(0.9, 10);
    expect(race.elapsedS).toBeCloseTo(0.05, 10);
    race = run(race, 1, 0.05);
    expect(race.distanceM).toBeCloseTo(18.9, 8);
  });

  it("clamps large frame gaps so hidden-tab time does not count", () => {
    const race = stepRace(runningAtFullPower(), 5);
    expect(race.elapsedS).toBeCloseTo(0.05, 10);
    expect(race.distanceM).toBeCloseTo(0.9, 10);
  });

  it("finishes exactly at 100m and then freezes", () => {
    let race = run(startRace(createRace(100)), 20);
    expect(race.phase).toBe("FINISHED");
    expect(race.distanceM).toBe(100);
    expect(race.finishTimeMs).not.toBeNull();
    const frozen = run(race, 2);
    expect(frozen).toBe(race);
  });

  it("records only the partial-frame time when crossing the finish", () => {
    const race = stepRace(runningAtFullPower({ distanceM: 99.5, elapsedS: 5 }), 0.05);
    expect(race.phase).toBe("FINISHED");
    expect(race.distanceM).toBe(100);
    const expectedS = 5 + 0.5 / 18;
    expect(race.elapsedS).toBeCloseTo(expectedS, 10);
    expect(race.finishTimeMs).toBeCloseTo(expectedS * 1000, 7);
    const last = race.samples[race.samples.length - 1];
    expect(last.elapsedMs).toBe(race.finishTimeMs);
    expect(last.distanceM).toBe(100);
  });

  it("finish wins an exact tie with timeout", () => {
    // 0.5625m left at 18 m/s takes exactly 0.03125s, which is also the time left.
    const race = stepRace(runningAtFullPower({ distanceM: 99.4375, elapsedS: 59.96875 }), 0.05);
    expect(race.phase).toBe("FINISHED");
  });

  it("becomes DNF at exactly 60s without a finish time", () => {
    let race = run(startRace(createRace(0)), COUNTDOWN_S + 70, 0.05);
    expect(race.phase).toBe("DNF");
    expect(race.elapsedS).toBe(60);
    expect(race.finishTimeMs).toBeNull();
    race = setTargetPower(race, 100);
    expect(stepRace(race, 0.05)).toBe(race);
  });

  it("reset returns to IDLE, keeps the slider, clears smoothed power", () => {
    const mid = run(startRace(createRace(80)), COUNTDOWN_S + 2);
    expect(mid.phase).toBe("RUNNING");
    expect(mid.distanceM).toBeGreaterThan(0);
    const reset = resetRace(mid);
    expect(reset.phase).toBe("IDLE");
    expect(reset.targetPower).toBe(80);
    expect(reset.smoothedPower).toBe(0);
    expect(reset.distanceM).toBe(0);
    expect(reset.elapsedS).toBe(0);
    expect(reset.samples).toEqual([]);
    // IDLE freezes smoothing.
    expect(run(reset, 1).smoothedPower).toBe(0);
  });

  it("accepts START only in IDLE", () => {
    const running = runningAtFullPower();
    expect(startRace(running)).toBe(running);
    const countdown = startRace(createRace());
    expect(startRace(countdown)).toBe(countdown);
  });

  it("smooths to near-equal values for equal duration across frame sizes", () => {
    const coarse = run(startRace(createRace(70)), 0.6, 0.05);
    const fine = run(startRace(createRace(70)), 0.6, 0.01);
    const odd = run(startRace(createRace(70)), 0.6, 0.6 / 37);
    expect(coarse.smoothedPower).toBeCloseTo(fine.smoothedPower, 9);
    expect(coarse.smoothedPower).toBeCloseTo(odd.smoothedPower, 9);
    expect(smoothPower(0, 70, 0.6)).toBeCloseTo(fine.smoothedPower, 9);
  });

  it("decays speed after target drops to zero", () => {
    let race = runningAtFullPower();
    race = setTargetPower(race, 0);
    race = stepRace(race, 0.05);
    expect(race.speedMps).toBeGreaterThan(0);
    expect(race.speedMps).toBeLessThan(18);
    race = run(race, 1.5, 0.05);
    expect(race.smoothedPower).toBeLessThan(5);
    expect(race.speedMps).toBe(0);
  });
});
