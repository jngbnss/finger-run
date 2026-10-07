import { COUNTDOWN_S, MAX_FRAME_DT_S, createRace, setTargetPower, startRace, stepRace } from "../game/raceEngine";
import type { RaceSnapshot } from "../game/types";
import {
  INPUT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type InputMessage,
  type PlayerRaceStatus,
  type SnapshotMessage,
  type SnapshotPhase,
  type SnapshotPlayer,
} from "./protocol";

/**
 * Pure multi-player race coordinator run by the host. Each player gets the same
 * single-player raceEngine; the host only feeds it the players' power inputs.
 * No React, network or three.js here.
 */

export interface MultiPlayerState {
  userId: string;
  lane: number;
  race: RaceSnapshot;
  lastSeq: number;
  /** Server ms when the host last accepted an input; null before the first one. */
  lastInputAt: number | null;
}

export interface MultiRaceState {
  raceId: string;
  /** Server epoch ms when GO happens. */
  startAt: number;
  /** Server ms the simulation has been advanced to. */
  simTime: number;
  phase: SnapshotPhase;
  players: MultiPlayerState[];
  snapshotSeq: number;
}

export function createMultiRace(
  raceId: string,
  startAt: number,
  players: Array<{ userId: string; lane: number }>,
): MultiRaceState {
  return {
    raceId,
    startAt,
    // The engine's own 3s countdown is aligned so RUNNING begins exactly at startAt.
    simTime: startAt - COUNTDOWN_S * 1000,
    phase: "COUNTDOWN",
    players: [...players]
      .sort((a, b) => a.lane - b.lane)
      .map((p) => ({
        userId: p.userId,
        lane: p.lane,
        race: startRace(createRace(0)),
        lastSeq: -1,
        lastInputAt: null,
      })),
    snapshotSeq: 0,
  };
}

/**
 * Accepts a player's power. Only raceId, userId, seq and power are used;
 * duplicates and out-of-order sequences are ignored.
 */
export function applyInput(state: MultiRaceState, msg: InputMessage, receivedAt: number): MultiRaceState {
  if (msg.v !== PROTOCOL_VERSION || msg.raceId !== state.raceId) return state;
  if (!Number.isFinite(msg.seq) || !Number.isFinite(msg.power)) return state;
  const index = state.players.findIndex((p) => p.userId === msg.userId);
  if (index < 0) return state;
  const player = state.players[index];
  if (msg.seq <= player.lastSeq) return state;

  const players = state.players.slice();
  players[index] = {
    ...player,
    race: setTargetPower(player.race, msg.power),
    lastSeq: msg.seq,
    lastInputAt: receivedAt,
  };
  return { ...state, players };
}

const MAX_CATCH_UP_MS = 70_000;

/** Advances every player to `serverNow` in engine-sized steps. */
export function stepMultiRace(state: MultiRaceState, serverNow: number): MultiRaceState {
  if (state.phase === "FINISHED" || serverNow <= state.simTime) return state;

  let simTime = state.simTime;
  const target = Math.min(serverNow, simTime + MAX_CATCH_UP_MS);
  let players = state.players;

  while (simTime < target) {
    const dtMs = Math.min(MAX_FRAME_DT_S * 1000, target - simTime);
    simTime += dtMs;
    players = players.map((p) => {
      let race = p.race;
      // No input for 1.5s: drop target power so speed decays through the engine's smoothing.
      if (p.lastInputAt !== null && simTime - p.lastInputAt > INPUT_TIMEOUT_MS && race.targetPower !== 0) {
        race = setTargetPower(race, 0);
      }
      race = stepRace(race, dtMs / 1000);
      return race === p.race ? p : { ...p, race };
    });
  }

  const allDone = players.every((p) => p.race.phase === "FINISHED" || p.race.phase === "DNF");
  const phase: SnapshotPhase = allDone ? "FINISHED" : simTime >= state.startAt ? "RUNNING" : "COUNTDOWN";
  return { ...state, simTime, players, phase };
}

export function playerStatus(race: RaceSnapshot): PlayerRaceStatus {
  switch (race.phase) {
    case "RUNNING":
      return "RUNNING";
    case "FINISHED":
      return "FINISHED";
    case "DNF":
      return "DNF";
    default:
      return "WAITING";
  }
}

export function snapshotPlayers(state: MultiRaceState): SnapshotPlayer[] {
  return state.players.map((p) => ({
    userId: p.userId,
    lane: p.lane,
    power: p.race.smoothedPower,
    distanceM: p.race.distanceM,
    speedMps: p.race.speedMps,
    finishTimeMs: p.race.finishTimeMs,
    status: playerStatus(p.race),
  }));
}

/** Builds the next broadcast snapshot (no camera data, landmarks or ghost samples). */
export function takeSnapshot(state: MultiRaceState, serverNow: number): [MultiRaceState, SnapshotMessage] {
  const seq = state.snapshotSeq + 1;
  return [
    { ...state, snapshotSeq: seq },
    {
      v: PROTOCOL_VERSION,
      raceId: state.raceId,
      seq,
      serverNow,
      phase: state.phase,
      startAt: state.startAt,
      players: snapshotPlayers(state),
    },
  ];
}

export interface RankedPlayer extends SnapshotPlayer {
  rank: number;
}

function compareForRank(a: SnapshotPlayer, b: SnapshotPlayer): number {
  const aDone = a.status === "FINISHED" && a.finishTimeMs !== null;
  const bDone = b.status === "FINISHED" && b.finishTimeMs !== null;
  if (aDone !== bDone) return aDone ? -1 : 1;
  if (aDone && bDone) return a.finishTimeMs! - b.finishTimeMs!;
  return b.distanceM - a.distanceM;
}

/**
 * Finishers by exact finish time, then everyone else by distance.
 * Exact ties share a rank (1, 1, 3); tied players are listed by lane.
 */
export function rankPlayers(players: SnapshotPlayer[]): RankedPlayer[] {
  const sorted = [...players].sort((a, b) => compareForRank(a, b) || a.lane - b.lane);
  const ranked: RankedPlayer[] = [];
  sorted.forEach((p, i) => {
    const prev = ranked[i - 1];
    const tied = prev && compareForRank(prev, p) === 0;
    ranked.push({ ...p, rank: tied ? prev.rank : i + 1 });
  });
  return ranked;
}
