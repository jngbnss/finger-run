import { measureClockOffset } from "./clock";
import {
  applyInput,
  createMultiRace,
  rankPlayers,
  snapshotPlayers,
  stepMultiRace,
  takeSnapshot,
  type MultiRaceState,
  type RankedPlayer,
} from "./multiRace";
import {
  HEARTBEAT_MS,
  INPUT_HZ,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PROTOCOL_VERSION,
  RoomError,
  SNAPSHOT_HZ,
  toRoomError,
  type ErrorCode,
  type PresenceState,
  type RoomEvent,
  type RoomState,
  type SnapshotMessage,
  type SnapshotPlayer,
} from "./protocol";
import { SnapshotBuffer } from "./snapshotBuffer";
import type { ChannelStatus, RealtimeTransport, RoomBackend, RoomChannel } from "./transport";

export interface SessionDeps {
  backend: RoomBackend;
  transport: RealtimeTransport;
  /** Local clock in ms. */
  now: () => number;
}

export type SessionPhase = "LOBBY" | "RACE" | "RESULTS" | "LEFT";

export interface SessionNotice {
  code: ErrorCode;
  message: string;
}

export interface LobbyPlayerView {
  userId: string;
  nickname: string;
  lane: number;
  ready: boolean;
  isHost: boolean;
  isMe: boolean;
  connected: boolean;
  cameraReady: boolean;
}

export interface RacePlayerView extends RankedPlayer {
  nickname: string;
  isMe: boolean;
  connected: boolean;
}

export interface SessionView {
  phase: SessionPhase;
  roomId: string;
  code: string;
  me: string;
  hostId: string;
  isHost: boolean;
  players: LobbyPlayerView[];
  canStart: boolean;
  raceId: string | null;
  startAt: number | null;
  serverNow: number;
  /** "3", "2", "1", "GO!", "GET READY" or null. */
  countdownLabel: string | null;
  raceElapsedMs: number;
  runners: RacePlayerView[];
  /** True when snapshots stopped for 1.5s; positions are frozen. */
  stale: boolean;
  connection: ChannelStatus;
  notice: SessionNotice | null;
  results: RacePlayerView[] | null;
}

/** Delay rendering behind the newest snapshot so there is always a pair to interpolate. */
export const INTERPOLATION_DELAY_MS = 250;
const HOST_MISSING_NOTICE_MS = 2000;

const NOTICE_TEXT: Partial<Record<ErrorCode, string>> = {
  HOST_DISCONNECTED: "The host disconnected. The race was cancelled and everyone is back in the lobby.",
  CONNECTION_LOST: "Connection lost. Reconnecting…",
  VERSION_MISMATCH: "Someone in this room is on a different app version. Everyone should reload the page.",
  ROOM_NOT_FOUND: "This room no longer exists or you were removed after being away too long.",
};

export function noticeFor(code: ErrorCode, fallback?: string): SessionNotice {
  return { code, message: NOTICE_TEXT[code] ?? fallback ?? code };
}

/**
 * One player's view of an online room: lobby, ready state, clock sync, input
 * sending, and (for the host) the authoritative race simulation.
 * Framework free; React calls tick() from a timer and getView() when rendering.
 */
export class RoomSession {
  private room: RoomState;
  private channel: RoomChannel;
  private presence = new Map<string, PresenceState>();
  private offsetMs = 0;
  private phase: SessionPhase = "LOBBY";
  private multi: MultiRaceState | null = null;
  private buffer = new SnapshotBuffer();
  private finalSnapshot: SnapshotMessage | null = null;
  private closedRaces = new Set<string>();
  private localPower = 0;
  private inputSeq = 0;
  private lastInputSentAt = Number.NEGATIVE_INFINITY;
  private lastSnapshotSentAt = Number.NEGATIVE_INFINITY;
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  private heartbeatInFlight = false;
  private finishing = false;
  private cameraReady = false;
  private notice: SessionNotice | null = null;
  private connection: ChannelStatus = "CONNECTING";
  private hostMissingSince: number | null = null;
  private listeners = new Set<() => void>();

  static async create(deps: SessionDeps, nickname: string): Promise<RoomSession> {
    const me = await deps.backend.signIn();
    const room = await deps.backend.createRoom(nickname);
    return RoomSession.open(deps, me, room);
  }

  static async join(deps: SessionDeps, code: string, nickname: string): Promise<RoomSession> {
    const me = await deps.backend.signIn();
    const room = await deps.backend.joinRoom(code, nickname);
    return RoomSession.open(deps, me, room);
  }

  private static async open(deps: SessionDeps, me: string, room: RoomState): Promise<RoomSession> {
    const session = new RoomSession(deps, me, room);
    await session.syncClock();
    await session.resumeIfRacing();
    return session;
  }

  private constructor(
    private readonly deps: SessionDeps,
    readonly me: string,
    room: RoomState,
  ) {
    this.room = room;
    this.channel = deps.transport.openRoom(room.id, me, {
      onPresence: (states) => this.onPresence(states),
      onRoomEvent: (event) => this.onRoomEvent(event),
      onSnapshot: (msg) => this.onSnapshot(msg),
      onStatus: (status) => this.onStatus(status),
    });
    this.trackPresence();
  }

  // ---- public API -------------------------------------------------------

  get roomId() {
    return this.room.id;
  }

  get isHost() {
    return this.room.hostId === this.me;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Latest local power 0..100 from camera or slider; sent at most 4Hz. */
  setLocalPower(power: number) {
    this.localPower = Number.isFinite(power) ? Math.min(100, Math.max(0, power)) : 0;
  }

  setCameraReady(ready: boolean) {
    if (ready === this.cameraReady) return;
    this.cameraReady = ready;
    this.trackPresence();
  }

  async setReady(ready: boolean) {
    this.applyRoom(await this.deps.backend.setReady(this.room.id, ready));
    this.trackPresence();
    this.sendRoomEvent({ v: PROTOCOL_VERSION, type: "room-changed" });
  }

  async start() {
    if (!this.isHost) throw new RoomError("NOT_HOST");
    await this.syncClock();
    const room = await this.deps.backend.startRace(this.room.id);
    this.applyRoom(room);
    if (room.raceId && room.startAt !== null) {
      this.sendRoomEvent({ v: PROTOCOL_VERSION, type: "race-started", raceId: room.raceId, startAt: room.startAt });
    }
  }

  /** From the results screen back to the lobby, already READY. */
  async rematch() {
    this.phase = "LOBBY";
    this.finalSnapshot = null;
    this.notify();
    await this.setReady(true);
  }

  async leave() {
    this.phase = "LEFT";
    try {
      await this.deps.backend.leaveRoom(this.room.id);
      this.sendRoomEvent({ v: PROTOCOL_VERSION, type: "room-changed" });
    } finally {
      this.dispose();
    }
  }

  dispose() {
    this.channel.close();
    this.listeners.clear();
  }

  clearNotice() {
    this.notice = null;
    this.notify();
  }

  /** Drive timers: heartbeat, inputs, host simulation and snapshots. Call every ~50ms. */
  tick() {
    if (this.phase === "LEFT") return;
    const now = this.deps.now();
    const serverNow = now + this.offsetMs;

    if (now - this.lastHeartbeatAt >= HEARTBEAT_MS && !this.heartbeatInFlight) {
      this.lastHeartbeatAt = now;
      this.heartbeatInFlight = true;
      this.deps.backend
        .heartbeat(this.room.id)
        .then((room) => this.applyRoom(room))
        .catch((error) => this.onBackendError(error))
        .finally(() => (this.heartbeatInFlight = false));
    }

    if (this.phase !== "RACE" || !this.room.raceId || this.room.startAt === null) return;
    const raceId = this.room.raceId;

    if (this.isHost && this.multi) {
      this.multi = applyInput(
        this.multi,
        { v: PROTOCOL_VERSION, raceId, userId: this.me, seq: ++this.inputSeq, power: this.localPower, sentAt: serverNow },
        serverNow,
      );
      this.multi = stepMultiRace(this.multi, serverNow);
      const done = this.multi.phase === "FINISHED";
      if (done || serverNow - this.lastSnapshotSentAt >= 1000 / SNAPSHOT_HZ) {
        const [next, snapshot] = takeSnapshot(this.multi, serverNow);
        this.multi = next;
        this.lastSnapshotSentAt = serverNow;
        this.channel.sendSnapshot(snapshot);
        this.buffer.push(snapshot, now);
        if (done && !this.finishing) this.finishRaceAsHost(snapshot);
      }
      return;
    }

    if (!this.isHost) {
      // Inputs start with the engine countdown (3s before GO) so smoothing can warm up.
      if (serverNow >= this.room.startAt - 3000 && now - this.lastInputSentAt >= 1000 / INPUT_HZ) {
        this.lastInputSentAt = now;
        this.channel.sendInput({
          v: PROTOCOL_VERSION,
          raceId,
          userId: this.me,
          seq: ++this.inputSeq,
          power: this.localPower,
          sentAt: serverNow,
        });
      }
      if (!this.presence.has(this.room.hostId) && this.connection === "CONNECTED") {
        this.hostMissingSince ??= now;
        if (now - this.hostMissingSince > HOST_MISSING_NOTICE_MS && this.notice?.code !== "HOST_DISCONNECTED") {
          this.notice = {
            code: "HOST_DISCONNECTED",
            message: "Host connection lost. Positions are frozen until the server cancels the race…",
          };
          this.lastHeartbeatAt = Number.NEGATIVE_INFINITY;
          this.notify();
        }
      } else {
        this.hostMissingSince = null;
      }
    }
  }

  getView(): SessionView {
    const now = this.deps.now();
    const serverNow = now + this.offsetMs;
    const startAt = this.room.startAt;
    const names = new Map(this.room.players.map((p) => [p.userId, p.nickname]));
    const connected = (id: string) => (id === this.me ? this.connection === "CONNECTED" : this.presence.has(id));

    let runners: SnapshotPlayer[] = [];
    let stale = false;
    if (this.phase === "RACE") {
      if (this.isHost && this.multi) {
        runners = snapshotPlayers(this.multi);
      } else {
        stale = this.buffer.isStale(now);
        runners = stale
          ? (this.buffer.latest()?.players ?? [])
          : this.buffer.sample(serverNow - INTERPOLATION_DELAY_MS);
      }
    }

    const decorate = (list: SnapshotPlayer[]): RacePlayerView[] =>
      rankPlayers(list).map((p) => ({
        ...p,
        nickname: names.get(p.userId) ?? `Lane ${p.lane}`,
        isMe: p.userId === this.me,
        connected: connected(p.userId),
      }));

    let countdownLabel: string | null = null;
    if (this.phase === "RACE" && startAt !== null) {
      const untilGo = startAt - serverNow;
      if (untilGo > 3000) countdownLabel = "GET READY";
      else if (untilGo > 0) countdownLabel = String(Math.ceil(untilGo / 1000));
      else if (untilGo > -400) countdownLabel = "GO!";
    }

    const players: LobbyPlayerView[] = this.room.players.map((p) => ({
      userId: p.userId,
      nickname: p.nickname,
      lane: p.lane,
      ready: p.ready,
      isHost: p.userId === this.room.hostId,
      isMe: p.userId === this.me,
      connected: connected(p.userId),
      cameraReady: p.userId === this.me ? this.cameraReady : (this.presence.get(p.userId)?.cameraReady ?? false),
    }));

    return {
      phase: this.phase,
      roomId: this.room.id,
      code: this.room.code,
      me: this.me,
      hostId: this.room.hostId,
      isHost: this.isHost,
      players,
      canStart:
        this.isHost &&
        this.phase === "LOBBY" &&
        (this.room.status === "LOBBY" || this.room.status === "FINISHED") &&
        players.length >= MIN_PLAYERS &&
        players.length <= MAX_PLAYERS &&
        players.every((p) => p.ready),
      raceId: this.room.raceId,
      startAt,
      serverNow,
      countdownLabel,
      raceElapsedMs: startAt !== null && this.phase === "RACE" ? Math.max(0, serverNow - startAt) : 0,
      runners: decorate(runners),
      stale,
      connection: this.connection,
      notice: this.notice,
      results: this.finalSnapshot ? decorate(this.finalSnapshot.players) : null,
    };
  }

  // ---- internals --------------------------------------------------------

  private notify() {
    this.listeners.forEach((l) => l());
  }

  private async syncClock() {
    try {
      const { offsetMs } = await measureClockOffset(() => this.deps.backend.serverNow(), this.deps.now);
      this.offsetMs = offsetMs;
    } catch (error) {
      this.onBackendError(error);
    }
  }

  /** Joining (or rejoining) while a race is in progress. */
  private async resumeIfRacing() {
    const { status, raceId } = this.room;
    if ((status !== "COUNTDOWN" && status !== "RUNNING") || !raceId) {
      this.applyRoom(this.room);
      return;
    }
    if (this.isHost) {
      // The host's simulation did not survive the reload; do not invent results.
      this.applyRoom(await this.deps.backend.cancelRace(this.room.id, raceId, "HOST_DISCONNECTED"));
      this.notice = noticeFor("HOST_DISCONNECTED");
      this.sendRoomEvent({ v: PROTOCOL_VERSION, type: "room-changed" });
      return;
    }
    this.enterRace(raceId);
  }

  private trackPresence() {
    const mine = this.room.players.find((p) => p.userId === this.me);
    this.channel.track({
      v: PROTOCOL_VERSION,
      userId: this.me,
      nickname: mine?.nickname ?? "",
      lane: mine?.lane ?? 0,
      ready: mine?.ready ?? false,
      cameraReady: this.cameraReady,
    });
  }

  private sendRoomEvent(event: RoomEvent) {
    this.channel.sendRoomEvent(event);
  }

  private enterRace(raceId: string) {
    if (this.phase === "LEFT") return;
    this.phase = "RACE";
    this.finishing = false;
    this.finalSnapshot = null;
    if (this.buffer.raceId !== raceId) this.buffer.clear();
    this.hostMissingSince = null;
    if (this.notice?.code === "HOST_DISCONNECTED") this.notice = null;
    // Re-measure the clock for this race in the background.
    void this.syncClock();
  }

  private applyRoom(room: RoomState) {
    if (this.phase === "LEFT") return;
    const prev = this.room;
    this.room = room;

    const racing = room.status === "COUNTDOWN" || room.status === "RUNNING";
    if (racing && room.raceId && room.startAt !== null && !this.closedRaces.has(room.raceId)) {
      if (this.phase !== "RACE" || prev.raceId !== room.raceId) {
        if (this.isHost && !this.multi) {
          this.multi = createMultiRace(room.raceId, room.startAt, room.players);
          this.lastSnapshotSentAt = Number.NEGATIVE_INFINITY;
          this.channel.listenInputs(
            room.players.map((p) => p.userId),
            (msg) => {
              if (this.multi) this.multi = applyInput(this.multi, msg, this.deps.now() + this.offsetMs);
            },
          );
        }
        this.enterRace(room.raceId);
      }
    } else if (this.phase === "RACE" && room.status === "LOBBY") {
      // Race cancelled by the server (host gone) or by the host.
      if (prev.raceId) this.closedRaces.add(prev.raceId);
      this.multi = null;
      this.channel.listenInputs([], () => {});
      this.phase = "LOBBY";
      this.notice = noticeFor(room.cancelReason === "HOST_DISCONNECTED" ? "HOST_DISCONNECTED" : "CONNECTION_LOST");
    } else if (this.phase === "RACE" && room.status === "FINISHED" && !this.finalSnapshot && room.results && room.raceId) {
      // The server confirmed the race before our final snapshot arrived: use the
      // host's saved results so every device shows the same leaderboard.
      this.finalSnapshot = {
        v: PROTOCOL_VERSION,
        raceId: room.raceId,
        seq: Number.MAX_SAFE_INTEGER,
        serverNow: this.deps.now() + this.offsetMs,
        phase: "FINISHED",
        startAt: room.startAt ?? 0,
        players: room.results.map(({ rank: _rank, ...p }) => p),
      };
      this.closedRaces.add(room.raceId);
      this.phase = "RESULTS";
    }

    const mine = room.players.find((p) => p.userId === this.me);
    const prevMine = prev.players.find((p) => p.userId === this.me);
    if (mine && prevMine && (mine.ready !== prevMine.ready || mine.lane !== prevMine.lane)) this.trackPresence();
    this.notify();
  }

  private finishRaceAsHost(snapshot: SnapshotMessage) {
    this.finishing = true;
    this.finalSnapshot = snapshot;
    this.closedRaces.add(snapshot.raceId);
    this.phase = "RESULTS";
    this.channel.listenInputs([], () => {});
    const results = rankPlayers(snapshot.players);
    this.multi = null;
    this.deps.backend
      .finishRace(this.room.id, snapshot.raceId, results)
      .then((room) => {
        this.applyRoom(room);
        this.sendRoomEvent({ v: PROTOCOL_VERSION, type: "race-finished", raceId: snapshot.raceId });
      })
      .catch((error) => this.onBackendError(error));
    this.notify();
  }

  private onPresence(states: PresenceState[]) {
    this.presence = new Map(states.map((s) => [s.userId, s]));
    if (states.some((s) => s.v !== PROTOCOL_VERSION)) this.notice = noticeFor("VERSION_MISMATCH");
    // Someone joined or left: refresh the authoritative room soon.
    const known = new Set(this.room.players.map((p) => p.userId));
    if (states.some((s) => !known.has(s.userId))) this.lastHeartbeatAt = Number.NEGATIVE_INFINITY;
    this.notify();
  }

  private onRoomEvent(event: RoomEvent) {
    if (event.v !== PROTOCOL_VERSION) {
      this.notice = noticeFor("VERSION_MISMATCH");
      this.notify();
      return;
    }
    if (event.type === "race-started" && !this.closedRaces.has(event.raceId)) {
      this.applyRoom({ ...this.room, status: "COUNTDOWN", raceId: event.raceId, startAt: event.startAt });
    }
    this.lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  }

  private onSnapshot(msg: SnapshotMessage) {
    if (this.isHost || this.phase === "LEFT") return;
    if (msg.v !== PROTOCOL_VERSION) {
      this.notice = noticeFor("VERSION_MISMATCH");
      this.notify();
      return;
    }
    if (this.closedRaces.has(msg.raceId)) return;
    if (this.phase !== "RACE" || this.room.raceId !== msg.raceId) {
      // Snapshot of a race we have not seen start (e.g. after reconnecting).
      this.room = { ...this.room, status: "RUNNING", raceId: msg.raceId, startAt: msg.startAt };
      this.enterRace(msg.raceId);
    }
    if (!this.buffer.push(msg, this.deps.now())) return;
    if (msg.phase === "FINISHED") {
      this.finalSnapshot = msg;
      this.closedRaces.add(msg.raceId);
      this.phase = "RESULTS";
      this.notify();
    }
  }

  private onStatus(status: ChannelStatus) {
    this.connection = status;
    if (status === "DISCONNECTED") this.notice = noticeFor("CONNECTION_LOST");
    else if (status === "CONNECTED") {
      if (this.notice?.code === "CONNECTION_LOST") this.notice = null;
      this.trackPresence();
      this.lastHeartbeatAt = Number.NEGATIVE_INFINITY;
    }
    this.notify();
  }

  private onBackendError(error: unknown) {
    const err = toRoomError(error);
    if (err.code === "ROOM_NOT_FOUND") {
      this.notice = noticeFor("ROOM_NOT_FOUND");
      this.phase = "LEFT";
      this.channel.close();
    } else if (err.code === "CONNECTION_LOST" || err.code === "UNKNOWN") {
      this.notice = noticeFor("CONNECTION_LOST");
    }
    this.notify();
  }
}
