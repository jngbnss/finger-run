import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs the real migration in Postgres (PGlite) with minimal stand-ins for
 * Supabase's auth.uid(), roles and realtime.messages.
 */

const dir = join(__dirname, "migrations");
const migration = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema if not exists realtime;
  create table if not exists realtime.messages (id bigserial primary key, topic text not null, extension text not null);
  create or replace function realtime.topic() returns text language sql stable as
    $$ select current_setting('realtime.topic', true) $$;
  alter table realtime.messages enable row level security;
  grant usage on schema auth, realtime, public to anon, authenticated;
  grant select, insert on realtime.messages to authenticated;
  grant usage on sequence realtime.messages_id_seq to authenticated;
  grant execute on function auth.uid(), realtime.topic() to anon, authenticated;
`;

let db: PGlite;
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

async function as(user: number | null, sql: string, params: unknown[] = []) {
  await db.exec(user === null ? "reset role" : `set role authenticated`);
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user === null ? "" : uid(user)]);
  try {
    return await db.query<Record<string, unknown>>(sql, params);
  } finally {
    await db.exec("reset role");
  }
}

async function rpc(user: number, call: string, params: unknown[] = []) {
  const result = await as(user, `select ${call} as r`, params);
  return result.rows[0].r as Record<string, any>;
}

async function rpcError(user: number, call: string, params: unknown[] = []): Promise<string> {
  try {
    await rpc(user, call, params);
  } catch (error) {
    return (error as Error).message;
  }
  return "NO_ERROR";
}

/** Superuser helper to age heartbeats. */
async function ageSeen(roomId: string, user: number, seconds: number) {
  await db.query(
    `update public.room_players set last_seen_at = now() - make_interval(secs => $3) where room_id = $1 and user_id = $2`,
    [roomId, uid(user), seconds],
  );
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
}, 60_000);

beforeEach(async () => {
  await db.exec("reset role; drop table if exists public.room_players cascade; drop table if exists public.rooms cascade;");
  await db.exec(migration);
});

describe("supabase migration", () => {
  it("is re-runnable", async () => {
    await db.exec(migration);
    await db.exec(migration);
    const room = await rpc(1, "public.create_room($1)", ["Ann"]);
    expect(room.code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("assigns lanes 1..7 and rejects the 8th with ROOM_FULL", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Host"]);
    for (let i = 2; i <= 7; i++) {
      const state = await rpc(i, "public.join_room($1, $2)", [room.code.toLowerCase(), `P${i}`]);
      expect(state.players.find((p: any) => p.userId === uid(i)).lane).toBe(i);
    }
    expect(await rpcError(8, "public.join_room($1, $2)", [room.code, "Late"])).toContain("ROOM_FULL");
    const count = await db.query<{ n: number }>("select count(*)::int n from public.room_players where room_id = $1", [room.id]);
    expect(count.rows[0].n).toBe(7);
    // A free lane is reused.
    await rpc(4, "public.leave_room($1)", [room.id]);
    const again = await rpc(8, "public.join_room($1, $2)", [room.code, "Late"]);
    expect(again.players.find((p: any) => p.userId === uid(8)).lane).toBe(4);
  });

  it("returns typed errors for bad codes and nicknames", async () => {
    expect(await rpcError(1, "public.join_room($1, $2)", ["ZZZZZZ", "Ann"])).toContain("ROOM_NOT_FOUND");
    expect(await rpcError(1, "public.create_room($1)", ["   "])).toContain("INVALID_NICKNAME");
    expect(await rpcError(1, "public.create_room($1)", ["x".repeat(17)])).toContain("INVALID_NICKNAME");
  });

  it("allows RPCs only, never direct writes, and nothing for anon", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Host"]);
    await expect(as(1, "insert into public.rooms (code, host_id) values ('ABCDEF', $1)", [uid(1)])).rejects.toThrow(/permission denied/);
    await expect(as(1, "update public.room_players set lane = 7 where room_id = $1", [room.id])).rejects.toThrow(/permission denied/);
    await expect(as(1, "delete from public.room_players where room_id = $1", [room.id])).rejects.toThrow(/permission denied/);
    await expect(as(1, "select public.fr_cancel($1, 'x')", [room.id])).rejects.toThrow(/permission denied/);
    await db.exec("set role anon");
    await expect(db.query("select public.create_room('Anon')")).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  });

  it("lets members read only their own room", async () => {
    const mine = await rpc(1, "public.create_room($1)", ["Ann"]);
    await rpc(2, "public.create_room($1)", ["Bob"]);
    const visible = await as(1, "select id from public.rooms");
    expect(visible.rows.map((r) => r.id)).toEqual([mine.id]);
    const players = await as(1, "select user_id from public.room_players");
    expect(players.rows.map((r) => r.user_id)).toEqual([uid(1)]);
  });

  it("lets only the host start, only when 2..7 players are all READY", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Host"]);
    await rpc(1, "public.set_ready($1, true)", [room.id]);
    expect(await rpcError(1, "public.start_room_race($1)", [room.id])).toContain("NOT_ENOUGH_PLAYERS");
    await rpc(2, "public.join_room($1, $2)", [room.code, "Bob"]);
    expect(await rpcError(1, "public.start_room_race($1)", [room.id])).toContain("NOT_ALL_READY");
    await rpc(2, "public.set_ready($1, true)", [room.id]);
    expect(await rpcError(2, "public.start_room_race($1)", [room.id])).toContain("NOT_HOST");

    const before = Date.now();
    const started = await rpc(1, "public.start_room_race($1)", [room.id]);
    expect(started.status).toBe("COUNTDOWN");
    expect(started.raceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.startAt - before).toBeGreaterThan(4000);
    expect(started.startAt - before).toBeLessThan(6000);
    expect(started.players.every((p: any) => p.ready === false)).toBe(true);
    expect(await rpcError(1, "public.start_room_race($1)", [room.id])).toContain("ROOM_ALREADY_RUNNING");

    // New players are refused mid-race; members may rejoin their slot.
    expect(await rpcError(3, "public.join_room($1, $2)", [room.code, "Late"])).toContain("ROOM_ALREADY_RUNNING");
    const back = await rpc(2, "public.join_room($1, $2)", [room.code, "Bob"]);
    expect(back.players.find((p: any) => p.userId === uid(2)).lane).toBe(2);

    expect(await rpcError(2, "public.finish_room_race($1, $2, $3)", [room.id, started.raceId, "[]"])).toContain("NOT_HOST");
    const done = await rpc(1, "public.finish_room_race($1, $2, $3)", [room.id, started.raceId, JSON.stringify([{ userId: uid(1), rank: 1 }])]);
    expect(done.status).toBe("FINISHED");
  });

  it("cancels the race when the host stops heartbeating, and hands over host", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Host"]);
    await rpc(2, "public.join_room($1, $2)", [room.code, "Bob"]);
    await rpc(3, "public.join_room($1, $2)", [room.code, "Cy"]);
    for (const u of [1, 2, 3]) await rpc(u, "public.set_ready($1, true)", [room.id]);
    await rpc(1, "public.start_room_race($1)", [room.id]);

    expect((await rpc(2, "public.heartbeat_room($1)", [room.id])).status).toMatch(/COUNTDOWN|RUNNING/);
    await ageSeen(room.id, 1, 6);
    const cancelled = await rpc(2, "public.heartbeat_room($1)", [room.id]);
    expect(cancelled.status).toBe("LOBBY");
    expect(cancelled.cancelReason).toBe("HOST_DISCONNECTED");
    expect(cancelled.raceId).toBeNull();
    expect(cancelled.hostId).toBe(uid(2));
  });

  it("frees lobby slots after 10s and migrates the host to the earliest joined", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Host"]);
    await rpc(2, "public.join_room($1, $2)", [room.code, "Bob"]);
    await rpc(3, "public.join_room($1, $2)", [room.code, "Cy"]);
    await ageSeen(room.id, 1, 11);
    const pruned = await rpc(3, "public.heartbeat_room($1)", [room.id]);
    expect(pruned.players.map((p: any) => p.userId)).toEqual([uid(2), uid(3)]);
    expect(pruned.hostId).toBe(uid(2));
    expect(await rpcError(1, "public.heartbeat_room($1)", [room.id])).toContain("ROOM_NOT_FOUND");

    const left = await rpc(2, "public.leave_room($1)", [room.id]);
    expect(left.hostId).toBe(uid(3));
    await rpc(3, "public.leave_room($1)", [room.id]);
    const gone = await db.query("select 1 from public.rooms where id = $1", [room.id]);
    expect(gone.rows).toHaveLength(0);
  });

  it("deletes rooms idle for 10 minutes on the next create/join", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Old"]);
    await db.query("update public.rooms set last_activity_at = now() - interval '11 minutes' where id = $1", [room.id]);
    await rpc(2, "public.create_room($1)", ["New"]);
    expect((await db.query("select 1 from public.rooms where id = $1", [room.id])).rows).toHaveLength(0);
  });

  it("returns server time in epoch milliseconds", async () => {
    const r = await as(1, "select public.server_now() as t");
    expect(Math.abs((r.rows[0].t as number) - Date.now())).toBeLessThan(5000);
  });

  it("restricts realtime topics to members, host snapshots and own inputs", async () => {
    const room = await rpc(1, "public.create_room($1)", ["Host"]);
    await rpc(2, "public.join_room($1, $2)", [room.code, "Bob"]);
    const send = async (user: number, topic: string, extension = "broadcast") => {
      await db.query("select set_config('realtime.topic', $1, false)", [topic]);
      return as(user, "insert into realtime.messages (topic, extension) values ($1, $2)", [topic, extension]);
    };
    const base = `room:${room.id}`;
    await expect(send(2, base, "presence")).resolves.toBeDefined();
    await expect(send(2, `${base}:input:${uid(2)}`)).resolves.toBeDefined();
    await expect(send(2, `${base}:input:${uid(1)}`)).rejects.toThrow(/row-level security/);
    await expect(send(2, `${base}:snapshot`)).rejects.toThrow(/row-level security/);
    await expect(send(1, `${base}:snapshot`)).resolves.toBeDefined();
    await expect(send(9, base)).rejects.toThrow(/row-level security/);
  });
});
