import { describe, expect, it } from "vitest";
import {
  MAX_SAMPLES,
  STORAGE_KEY,
  clearStoredBest,
  completedRun,
  ghostAt,
  loadBest,
  parseStoredBest,
  saveBestIfBetter,
} from "./ghost";
import { COUNTDOWN_S, createRace, startRace, stepRace } from "./raceEngine";
import type { RaceSnapshot, StoredBest } from "./types";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const best: StoredBest = {
  version: 1,
  timeMs: 2000,
  samples: [
    { elapsedMs: 0, distanceM: 0, smoothedPower: 0 },
    { elapsedMs: 1000, distanceM: 40, smoothedPower: 80 },
    { elapsedMs: 2000, distanceM: 100, smoothedPower: 100 },
  ],
};

function finishRace(power: number, dt = 1 / 60): RaceSnapshot {
  let race = startRace(createRace(power));
  for (let i = 0; i < 4000 && race.phase !== "FINISHED"; i++) race = stepRace(race, dt);
  return race;
}

describe("ghost interpolation", () => {
  it("clamps before the first sample", () => {
    expect(ghostAt(best, -50)).toEqual({ distanceM: 0, smoothedPower: 0, done: false });
  });

  it("interpolates between enclosing samples", () => {
    const mid = ghostAt(best, 500);
    expect(mid.distanceM).toBeCloseTo(20);
    expect(mid.smoothedPower).toBeCloseTo(40);
    expect(ghostAt(best, 1500).distanceM).toBeCloseTo(70);
    expect(ghostAt(best, 1000).distanceM).toBe(40);
  });

  it("clamps and pauses after the final sample", () => {
    expect(ghostAt(best, 9999)).toEqual({ distanceM: 100, smoothedPower: 100, done: true });
  });
});

describe("stored best validation", () => {
  it("accepts a valid object", () => {
    expect(parseStoredBest(best)).toEqual(best);
  });

  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["string", "fast"],
    ["wrong version", { ...best, version: 2 }],
    ["non-finite time", { ...best, timeMs: Number.POSITIVE_INFINITY }],
    ["negative time", { ...best, timeMs: -1 }],
    ["mismatched time", { ...best, timeMs: 2500 }],
    ["samples not array", { ...best, samples: {} }],
    ["single sample", { ...best, samples: [best.samples[0]] }],
    [
      "missing start sample",
      { ...best, samples: best.samples.map((s, i) => (i === 0 ? { ...s, elapsedMs: 10 } : s)) },
    ],
    [
      "missing finish sample",
      { ...best, samples: best.samples.map((s, i) => (i === 2 ? { ...s, distanceM: 99 } : s)) },
    ],
    [
      "unsorted",
      { ...best, samples: [best.samples[0], best.samples[2], best.samples[1]] },
    ],
    [
      "duplicate timestamp",
      { ...best, samples: [best.samples[0], best.samples[1], { ...best.samples[1] }, best.samples[2]] },
    ],
    [
      "distance out of range",
      { ...best, samples: best.samples.map((s, i) => (i === 1 ? { ...s, distanceM: 140 } : s)) },
    ],
    [
      "power out of range",
      { ...best, samples: best.samples.map((s, i) => (i === 1 ? { ...s, smoothedPower: 101 } : s)) },
    ],
    [
      "NaN value",
      { ...best, samples: best.samples.map((s, i) => (i === 1 ? { ...s, distanceM: Number.NaN } : s)) },
    ],
    [
      "too many samples",
      {
        version: 1,
        timeMs: MAX_SAMPLES,
        samples: Array.from({ length: MAX_SAMPLES + 1 }, (_, i) => ({
          elapsedMs: i,
          distanceM: i === MAX_SAMPLES ? 100 : 0,
          smoothedPower: 0,
        })),
      },
    ],
  ];

  it.each(malformed)("rejects %s", (_, value) => {
    expect(parseStoredBest(value)).toBeNull();
  });

  it("treats corrupt localStorage data as no best", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadBest(storage)).toEqual({ best: null, corrupt: true });
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, timeMs: 5, samples: [] }));
    expect(loadBest(storage)).toEqual({ best: null, corrupt: true });
    storage.setItem(STORAGE_KEY, JSON.stringify(best));
    expect(loadBest(storage)).toEqual({ best, corrupt: false });
  });
});

describe("recording and persisting", () => {
  it("records a valid run with 0ms and finish samples at 10Hz", () => {
    const race = finishRace(100);
    const run = completedRun(race);
    expect(run).not.toBeNull();
    expect(run!.samples[0]).toMatchObject({ elapsedMs: 0, distanceM: 0 });
    const last = run!.samples[run!.samples.length - 1];
    expect(last.elapsedMs).toBe(run!.timeMs);
    expect(last.distanceM).toBe(100);
    expect(run!.samples.length).toBeLessThanOrEqual(Math.ceil(run!.timeMs / 100) + 2);
    expect(run!.samples[1].elapsedMs).toBe(100);
  });

  it("replaces the scheduled sample when finish lands on it", () => {
    // 0.5625m at 18 m/s takes exactly 0.03125s, landing on the 1000ms sample.
    const done = stepRace(
      {
        ...createRace(100),
        phase: "RUNNING",
        smoothedPower: 100,
        distanceM: 99.4375,
        elapsedS: 0.96875,
        samples: [
          { elapsedMs: 0, distanceM: 0, smoothedPower: 0 },
          { elapsedMs: 900, distanceM: 97.6, smoothedPower: 100 },
        ],
      },
      0.05,
    );
    expect(done.phase).toBe("FINISHED");
    expect(done.finishTimeMs).toBe(1000);
    expect(done.samples.map((s) => s.elapsedMs)).toEqual([0, 900, 1000]);
    expect(done.samples[2].distanceM).toBe(100);
    expect(completedRun(done)).not.toBeNull();
  });

  it("saves only when a completed run beats the best", () => {
    const storage = new MemoryStorage();
    const slow = completedRun(finishRace(60))!;
    const fast = completedRun(finishRace(100))!;

    let result = saveBestIfBetter(storage, null, slow);
    expect(result.improved).toBe(true);
    expect(loadBest(storage).best?.timeMs).toBe(slow.timeMs);

    result = saveBestIfBetter(storage, result.best, fast);
    expect(result.improved).toBe(true);
    expect(loadBest(storage).best).toEqual(fast);

    result = saveBestIfBetter(storage, result.best, slow);
    expect(result.improved).toBe(false);
    expect(loadBest(storage).best).toEqual(fast);

    clearStoredBest(storage);
    expect(loadBest(storage).best).toBeNull();
  });

  it("never persists a DNF run", () => {
    const storage = new MemoryStorage();
    let race = startRace(createRace(0));
    for (let i = 0; i < (COUNTDOWN_S + 61) * 20; i++) race = stepRace(race, 0.05);
    expect(race.phase).toBe("DNF");
    expect(completedRun(race)).toBeNull();
    expect(saveBestIfBetter(storage, null, completedRun(race)).improved).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});
