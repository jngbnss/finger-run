import { describe, expect, it } from "vitest";
import { clockOffset, measureClockOffset } from "./clock";
import { assignLane } from "./lanes";
import { TIMEOUT_S } from "../game/raceEngine";
import { applyInput, createMultiRace, rankPlayers, stepMultiRace, takeSnapshot } from "./multiRace";
import { PROTOCOL_VERSION, type InputMessage, type SnapshotMessage, type SnapshotPlayer } from "./protocol";
import { SnapshotBuffer } from "./snapshotBuffer";

const START = 1_000_000;
const ids = ["a", "b", "c", "d", "e", "f", "g"];

function input(userId: string, seq: number, power: number, raceId = "race-1"): InputMessage {
  return { v: PROTOCOL_VERSION, raceId, userId, seq, power, sentAt: 0 };
}

function race7() {
  return createMultiRace(
    "race-1",
    START,
    ids.map((userId, i) => ({ userId, lane: i + 1 })),
  );
}

describe("server clock offset", () => {
  it("uses the midpoint of the shortest round trip", () => {
    const result = clockOffset([
      { t0: 0, server: 5000, t1: 400 }, // rtt 400
      { t0: 1000, server: 6040, t1: 1080 }, // rtt 80 -> offset 6040 - 1040 = 5000
      { t0: 2000, server: 7300, t1: 2300 },
    ]);
    expect(result.rttMs).toBe(80);
    expect(result.offsetMs).toBe(5000);
  });

  it("ignores broken samples and defaults to zero", () => {
    expect(clockOffset([]).offsetMs).toBe(0);
    expect(clockOffset([{ t0: 10, server: Number.NaN, t1: 20 }]).offsetMs).toBe(0);
  });

  it("takes five measurements", async () => {
    let local = 0;
    let calls = 0;
    const result = await measureClockOffset(
      async () => {
        calls++;
        local += calls === 3 ? 10 : 100;
        return local + 2500;
      },
      () => local,
    );
    expect(calls).toBe(5);
    expect(result.rttMs).toBe(10);
    expect(result.offsetMs).toBeCloseTo(2505);
  });
});

describe("lanes", () => {
  it("assigns lanes 1..7 and rejects the 8th", () => {
    const taken: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const lane = assignLane(taken);
      expect(lane).toBe(i);
      taken.push(lane as number);
    }
    expect(assignLane(taken)).toBe("ROOM_FULL");
  });

  it("reuses the lowest free lane", () => {
    expect(assignLane([1, 2, 4])).toBe(3);
    expect(assignLane([2, 3, 4, 5, 6, 7])).toBe(1);
  });
});

describe("multi race coordinator", () => {
  it("ignores duplicate, out-of-order and foreign inputs", () => {
    let state = race7();
    state = applyInput(state, input("a", 5, 80), START);
    expect(state.players[0].race.targetPower).toBe(80);
    const same = applyInput(state, input("a", 5, 10), START);
    expect(same).toBe(state);
    const older = applyInput(state, input("a", 4, 10), START);
    expect(older).toBe(state);
    expect(applyInput(state, input("a", 6, 10, "other-race"), START)).toBe(state);
    expect(applyInput(state, input("zz", 6, 10), START)).toBe(state);
    expect(applyInput(state, { ...input("a", 6, 10), v: 999 }, START)).toBe(state);
    expect(applyInput(state, input("a", 6, 30), START).players[0].race.targetPower).toBe(30);
  });

  it("clamps untrusted power", () => {
    const state = applyInput(race7(), input("b", 1, 9999), START);
    expect(state.players[1].race.targetPower).toBe(100);
  });

  it("does not move anyone before GO and starts all 7 at startAt", () => {
    let state = race7();
    ids.forEach((id) => (state = applyInput(state, input(id, 1, 100), START - 3000)));
    state = stepMultiRace(state, START - 10);
    expect(state.phase).toBe("COUNTDOWN");
    expect(state.players.every((p) => p.race.distanceM === 0)).toBe(true);
    ids.forEach((id) => (state = applyInput(state, input(id, 2, 100), START - 10)));
    state = stepMultiRace(state, START + 1000);
    expect(state.phase).toBe("RUNNING");
    expect(state.players.every((p) => p.race.phase === "RUNNING" && p.race.distanceM > 0)).toBe(true);
  });

  it("decays power to zero after 1.5s without input", () => {
    let state = applyInput(race7(), input("a", 1, 100), START);
    state = stepMultiRace(state, START + 1400);
    expect(state.players[0].race.targetPower).toBe(100);
    state = stepMultiRace(state, START + 1600);
    expect(state.players[0].race.targetPower).toBe(0);
    state = stepMultiRace(state, START + 4000);
    expect(state.players[0].race.speedMps).toBe(0);
  });

  it("finishes when all 7 are FINISHED or DNF", () => {
    let state = race7();
    ids.forEach((id, i) => (state = applyInput(state, input(id, 1, i === 6 ? 0 : 100 - i * 5), START - 3000)));
    for (let t = START - 3000; t <= START + (TIMEOUT_S + 1) * 1000; t += 1000) {
      // Keep inputs fresh.
      ids.forEach((id, i) => (state = applyInput(state, input(id, t, i === 6 ? 0 : 100 - i * 5), t)));
      state = stepMultiRace(state, t);
    }
    expect(state.phase).toBe("FINISHED");
    expect(state.players.slice(0, 6).every((p) => p.race.phase === "FINISHED")).toBe(true);
    expect(state.players[6].race.phase).toBe("DNF");
    const [, snapshot] = takeSnapshot(state, START + (TIMEOUT_S + 1) * 1000);
    const ranked = rankPlayers(snapshot.players);
    expect(ranked.map((p) => p.userId)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(ranked[6].status).toBe("DNF");
  });
});

describe("ranking", () => {
  const p = (userId: string, lane: number, status: SnapshotPlayer["status"], finishTimeMs: number | null, distanceM: number): SnapshotPlayer => ({
    userId,
    lane,
    power: 0,
    distanceM,
    speedMps: 0,
    finishTimeMs,
    status,
  });

  it("orders 7 finishers by exact finish time and shares ranks on ties", () => {
    const ranked = rankPlayers([
      p("g", 7, "FINISHED", 9000.0000001, 100),
      p("c", 3, "FINISHED", 8000, 100),
      p("a", 1, "FINISHED", 8000, 100),
      p("b", 2, "FINISHED", 7000, 100),
      p("f", 6, "DNF", null, 80),
      p("d", 4, "FINISHED", 9000, 100),
      p("e", 5, "DNF", null, 80),
    ]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 2],
      ["d", 4],
      ["g", 5],
      ["e", 6],
      ["f", 6],
    ]);
  });

  it("ranks unfinished runners by distance during the race", () => {
    const ranked = rankPlayers([p("a", 1, "RUNNING", null, 20), p("b", 2, "RUNNING", null, 55), p("c", 3, "FINISHED", 5000, 100)]);
    expect(ranked.map((r) => r.userId)).toEqual(["c", "b", "a"]);
  });
});

describe("snapshot buffer", () => {
  const snap = (seq: number, serverNow: number, distance: number, raceId = "r1"): SnapshotMessage => ({
    v: PROTOCOL_VERSION,
    raceId,
    seq,
    serverNow,
    phase: "RUNNING",
    startAt: 0,
    players: [{ userId: "a", lane: 1, power: 50, distanceM: distance, speedMps: 5, finishTimeMs: null, status: "RUNNING" }],
  });

  it("ignores duplicate and out-of-order snapshots", () => {
    const buf = new SnapshotBuffer();
    expect(buf.push(snap(2, 200, 2), 0)).toBe(true);
    expect(buf.push(snap(2, 200, 9), 0)).toBe(false);
    expect(buf.push(snap(1, 100, 1), 0)).toBe(false);
    expect(buf.latest()?.seq).toBe(2);
  });

  it("interpolates between snapshots and never extrapolates", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(1, 1000, 10), 0);
    buf.push(snap(2, 1200, 12), 0);
    expect(buf.sample(1100)[0].distanceM).toBeCloseTo(11);
    expect(buf.sample(900)[0].distanceM).toBe(10);
    expect(buf.sample(5000)[0].distanceM).toBe(12);
  });

  it("goes stale 1.5s after the last snapshot", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(1, 1000, 10), 10_000);
    expect(buf.isStale(11_400)).toBe(false);
    expect(buf.isStale(11_600)).toBe(true);
  });

  it("starts over for a new race", () => {
    const buf = new SnapshotBuffer();
    buf.push(snap(9, 1000, 50, "r1"), 0);
    expect(buf.push(snap(1, 2000, 0, "r2"), 0)).toBe(true);
    expect(buf.raceId).toBe("r2");
  });
});
