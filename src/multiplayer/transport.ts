import type { RankedPlayer } from "./multiRace";
import type { InputMessage, PresenceState, RoomEvent, RoomState, SnapshotMessage } from "./protocol";

/** Room RPCs. Implemented by Supabase in production and by an in-memory fake in tests. */
export interface RoomBackend {
  /** Signs in anonymously (or reuses the session) and returns the user id. */
  signIn(): Promise<string>;
  createRoom(nickname: string): Promise<RoomState>;
  joinRoom(code: string, nickname: string): Promise<RoomState>;
  leaveRoom(roomId: string): Promise<void>;
  setReady(roomId: string, ready: boolean): Promise<RoomState>;
  startRace(roomId: string): Promise<RoomState>;
  finishRace(roomId: string, raceId: string, results: RankedPlayer[]): Promise<RoomState>;
  cancelRace(roomId: string, raceId: string, reason: string): Promise<RoomState>;
  heartbeat(roomId: string): Promise<RoomState>;
  /** Server epoch milliseconds. */
  serverNow(): Promise<number>;
}

export type ChannelStatus = "CONNECTING" | "CONNECTED" | "DISCONNECTED";

export interface RoomChannelHandlers {
  onPresence(states: PresenceState[]): void;
  onRoomEvent(event: RoomEvent): void;
  onSnapshot(msg: SnapshotMessage): void;
  onStatus(status: ChannelStatus): void;
}

/**
 * Topics:
 * - `room:{roomId}`: Presence (join/leave/ready only) and low-rate room events
 * - `room:{roomId}:snapshot`: host snapshots, max 5Hz
 * - `room:{roomId}:input:{userId}`: one player's power, max 4Hz; only the host listens
 */
export interface RoomChannel {
  track(state: PresenceState): void;
  sendRoomEvent(event: RoomEvent): void;
  sendSnapshot(msg: SnapshotMessage): void;
  sendInput(msg: InputMessage): void;
  /** Host only: listen to these players' input topics (replaces the previous set). */
  listenInputs(userIds: string[], onInput: (msg: InputMessage) => void): void;
  close(): void;
}

export interface RealtimeTransport {
  openRoom(roomId: string, userId: string, handlers: RoomChannelHandlers): RoomChannel;
}

export const roomTopic = (roomId: string) => `room:${roomId}`;
export const snapshotTopic = (roomId: string) => `room:${roomId}:snapshot`;
export const inputTopic = (roomId: string, userId: string) => `room:${roomId}:input:${userId}`;
