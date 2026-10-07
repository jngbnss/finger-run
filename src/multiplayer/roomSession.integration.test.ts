import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClient, FakeRealtimeHub, FakeRoomServer } from "./fake";
import { RoomError } from "./protocol";
import { RoomSession, type SessionDeps } from "./roomSession";

let t = 0;
const now = () => t;
let server: FakeRoomServer;
let hub: FakeRealtimeHub;

interface Player {
  id: string;
  deps: SessionDeps;
  setOnline(online: boolean): void;
  session: RoomSession;
}

/** Drains queued microtasks (fake deliveries and resolved fake RPCs). */
async function flush() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

function client(id: string) {
  const c = createFakeClient(server, hub, id);
  return { id, deps: { backend: c.backend, transport: c.transport, now } as SessionDeps, setOnline: c.setOnline };
}

async function advance(ms: number, players: Player[], stepMs = 50) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    t += stepMs;
    for (const p of players) p.session.tick();
    await flush();
  }
}

/** Host + `guests` joined players, all in the lobby. */
async function room(guests: number): Promise<Player[]> {
  const host = client("u0");
  const players: Player[] = [{ ...host, session: await RoomSession.create(host.deps, "Host") }];
  const code = players[0].session.getView().code;
  for (let i = 1; i <= guests; i++) {
    const c = client(`u${i}`);
    players.push({ ...c, session: await RoomSession.join(c.deps, code, `P${i}`) });
  }
  await advance(2100, players);
  return players;
}

async function allReady(players: Player[]) {
  for (const p of players) await p.session.setReady(true);
  await advance(100, players);
}

async function untilAll(players: Player[], predicate: (p: Player) => boolean, maxMs: number) {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 50) {
    if (players.every(predicate)) return;
    await advance(50, players);
  }
  expect(players.filter((p) => !predicate(p)).map((p) => p.id)).toEqual([]);
}

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  t = 1_000_000;
  server = new FakeRoomServer(now);
  hub = new FakeRealtimeHub(now);
});

describe("7-player room over the fake transport", () => {
  it("runs host + 6 clients from lobby to identical results", async () => {
    const players = await room(6);
    const lobby = players[0].session.getView();
    expect(lobby.players.map((p) => p.lane)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(lobby.players.every((p) => p.connected)).toBe(true);
    expect(lobby.canStart).toBe(false);
    expect(players[1].session.getView().canStart).toBe(false);

    await allReady(players);
    expect(players[0].session.getView().canStart).toBe(true);
    // Only the host can start.
    await expect(players[3].session.start()).rejects.toBeInstanceOf(RoomError);

    await players[0].session.start();
    await advance(100, players);
    const views = players.map((p) => p.session.getView());
    expect(new Set(views.map((v) => v.raceId)).size).toBe(1);
    expect(new Set(views.map((v) => v.startAt)).size).toBe(1);
    expect(views.every((v) => v.phase === "RACE")).toBe(true);
    expect(views[0].startAt! - t).toBeGreaterThan(4500);
    expect(views.every((v) => v.countdownLabel === "GET READY")).toBe(true);

    players.forEach((p, i) => p.session.setLocalPower(100 - i * 6));
    await advance(2500, players);
    expect(players.map((p) => p.session.getView().countdownLabel)).toEqual(Array(7).fill("3"));

    await advance(3000, players);
    const running = players.map((p) => p.session.getView());
    expect(running.every((v) => v.runners.length === 7)).toBe(true);
    expect(running[0].runners.every((r) => r.status === "RUNNING")).toBe(true);
    expect(running[3].runners.every((r) => r.distanceM > 0)).toBe(true);

    await untilAll(players, (p) => p.session.getView().phase === "RESULTS", 20_000);
    const results = players.map((p) => p.session.getView().results!);
    const first = results[0].map((r) => [r.userId, r.rank, r.finishTimeMs]);
    expect(results[0]).toHaveLength(7);
    expect(results[0].every((r) => r.status === "FINISHED")).toBe(true);
    for (const r of results) expect(r.map((x) => [x.userId, x.rank, x.finishTimeMs])).toEqual(first);
    // More power, earlier finish.
    expect(results[0].map((r) => r.userId)).toEqual(["u0", "u1", "u2", "u3", "u4", "u5", "u6"]);

    await advance(500, players);
    expect(server.resultsOf(players[0].session.roomId)?.map((r) => r.userId)).toEqual(first.map((f) => f[0]));
  });

  it("keeps inputs and snapshots under the realtime budget", async () => {
    const players = await room(6);
    await allReady(players);
    await players[0].session.start();
    players.forEach((p) => p.session.setLocalPower(30));
    hub.log.length = 0;
    const from = t;
    await advance(10_000, players);
    const seconds = (t - from) / 1000;
    const inputs = hub.log.filter((e) => e.event === "input");
    const snapshots = hub.log.filter((e) => e.event === "snapshot");
    for (const p of players.slice(1)) {
      expect(inputs.filter((e) => e.from === p.id).length / seconds).toBeLessThanOrEqual(4.1);
    }
    expect(inputs.some((e) => e.from === "u0")).toBe(false);
    expect(snapshots.length / seconds).toBeLessThanOrEqual(5.1);
    // Delivered messages: each input to the host only, each snapshot to 6 clients.
    const delivered = inputs.length + snapshots.length * 6;
    expect((delivered + inputs.length + snapshots.length) / seconds).toBeLessThan(100);
  });

  it("rejects the 8th player with ROOM_FULL", async () => {
    const players = await room(6);
    const extra = client("u7");
    await expect(RoomSession.join(extra.deps, players[0].session.getView().code, "Late")).rejects.toMatchObject({
      code: "ROOM_FULL",
    });
    expect(server.roomByCode(players[0].session.getView().code)?.players).toHaveLength(7);
  });

  it("rejects new players while a race is running but lets members rejoin", async () => {
    const players = await room(1);
    await allReady(players);
    await players[0].session.start();
    await advance(100, players);
    const code = players[0].session.getView().code;
    const late = client("u9");
    await expect(RoomSession.join(late.deps, code, "Late")).rejects.toMatchObject({ code: "ROOM_ALREADY_RUNNING" });
    // Same anonymous user comes back mid-race.
    players[1].session.dispose();
    const again = client("u1");
    players[1] = { ...again, session: await RoomSession.join(again.deps, code, "P1") };
    players.forEach((p) => p.session.setLocalPower(100));
    await advance(6000, players);
    const view = players[1].session.getView();
    expect(view.phase).toBe("RACE");
    expect(view.runners.find((r) => r.isMe)!.distanceM).toBeGreaterThan(0);
  });

  it("restores a client's slot after a short disconnect and resumes the race", async () => {
    const players = await room(2);
    await allReady(players);
    await players[0].session.start();
    players.forEach((p) => p.session.setLocalPower(70));
    await advance(6000, players);

    players[2].setOnline(false);
    await advance(2000, players);
    const offlineView = players[2].session.getView();
    expect(offlineView.stale).toBe(true);
    expect(offlineView.notice?.code).toBe("CONNECTION_LOST");
    const frozen = offlineView.runners.map((r) => r.distanceM);
    await advance(500, players);
    expect(players[2].session.getView().runners.map((r) => r.distanceM)).toEqual(frozen);
    // Host stopped hearing from u2: its power decays to 0.
    const hostSees = players[0].session.getView().runners.find((r) => r.userId === "u2")!;
    expect(hostSees.power).toBeLessThan(30);

    players[2].setOnline(true);
    await advance(1000, players);
    const back = players[2].session.getView();
    expect(back.stale).toBe(false);
    expect(back.notice).toBeNull();
    await untilAll(players, (p) => p.session.getView().phase === "RESULTS", 70_000);
    expect(players[2].session.getView().results!.find((r) => r.userId === "u2")!.status).toBe("FINISHED");
  });

  it("frees a lobby slot after 10s away", async () => {
    const players = await room(2);
    players[2].setOnline(false);
    await advance(5000, players);
    expect(players[0].session.getView().players).toHaveLength(3);
    expect(players[0].session.getView().players.find((p) => p.userId === "u2")!.connected).toBe(false);
    await advance(7000, players);
    expect(players[0].session.getView().players.map((p) => p.userId)).toEqual(["u0", "u1"]);
    players[2].setOnline(true);
    await advance(2500, players);
    expect(players[2].session.getView().phase).toBe("LEFT");
    expect(players[2].session.getView().notice?.code).toBe("ROOM_NOT_FOUND");
  });

  it("migrates the host in the lobby to the earliest joined player", async () => {
    const players = await room(3);
    await players[0].session.leave();
    const rest = players.slice(1);
    await advance(2500, rest);
    for (const p of rest) expect(p.session.getView().hostId).toBe("u1");
    expect(rest[0].session.getView().isHost).toBe(true);

    // Host vanishes without leaving: pruned after 10s, next earliest becomes host.
    rest[0].setOnline(false);
    await advance(12_500, rest);
    expect(rest[1].session.getView().hostId).toBe("u2");
    expect(rest[1].session.getView().players.map((p) => p.userId)).toEqual(["u2", "u3"]);
  });

  it("cancels the race with HOST_DISCONNECTED when the host drops mid-race", async () => {
    const players = await room(3);
    await allReady(players);
    await players[0].session.start();
    players.forEach((p) => p.session.setLocalPower(60));
    await advance(7000, players);
    const guests = players.slice(1);
    const before = guests[0].session.getView().runners.map((r) => r.distanceM);
    expect(before.some((d) => d > 0)).toBe(true);

    players[0].setOnline(false);
    await advance(2600, guests);
    const waiting = guests[0].session.getView();
    expect(waiting.phase).toBe("RACE");
    expect(waiting.notice?.code).toBe("HOST_DISCONNECTED");
    expect(waiting.stale).toBe(true);

    await advance(5000, guests);
    for (const g of guests) {
      const v = g.session.getView();
      expect(v.phase).toBe("LOBBY");
      expect(v.notice?.code).toBe("HOST_DISCONNECTED");
      expect(v.hostId).toBe("u1");
      expect(v.players.every((p) => !p.ready)).toBe(true);
    }
    expect(server.resultsOf(guests[0].session.roomId)).toBeNull();
  });

  it("marks a player who never moves as DNF at exactly 60s", async () => {
    const players = await room(1);
    await allReady(players);
    await players[0].session.start();
    players[0].session.setLocalPower(100);
    players[1].session.setLocalPower(0);
    await untilAll(players, (p) => p.session.getView().phase === "RESULTS", 70_000);
    for (const p of players) {
      const results = p.session.getView().results!;
      expect(results.map((r) => [r.userId, r.status, r.rank])).toEqual([
        ["u0", "FINISHED", 1],
        ["u1", "DNF", 2],
      ]);
      expect(results[1].distanceM).toBe(0);
    }
    const raceEnd = players[0].session.getView();
    expect(raceEnd.serverNow - raceEnd.startAt!).toBeGreaterThanOrEqual(60_000);
  });

  it("shows the host's saved results to a client that missed the final snapshot", async () => {
    const players = await room(2);
    await allReady(players);
    await players[0].session.start();
    players.forEach((p) => p.session.setLocalPower(100));
    // u2's connection drops just before the line; the host still finishes its run.
    const hostView = () => players[0].session.getView().runners.find((r) => r.userId === "u2");
    for (let i = 0; i < 400 && (hostView()?.distanceM ?? 0) < 95; i++) await advance(50, players);
    players[2].setOnline(false);
    await untilAll(players.slice(0, 2), (p) => p.session.getView().phase === "RESULTS", 70_000);
    const hostBoard = players[0].session.getView().results!.map((r) => [r.userId, r.rank, r.status, r.finishTimeMs]);
    players[2].setOnline(true);
    await advance(3000, players);
    const late = players[2].session.getView();
    expect(late.phase).toBe("RESULTS");
    expect(late.results!.map((r) => [r.userId, r.rank, r.status, r.finishTimeMs])).toEqual(hostBoard);
  });

  it("supports a rematch with a new race id", async () => {
    const players = await room(1);
    await allReady(players);
    await players[0].session.start();
    players.forEach((p) => p.session.setLocalPower(100));
    await untilAll(players, (p) => p.session.getView().phase === "RESULTS", 20_000);
    const firstRace = players[0].session.getView().raceId;
    for (const p of players) await p.session.rematch();
    await advance(2500, players);
    expect(players[0].session.getView().canStart).toBe(true);
    await players[0].session.start();
    await advance(200, players);
    const second = players.map((p) => p.session.getView().raceId);
    expect(second[0]).not.toBe(firstRace);
    expect(second[1]).toBe(second[0]);
  });
});
