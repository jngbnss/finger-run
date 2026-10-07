import type { BrowserContext, Page } from "@playwright/test";
import { FakeRealtimeHub, FakeRoomServer } from "../src/multiplayer/fake";
import type { BridgeCall, BridgeEvent } from "../src/testing/bridgeClient";
import type { TestHooks } from "../src/testing/testHooks";

/**
 * Node half of the realtime bridge: one fake Supabase shared by every browser
 * context in a test, injected through exposeBinding + addInitScript.
 */
export class FakeBackend {
  readonly server = new FakeRoomServer();
  readonly hub = new FakeRealtimeHub();
}

export async function openPlayer(
  context: BrowserContext,
  backend: FakeBackend,
  userId: string,
  hooks: TestHooks,
): Promise<Page> {
  await context.addInitScript((h) => {
    window.__FINGER_RUN_TEST__ = h;
  }, { ...hooks, realtime: "bridge" } satisfies TestHooks);

  const subs = new Map<number, () => void>();
  let page: Page | null = null;
  let chain = Promise.resolve();
  const deliver = (event: BridgeEvent) => {
    chain = chain
      .then(async () => {
        if (page && !page.isClosed()) await page.evaluate((e) => window.__frReceive?.(e), event);
      })
      .catch(() => {});
  };

  const { server, hub } = backend;
  const rpc: Record<string, (...args: any[]) => unknown> = {
    signIn: () => userId,
    createRoom: (nickname: string) => server.createRoom(userId, nickname),
    joinRoom: (code: string, nickname: string) => server.joinRoom(userId, code, nickname),
    leaveRoom: (roomId: string) => server.leaveRoom(userId, roomId),
    setReady: (roomId: string, ready: boolean) => server.setReady(userId, roomId, ready),
    startRace: (roomId: string) => server.startRace(userId, roomId),
    finishRace: (roomId: string, raceId: string, results: any) => server.finishRace(userId, roomId, raceId, results),
    cancelRace: (roomId: string, raceId: string, reason: string) => server.cancelRace(userId, roomId, raceId, reason),
    heartbeat: (roomId: string) => server.heartbeat(userId, roomId),
    serverNow: () => server.serverNow(),
    uploadSkin: (roomId: string, base64: string) => server.uploadSkin(userId, roomId, base64),
    downloadSkin: (roomId: string, owner: string) => server.downloadSkin(userId, roomId, owner),
    deleteSkin: (roomId: string) => server.deleteSkin(userId, roomId),
  };

  await context.exposeBinding("__frBridge", async (_source, call: BridgeCall) => {
    switch (call.op) {
      case "rpc":
        return rpc[call.name](...call.args) ?? null;
      case "subscribe": {
        const subId = call.subId;
        subs.set(
          subId,
          hub.subscribe({
            clientId: userId,
            topic: call.topic,
            onBroadcast: (event, payload) => deliver({ subId, kind: "broadcast", event, payload }),
            onPresence: call.presence ? (states) => deliver({ subId, kind: "presence", states }) : undefined,
            onStatus: (status) => {
              if (status !== "CONNECTING") deliver({ subId, kind: "status", status });
            },
          }),
        );
        return null;
      }
      case "unsubscribe":
        subs.get(call.subId)?.();
        subs.delete(call.subId);
        return null;
      case "broadcast":
        hub.broadcast(call.topic, userId, call.event, call.payload);
        return null;
      case "track":
        hub.track(call.topic, userId, call.state);
        return null;
    }
  });

  page = await context.newPage();
  return page;
}

/** Collects uncaught page errors and console.error output. */
export function watchErrors(page: Page, label: string, sink: string[]) {
  page.on("pageerror", (error) => sink.push(`${label} pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") sink.push(`${label} console.error: ${msg.text()}`);
  });
}
