/** Bump when message shapes change; peers on another version get VERSION_MISMATCH. */
export const PROTOCOL_VERSION = 2;

export const MAX_PLAYERS = 7;
export const MIN_PLAYERS = 2;
export const INPUT_HZ = 4;
export const SNAPSHOT_HZ = 5;
export const INPUT_TIMEOUT_MS = 1500;
export const STALE_SNAPSHOT_MS = 1500;
export const HEARTBEAT_MS = 2000;
export const RECONNECT_GRACE_MS = 10_000;
export const HOST_RACE_GRACE_MS = 5000;
export const START_DELAY_MS = 5000;

export type ErrorCode =
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_NOT_FOUND"
  | "CAMERA_STREAM_ENDED"
  | "CAMERA_INSECURE_CONTEXT"
  | "HAND_MODEL_LOAD_FAILED"
  | "HAND_NOT_VISIBLE"
  | "REALTIME_CONFIG_MISSING"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ROOM_ALREADY_RUNNING"
  | "NOT_HOST"
  | "NOT_ALL_READY"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_NICKNAME"
  | "CONNECTION_LOST"
  | "HOST_DISCONNECTED"
  | "VERSION_MISMATCH"
  | "UNKNOWN";

const KNOWN_ROOM_ERRORS: ErrorCode[] = [
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_ALREADY_RUNNING",
  "NOT_HOST",
  "NOT_ALL_READY",
  "NOT_ENOUGH_PLAYERS",
  "INVALID_NICKNAME",
  "CONNECTION_LOST",
];

export class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RoomError";
  }
}

/** Maps a backend error message such as "ROOM_FULL" to a typed error. */
export function toRoomError(error: unknown): RoomError {
  if (error instanceof RoomError) return error;
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  const code = KNOWN_ROOM_ERRORS.find((c) => text?.includes(c));
  return new RoomError(code ?? "UNKNOWN", text || "Unknown error");
}

export type RoomStatus = "LOBBY" | "COUNTDOWN" | "RUNNING" | "FINISHED";

export interface RoomPlayer {
  userId: string;
  nickname: string;
  lane: number;
  ready: boolean;
  joinedAt: number;
}

/** Authoritative room row as returned by every room RPC. */
export interface RoomState {
  id: string;
  code: string;
  hostId: string;
  status: RoomStatus;
  raceId: string | null;
  /** Server epoch ms. */
  startAt: number | null;
  cancelReason: string | null;
  players: RoomPlayer[];
  /** Final ranking saved by the host with finish_room_race(); null until then. */
  results?: Array<SnapshotPlayer & { rank: number }> | null;
}

export type PlayerRaceStatus = "WAITING" | "RUNNING" | "FINISHED" | "DNF";

export interface InputMessage {
  v: number;
  raceId: string;
  userId: string;
  seq: number;
  power: number;
  sentAt: number;
}

export interface SnapshotPlayer {
  userId: string;
  lane: number;
  power: number;
  distanceM: number;
  speedMps: number;
  finishTimeMs: number | null;
  status: PlayerRaceStatus;
}

export type SnapshotPhase = "COUNTDOWN" | "RUNNING" | "FINISHED";

export interface SnapshotMessage {
  v: number;
  raceId: string;
  seq: number;
  serverNow: number;
  phase: SnapshotPhase;
  startAt: number;
  players: SnapshotPlayer[];
}

/** Low-frequency lobby events on the room channel. */
export type RoomEvent =
  | { v: number; type: "room-changed" }
  | { v: number; type: "race-started"; raceId: string; startAt: number }
  | { v: number; type: "race-finished"; raceId: string };

/** Presence payload; tracked only on join, leave and ready/camera changes. */
export interface PresenceState {
  v: number;
  userId: string;
  nickname: string;
  lane: number;
  ready: boolean;
  cameraReady: boolean;
  /** Changes whenever the player uploads a new skin; null when not sharing one. */
  skin: string | null;
}

export const NICKNAME_MAX = 16;

export function normalizeNickname(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && [...name].length <= NICKNAME_MAX ? name : null;
}

export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}
