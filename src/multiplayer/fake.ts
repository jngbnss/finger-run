import { assignLane } from "./lanes";
import type { RankedPlayer } from "./multiRace";
import {
  HOST_RACE_GRACE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  RECONNECT_GRACE_MS,
  RoomError,
  START_DELAY_MS,
  normalizeNickname,
  normalizeRoomCode,
  type InputMessage,
  type PresenceState,
  type RoomEvent,
  type RoomState,
  type RoomStatus,
  type SnapshotMessage,
} from "./protocol";
import {
  inputTopic,
  roomTopic,
  skinPath,
  snapshotTopic,
  type ChannelStatus,
  type RealtimeTransport,
  type RoomBackend,
  type RoomChannel,
  type RoomChannelHandlers,
} from "./transport";

/**
 * In-memory stand-ins for Supabase used by integration and browser tests.
 * FakeRoomServer follows the same rules as supabase/migrations (lanes, ROOM_FULL,
 * host-only actions, pruning, host migration, host-disconnect cancellation).
 */

interface FakePlayer {
  userId: string;
  nickname: string;
  lane: number;
  ready: boolean;
  joinedAt: number;
  lastSeenAt: number;
}

interface FakeRoom {
  id: string;
  code: string;
  hostId: string;
  status: RoomStatus;
  raceId: string | null;
  startAt: number | null;
  cancelReason: string | null;
  results: RankedPlayer[] | null;
  players: Map<string, FakePlayer>;
  lastActivityAt: number;
}

const STALE_ROOM_MS = 10 * 60 * 1000;

export class FakeRoomServer {
  private rooms = new Map<string, FakeRoom>();
  /** Skin files by "roomId/userId.png"; data is opaque (Blob in Node tests, base64 over the browser bridge). */
  readonly skins = new Map<string, unknown>();
  private ids = 0;
  private joinOrder = 0;

  constructor(readonly now: () => number = Date.now) {}

  private newId(prefix: string) {
    this.ids += 1;
    return `${prefix}-${this.ids.toString(16).padStart(8, "0")}`;
  }

  private newCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (;;) {
      let code = "";
      for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
      if (![...this.rooms.values()].some((r) => r.code === code)) return code;
    }
  }

  private state(room: FakeRoom): RoomState {
    return {
      id: room.id,
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      raceId: room.raceId,
      startAt: room.startAt,
      cancelReason: room.cancelReason,
      results: room.results ? structuredClone(room.results) : null,
      players: [...room.players.values()]
        .sort((a, b) => a.lane - b.lane)
        .map(({ userId, nickname, lane, ready, joinedAt }) => ({ userId, nickname, lane, ready, joinedAt })),
    };
  }

  private cleanupStaleRooms() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if ((room.status === "LOBBY" || room.status === "FINISHED") && now - room.lastActivityAt > STALE_ROOM_MS) {
        this.rooms.delete(room.id);
      }
    }
  }

  private earliestFresh(room: FakeRoom, freshMs: number, exclude?: string): FakePlayer | undefined {
    const now = this.now();
    return [...room.players.values()]
      .filter((p) => p.userId !== exclude && now - p.lastSeenAt <= freshMs)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  }

  /** Lobby only: drop players unseen for 10s, migrate host, delete empty rooms. */
  private prune(room: FakeRoom) {
    if (room.status !== "LOBBY" && room.status !== "FINISHED") return;
    const now = this.now();
    for (const p of [...room.players.values()]) {
      if (now - p.lastSeenAt > RECONNECT_GRACE_MS) room.players.delete(p.userId);
    }
    this.fixHost(room);
  }

  private fixHost(room: FakeRoom) {
    if (room.players.size === 0) {
      this.rooms.delete(room.id);
      return;
    }
    if (!room.players.has(room.hostId)) {
      const next = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = next.userId;
    }
  }

  private advance(room: FakeRoom) {
    if (room.status === "COUNTDOWN" && room.startAt !== null && room.startAt <= this.now()) {
      room.status = "RUNNING";
    }
  }

  private member(uid: string, roomId: string): FakeRoom {
    const room = this.rooms.get(roomId);
    if (!room || !room.players.has(uid)) throw new RoomError("ROOM_NOT_FOUND", "ROOM_NOT_FOUND");
    return room;
  }

  private nickname(raw: string) {
    const name = normalizeNickname(raw);
    if (!name) throw new RoomError("INVALID_NICKNAME", "INVALID_NICKNAME");
    return name;
  }

  createRoom(uid: string, rawNickname: string): RoomState {
    const nickname = this.nickname(rawNickname);
    this.cleanupStaleRooms();
    const now = this.now();
    const room: FakeRoom = {
      id: this.newId("room"),
      code: this.newCode(),
      hostId: uid,
      status: "LOBBY",
      raceId: null,
      startAt: null,
      cancelReason: null,
      results: null,
      players: new Map(),
      lastActivityAt: now,
    };
    room.players.set(uid, { userId: uid, nickname, lane: 1, ready: false, joinedAt: now + this.joinOrder++ * 1e-3, lastSeenAt: now });
    this.rooms.set(room.id, room);
    return this.state(room);
  }

  joinRoom(uid: string, rawCode: string, rawNickname: string): RoomState {
    const nickname = this.nickname(rawNickname);
    const code = normalizeRoomCode(rawCode);
    this.cleanupStaleRooms();
    const room = [...this.rooms.values()].find((r) => r.code === code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "ROOM_NOT_FOUND");
    const now = this.now();
    this.advance(room);
    this.prune(room);
    if (!this.rooms.has(room.id)) throw new RoomError("ROOM_NOT_FOUND", "ROOM_NOT_FOUND");

    const existing = room.players.get(uid);
    if (existing) {
      // Same anonymous user coming back: keep the slot.
      existing.lastSeenAt = now;
      existing.nickname = nickname;
      room.lastActivityAt = now;
      return this.state(room);
    }
    if (room.status === "COUNTDOWN" || room.status === "RUNNING") {
      throw new RoomError("ROOM_ALREADY_RUNNING", "ROOM_ALREADY_RUNNING");
    }
    const lane = assignLane([...room.players.values()].map((p) => p.lane));
    if (lane === "ROOM_FULL" || room.players.size >= MAX_PLAYERS) throw new RoomError("ROOM_FULL", "ROOM_FULL");
    room.players.set(uid, { userId: uid, nickname, lane, ready: false, joinedAt: now + this.joinOrder++ * 1e-3, lastSeenAt: now });
    room.lastActivityAt = now;
    return this.state(room);
  }

  leaveRoom(uid: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || !room.players.has(uid)) return;
    room.players.delete(uid);
    if (room.hostId === uid && (room.status === "COUNTDOWN" || room.status === "RUNNING")) {
      this.cancel(room, "HOST_DISCONNECTED");
    }
    this.fixHost(room);
  }

  setReady(uid: string, roomId: string, ready: boolean): RoomState {
    const room = this.member(uid, roomId);
    this.advance(room);
    if (room.status === "COUNTDOWN" || room.status === "RUNNING") {
      throw new RoomError("ROOM_ALREADY_RUNNING", "ROOM_ALREADY_RUNNING");
    }
    const p = room.players.get(uid)!;
    p.ready = ready;
    p.lastSeenAt = this.now();
    return this.state(room);
  }

  startRace(uid: string, roomId: string): RoomState {
    const room = this.member(uid, roomId);
    this.advance(room);
    this.prune(room);
    if (room.hostId !== uid) throw new RoomError("NOT_HOST", "NOT_HOST");
    if (room.status === "COUNTDOWN" || room.status === "RUNNING") {
      throw new RoomError("ROOM_ALREADY_RUNNING", "ROOM_ALREADY_RUNNING");
    }
    const players = [...room.players.values()];
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      throw new RoomError("NOT_ENOUGH_PLAYERS", "NOT_ENOUGH_PLAYERS");
    }
    if (!players.every((p) => p.ready)) throw new RoomError("NOT_ALL_READY", "NOT_ALL_READY");
    room.status = "COUNTDOWN";
    room.raceId = this.newId("race");
    room.startAt = this.now() + START_DELAY_MS;
    room.cancelReason = null;
    room.results = null;
    players.forEach((p) => (p.ready = false));
    room.lastActivityAt = this.now();
    return this.state(room);
  }

  finishRace(uid: string, roomId: string, raceId: string, results: RankedPlayer[]): RoomState {
    const room = this.member(uid, roomId);
    if (room.hostId !== uid) throw new RoomError("NOT_HOST", "NOT_HOST");
    this.advance(room);
    if (room.raceId !== raceId || (room.status !== "COUNTDOWN" && room.status !== "RUNNING")) {
      return this.state(room);
    }
    if (results.length > MAX_PLAYERS) throw new RoomError("UNKNOWN", "INVALID_RESULTS");
    room.status = "FINISHED";
    room.results = results;
    room.lastActivityAt = this.now();
    return this.state(room);
  }

  cancelRace(uid: string, roomId: string, raceId: string, reason: string): RoomState {
    const room = this.member(uid, roomId);
    if (room.hostId !== uid) throw new RoomError("NOT_HOST", "NOT_HOST");
    if (room.raceId === raceId && (room.status === "COUNTDOWN" || room.status === "RUNNING")) {
      this.cancel(room, reason);
    }
    return this.state(room);
  }

  private cancel(room: FakeRoom, reason: string) {
    room.status = "LOBBY";
    room.raceId = null;
    room.startAt = null;
    room.cancelReason = reason;
    room.players.forEach((p) => (p.ready = false));
  }

  heartbeat(uid: string, roomId: string): RoomState {
    const room = this.member(uid, roomId);
    const now = this.now();
    room.players.get(uid)!.lastSeenAt = now;
    room.lastActivityAt = now;
    this.advance(room);
    if (room.status === "COUNTDOWN" || room.status === "RUNNING") {
      const host = room.players.get(room.hostId);
      if (!host || now - host.lastSeenAt > HOST_RACE_GRACE_MS) {
        this.cancel(room, "HOST_DISCONNECTED");
        const next = this.earliestFresh(room, HOST_RACE_GRACE_MS, room.hostId);
        if (next) room.hostId = next.userId;
      }
    }
    this.prune(room);
    if (!this.rooms.has(room.id)) throw new RoomError("ROOM_NOT_FOUND", "ROOM_NOT_FOUND");
    return this.state(room);
  }

  serverNow(): number {
    return this.now();
  }

  /** Mirrors the storage policies: members write only their own file and read files in their room. */
  uploadSkin(uid: string, roomId: string, data: unknown) {
    this.member(uid, roomId);
    this.skins.set(skinPath(roomId, uid), data);
  }

  downloadSkin(uid: string, roomId: string, owner: string): unknown {
    this.member(uid, roomId);
    const data = this.skins.get(skinPath(roomId, owner));
    if (data === undefined) throw new RoomError("UNKNOWN", "Skin not found");
    return data;
  }

  deleteSkin(uid: string, roomId: string) {
    this.skins.delete(skinPath(roomId, uid));
  }

  /** Test helper. */
  roomByCode(code: string): RoomState | null {
    const room = [...this.rooms.values()].find((r) => r.code === code);
    return room ? this.state(room) : null;
  }

  /** Test helper: stored results of the last finished race. */
  resultsOf(roomId: string): RankedPlayer[] | null {
    return this.rooms.get(roomId)?.results ?? null;
  }
}

export interface Subscription {
  clientId: string;
  topic: string;
  onBroadcast(event: string, payload: unknown): void;
  onPresence?(states: PresenceState[]): void;
  onStatus?(status: ChannelStatus): void;
}

/** What FakeRoomChannel needs from a hub; also implemented by the browser test bridge. */
export interface RealtimeHubLike {
  subscribe(sub: Subscription): () => void;
  broadcast(topic: string, from: string, event: string, payload: unknown): void;
  track(topic: string, clientId: string, state: PresenceState): void;
}

/** In-memory Realtime: broadcast (not echoed to sender) and presence per topic. */
export class FakeRealtimeHub implements RealtimeHubLike {
  private subs = new Set<Subscription>();
  private presence = new Map<string, Map<string, PresenceState>>();
  private offline = new Set<string>();
  /** Every delivered broadcast, for rate assertions in tests. */
  readonly log: Array<{ topic: string; event: string; from: string; at: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  isOnline(clientId: string) {
    return !this.offline.has(clientId);
  }

  subscribe(sub: Subscription): () => void {
    this.subs.add(sub);
    queueMicrotask(() => {
      if (this.subs.has(sub) && this.isOnline(sub.clientId)) {
        sub.onStatus?.("CONNECTED");
        sub.onPresence?.(this.presenceList(sub.topic));
      }
    });
    return () => {
      this.subs.delete(sub);
      if (sub.onPresence) this.untrack(sub.topic, sub.clientId);
    };
  }

  broadcast(topic: string, from: string, event: string, payload: unknown) {
    if (!this.isOnline(from)) return;
    this.log.push({ topic, event, from, at: this.now() });
    for (const sub of this.subs) {
      if (sub.topic !== topic || sub.clientId === from || !this.isOnline(sub.clientId)) continue;
      const copy = structuredClone(payload);
      queueMicrotask(() => {
        if (this.subs.has(sub) && this.isOnline(sub.clientId)) sub.onBroadcast(event, copy);
      });
    }
  }

  track(topic: string, clientId: string, state: PresenceState) {
    if (!this.isOnline(clientId)) return;
    let map = this.presence.get(topic);
    if (!map) this.presence.set(topic, (map = new Map()));
    map.set(clientId, state);
    this.emitPresence(topic);
  }

  untrack(topic: string, clientId: string) {
    if (this.presence.get(topic)?.delete(clientId)) this.emitPresence(topic);
  }

  private presenceList(topic: string): PresenceState[] {
    return [...(this.presence.get(topic)?.values() ?? [])];
  }

  private emitPresence(topic: string) {
    const list = this.presenceList(topic);
    for (const sub of this.subs) {
      if (sub.topic === topic && sub.onPresence && this.isOnline(sub.clientId)) {
        queueMicrotask(() => sub.onPresence?.(list));
      }
    }
  }

  /** Simulates a network drop or recovery for one client. */
  setOnline(clientId: string, online: boolean) {
    if (online === this.isOnline(clientId)) return;
    if (!online) {
      this.offline.add(clientId);
      for (const [topic, map] of this.presence) {
        if (map.delete(clientId)) this.emitPresence(topic);
      }
      for (const sub of this.subs) {
        if (sub.clientId === clientId) queueMicrotask(() => sub.onStatus?.("DISCONNECTED"));
      }
    } else {
      this.offline.delete(clientId);
      for (const sub of this.subs) {
        if (sub.clientId === clientId) {
          queueMicrotask(() => {
            sub.onStatus?.("CONNECTED");
            sub.onPresence?.(this.presenceList(sub.topic));
          });
        }
      }
    }
  }
}

export class FakeRoomChannel implements RoomChannel {
  private unsubs: Array<() => void> = [];
  private inputUnsubs: Array<() => void> = [];
  private tracked: PresenceState | null = null;

  constructor(
    private readonly hub: RealtimeHubLike,
    private readonly clientId: string,
    private readonly roomId: string,
    private readonly userId: string,
    handlers: RoomChannelHandlers,
  ) {
    this.unsubs.push(
      hub.subscribe({
        clientId,
        topic: roomTopic(roomId),
        onBroadcast: (event, payload) => {
          if (event === "room") handlers.onRoomEvent(payload as RoomEvent);
        },
        onPresence: (states) => handlers.onPresence(states),
        onStatus: (status) => {
          // Presence is re-tracked after reconnecting, like supabase-js does.
          if (status === "CONNECTED" && this.tracked) hub.track(roomTopic(roomId), clientId, this.tracked);
          handlers.onStatus(status);
        },
      }),
      hub.subscribe({
        clientId,
        topic: snapshotTopic(roomId),
        onBroadcast: (event, payload) => {
          if (event === "snapshot") handlers.onSnapshot(payload as SnapshotMessage);
        },
      }),
    );
  }

  track(state: PresenceState) {
    this.tracked = state;
    this.hub.track(roomTopic(this.roomId), this.clientId, state);
  }

  sendRoomEvent(event: RoomEvent) {
    this.hub.broadcast(roomTopic(this.roomId), this.clientId, "room", event);
  }

  sendSnapshot(msg: SnapshotMessage) {
    this.hub.broadcast(snapshotTopic(this.roomId), this.clientId, "snapshot", msg);
  }

  sendInput(msg: InputMessage) {
    this.hub.broadcast(inputTopic(this.roomId, this.userId), this.clientId, "input", msg);
  }

  listenInputs(userIds: string[], onInput: (msg: InputMessage) => void) {
    this.inputUnsubs.forEach((u) => u());
    this.inputUnsubs = userIds
      .filter((id) => id !== this.userId)
      .map((id) =>
        this.hub.subscribe({
          clientId: this.clientId,
          topic: inputTopic(this.roomId, id),
          onBroadcast: (event, payload) => {
            if (event === "input") onInput(payload as InputMessage);
          },
        }),
      );
  }

  close() {
    this.inputUnsubs.forEach((u) => u());
    this.unsubs.forEach((u) => u());
    this.inputUnsubs = [];
    this.unsubs = [];
  }
}

/** One fake player: its RPC backend and realtime transport. */
export function createFakeClient(server: FakeRoomServer, hub: FakeRealtimeHub, userId: string) {
  const clientId = userId;
  const online = <T>(fn: () => T): Promise<T> =>
    hub.isOnline(clientId)
      ? Promise.resolve().then(fn)
      : Promise.reject(new RoomError("CONNECTION_LOST", "CONNECTION_LOST"));

  const backend: RoomBackend = {
    signIn: () => Promise.resolve(userId),
    createRoom: (nickname) => online(() => server.createRoom(userId, nickname)),
    joinRoom: (code, nickname) => online(() => server.joinRoom(userId, code, nickname)),
    leaveRoom: (roomId) => online(() => server.leaveRoom(userId, roomId)),
    setReady: (roomId, ready) => online(() => server.setReady(userId, roomId, ready)),
    startRace: (roomId) => online(() => server.startRace(userId, roomId)),
    finishRace: (roomId, raceId, results) => online(() => server.finishRace(userId, roomId, raceId, results)),
    cancelRace: (roomId, raceId, reason) => online(() => server.cancelRace(userId, roomId, raceId, reason)),
    heartbeat: (roomId) => online(() => server.heartbeat(userId, roomId)),
    serverNow: () => online(() => server.serverNow()),
    uploadSkin: (roomId, png) => online(() => server.uploadSkin(userId, roomId, png)),
    downloadSkin: (roomId, owner) => online(() => server.downloadSkin(userId, roomId, owner) as Blob),
    deleteSkin: (roomId) => online(() => server.deleteSkin(userId, roomId)),
  };

  const transport: RealtimeTransport = {
    openRoom: (roomId, uid, handlers) => new FakeRoomChannel(hub, clientId, roomId, uid, handlers),
  };

  return {
    backend,
    transport,
    setOnline: (value: boolean) => hub.setOnline(clientId, value),
  };
}
