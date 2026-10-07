import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { RankedPlayer } from "./multiRace";
import {
  RoomError,
  toRoomError,
  type InputMessage,
  type PresenceState,
  type RoomEvent,
  type RoomState,
  type SnapshotMessage,
} from "./protocol";
import {
  inputTopic,
  roomTopic,
  snapshotTopic,
  type RealtimeTransport,
  type RoomBackend,
  type RoomChannel,
  type RoomChannelHandlers,
} from "./transport";

/** Only the publishable (anon) key is ever used in the browser. */
export function supabaseConfig(): { url: string; key: string } | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const config = supabaseConfig();
  if (!config) return null;
  client = createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "finger-run.auth" },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return client;
}

export class SupabaseRoomBackend implements RoomBackend {
  constructor(private readonly sb: SupabaseClient) {}

  async signIn(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    let userId = data.session?.user.id;
    if (!userId) {
      const result = await this.sb.auth.signInAnonymously();
      if (result.error || !result.data.user) {
        throw new RoomError("CONNECTION_LOST", result.error?.message ?? "Anonymous sign-in failed");
      }
      userId = result.data.user.id;
    }
    // Private channels authorize with the user's JWT.
    await this.sb.realtime.setAuth();
    return userId;
  }

  private async rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(name, args);
    if (error) throw toRoomError(error.message);
    return data as T;
  }

  createRoom(nickname: string) {
    return this.rpc<RoomState>("create_room", { nickname });
  }
  joinRoom(code: string, nickname: string) {
    return this.rpc<RoomState>("join_room", { room_code: code, nickname });
  }
  async leaveRoom(roomId: string) {
    await this.rpc("leave_room", { room_id: roomId });
  }
  setReady(roomId: string, ready: boolean) {
    return this.rpc<RoomState>("set_ready", { room_id: roomId, ready });
  }
  startRace(roomId: string) {
    return this.rpc<RoomState>("start_room_race", { room_id: roomId });
  }
  finishRace(roomId: string, raceId: string, results: RankedPlayer[]) {
    return this.rpc<RoomState>("finish_room_race", { room_id: roomId, race_id: raceId, results_json: results });
  }
  cancelRace(roomId: string, raceId: string, reason: string) {
    return this.rpc<RoomState>("cancel_room_race", { room_id: roomId, race_id: raceId, reason });
  }
  heartbeat(roomId: string) {
    return this.rpc<RoomState>("heartbeat_room", { room_id: roomId });
  }
  async serverNow() {
    return Number(await this.rpc<number>("server_now"));
  }
}

const privateBroadcast = { config: { private: true, broadcast: { self: false, ack: false } } };

class SupabaseRoomChannel implements RoomChannel {
  private main: RealtimeChannel;
  private snapshots: RealtimeChannel;
  private ownInput: RealtimeChannel;
  private inputs: RealtimeChannel[] = [];
  private tracked: PresenceState | null = null;
  private subscribed = false;

  constructor(
    private readonly sb: SupabaseClient,
    private readonly roomId: string,
    private readonly userId: string,
    handlers: RoomChannelHandlers,
  ) {
    this.main = sb.channel(roomTopic(roomId), {
      config: { private: true, presence: { key: userId }, broadcast: { self: false, ack: false } },
    });
    this.main
      .on("presence", { event: "sync" }, () => {
        const state = this.main.presenceState<PresenceState>();
        handlers.onPresence(Object.values(state).map((metas) => metas[0]).filter(Boolean));
      })
      .on("broadcast", { event: "room" }, ({ payload }) => handlers.onRoomEvent(payload as RoomEvent))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          this.subscribed = true;
          if (this.tracked) void this.main.track(this.tracked);
          handlers.onStatus("CONNECTED");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.subscribed = false;
          handlers.onStatus("DISCONNECTED");
        }
      });

    this.snapshots = sb
      .channel(snapshotTopic(roomId), privateBroadcast)
      .on("broadcast", { event: "snapshot" }, ({ payload }) => handlers.onSnapshot(payload as SnapshotMessage))
      .subscribe();

    this.ownInput = sb.channel(inputTopic(roomId, userId), privateBroadcast).subscribe();
  }

  track(state: PresenceState) {
    this.tracked = state;
    if (this.subscribed) void this.main.track(state);
  }

  sendRoomEvent(event: RoomEvent) {
    void this.main.send({ type: "broadcast", event: "room", payload: event });
  }

  sendSnapshot(msg: SnapshotMessage) {
    void this.snapshots.send({ type: "broadcast", event: "snapshot", payload: msg });
  }

  sendInput(msg: InputMessage) {
    void this.ownInput.send({ type: "broadcast", event: "input", payload: msg });
  }

  listenInputs(userIds: string[], onInput: (msg: InputMessage) => void) {
    this.inputs.forEach((ch) => void this.sb.removeChannel(ch));
    this.inputs = userIds
      .filter((id) => id !== this.userId)
      .map((id) =>
        this.sb
          .channel(inputTopic(this.roomId, id), privateBroadcast)
          .on("broadcast", { event: "input" }, ({ payload }) => onInput(payload as InputMessage))
          .subscribe(),
      );
  }

  close() {
    [this.main, this.snapshots, this.ownInput, ...this.inputs].forEach((ch) => void this.sb.removeChannel(ch));
    this.inputs = [];
  }
}

export class SupabaseTransport implements RealtimeTransport {
  constructor(private readonly sb: SupabaseClient) {}

  openRoom(roomId: string, userId: string, handlers: RoomChannelHandlers): RoomChannel {
    return new SupabaseRoomChannel(this.sb, roomId, userId, handlers);
  }
}
