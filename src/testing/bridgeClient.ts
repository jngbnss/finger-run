import { FakeRoomChannel, type RealtimeHubLike, type Subscription } from "../multiplayer/fake";
import type { PresenceState } from "../multiplayer/protocol";
import { toRoomError } from "../multiplayer/protocol";
import type { RealtimeTransport, RoomBackend } from "../multiplayer/transport";

/**
 * Browser half of the Playwright realtime bridge. All pages talk to one
 * FakeRoomServer/FakeRealtimeHub living in the Playwright test process through
 * an exposed binding, so 7 isolated browser contexts share one fake Supabase.
 */

export type BridgeCall =
  | { op: "rpc"; name: string; args: unknown[] }
  | { op: "subscribe"; topic: string; subId: number; presence: boolean }
  | { op: "unsubscribe"; subId: number }
  | { op: "broadcast"; topic: string; event: string; payload: unknown }
  | { op: "track"; topic: string; state: PresenceState };

export type BridgeEvent =
  | { subId: number; kind: "broadcast"; event: string; payload: unknown }
  | { subId: number; kind: "presence"; states: PresenceState[] }
  | { subId: number; kind: "status"; status: "CONNECTED" | "DISCONNECTED" };

declare global {
  interface Window {
    __frBridge?: (call: BridgeCall) => Promise<unknown>;
    __frReceive?: (event: BridgeEvent) => void;
  }
}

class RemoteHub implements RealtimeHubLike {
  private subs = new Map<number, Subscription>();
  private nextId = 1;

  constructor(private readonly call: (c: BridgeCall) => Promise<unknown>) {
    window.__frReceive = (event) => {
      const sub = this.subs.get(event.subId);
      if (!sub) return;
      if (event.kind === "broadcast") sub.onBroadcast(event.event, event.payload);
      else if (event.kind === "presence") sub.onPresence?.(event.states);
      else sub.onStatus?.(event.status);
    };
  }

  subscribe(sub: Subscription) {
    const subId = this.nextId++;
    this.subs.set(subId, sub);
    void this.call({ op: "subscribe", topic: sub.topic, subId, presence: Boolean(sub.onPresence) });
    return () => {
      this.subs.delete(subId);
      void this.call({ op: "unsubscribe", subId });
    };
  }

  broadcast(topic: string, _from: string, event: string, payload: unknown) {
    void this.call({ op: "broadcast", topic, event, payload });
  }

  track(topic: string, _clientId: string, state: PresenceState) {
    void this.call({ op: "track", topic, state });
  }
}

export function createBridgeClient(): { backend: RoomBackend; transport: RealtimeTransport } | null {
  const bridge = window.__frBridge;
  if (!bridge) return null;
  const rpc = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    try {
      return (await bridge({ op: "rpc", name, args })) as T;
    } catch (error) {
      // Playwright wraps thrown errors; recover the room error code from the message.
      throw toRoomError(error);
    }
  };
  const hub = new RemoteHub(bridge);
  const backend: RoomBackend = {
    signIn: () => rpc("signIn"),
    createRoom: (nickname) => rpc("createRoom", nickname),
    joinRoom: (code, nickname) => rpc("joinRoom", code, nickname),
    leaveRoom: (roomId) => rpc("leaveRoom", roomId),
    setReady: (roomId, ready) => rpc("setReady", roomId, ready),
    startRace: (roomId) => rpc("startRace", roomId),
    finishRace: (roomId, raceId, results) => rpc("finishRace", roomId, raceId, results),
    cancelRace: (roomId, raceId, reason) => rpc("cancelRace", roomId, raceId, reason),
    heartbeat: (roomId) => rpc("heartbeat", roomId),
    serverNow: () => rpc("serverNow"),
  };
  const transport: RealtimeTransport = {
    openRoom: (roomId, userId, handlers) => new FakeRoomChannel(hub, userId, roomId, userId, handlers),
  };
  return { backend, transport };
}
