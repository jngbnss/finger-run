-- Finger Run online rooms: up to 7 players per room.
-- Safe to re-run: every object uses IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS.
--
-- Clients never write tables directly. All changes go through the SECURITY DEFINER
-- RPCs below, which enforce capacity (7), lane uniqueness and host-only actions.
--
-- Cleanup policy:
--   * A room in LOBBY or FINISHED with no heartbeat for 10 minutes is deleted the next
--     time anyone calls create_room() or join_room().
--   * A COUNTDOWN/RUNNING room with no activity for 30 minutes is deleted the same way.
--   * Within a LOBBY/FINISHED room, a player with no heartbeat for 10 seconds loses the
--     slot on the next heartbeat/join/start; the host role moves to the earliest joined
--     remaining player. An empty room is deleted.
--   * During COUNTDOWN/RUNNING, if the host has not sent a heartbeat for 5 seconds, the
--     next heartbeat from anyone cancels the race (cancel_reason = 'HOST_DISCONNECTED').

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null,
  status text not null default 'LOBBY' check (status in ('LOBBY','COUNTDOWN','RUNNING','FINISHED')),
  race_id uuid,
  start_at timestamptz,
  cancel_reason text,
  results jsonb,
  finished_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_players (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 16),
  lane smallint not null check (lane between 1 and 7),
  ready boolean not null default false,
  joined_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, lane)
);

create index if not exists room_players_user_idx on public.room_players (user_id);
create index if not exists rooms_cleanup_idx on public.rooms (status, last_activity_at);

create or replace function public.fr_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists rooms_touch_updated_at on public.rooms;
create trigger rooms_touch_updated_at before update on public.rooms
  for each row execute function public.fr_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security: members may read their own rooms; nobody writes directly.
-- ---------------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;

revoke all on public.rooms from public, anon, authenticated;
revoke all on public.room_players from public, anon, authenticated;
grant select on public.rooms to authenticated;
grant select on public.room_players to authenticated;

create or replace function public.fr_is_member(p_room_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.room_players
    where room_id = p_room_id and user_id = auth.uid()
  );
$$;

create or replace function public.fr_is_host(p_room_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.rooms where id = p_room_id and host_id = auth.uid());
$$;

drop policy if exists rooms_member_read on public.rooms;
create policy rooms_member_read on public.rooms
  for select to authenticated using (public.fr_is_member(id));

drop policy if exists room_players_member_read on public.room_players;
create policy room_players_member_read on public.room_players
  for select to authenticated using (public.fr_is_member(room_id));

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------

create or replace function public.fr_uid() returns uuid
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v uuid := auth.uid();
begin
  if v is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = 'P0001';
  end if;
  return v;
end $$;

create or replace function public.fr_nickname(p_nickname text) returns text
language plpgsql immutable as $$
declare
  v text := regexp_replace(btrim(coalesce(p_nickname, '')), '\s+', ' ', 'g');
begin
  if char_length(v) < 1 or char_length(v) > 16 then
    raise exception 'INVALID_NICKNAME' using errcode = 'P0001';
  end if;
  return v;
end $$;

create or replace function public.fr_room_state(p_room_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id,
    'code', r.code,
    'hostId', r.host_id,
    'status', r.status,
    'raceId', r.race_id,
    'startAt', case when r.start_at is null then null else floor(extract(epoch from r.start_at) * 1000) end,
    'cancelReason', r.cancel_reason,
    'results', r.results,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', p.user_id,
        'nickname', p.nickname,
        'lane', p.lane,
        'ready', p.ready,
        'joinedAt', floor(extract(epoch from p.joined_at) * 1000)
      ) order by p.lane)
      from public.room_players p where p.room_id = r.id
    ), '[]'::jsonb)
  )
  from public.rooms r where r.id = p_room_id;
$$;

create or replace function public.fr_cleanup_stale_rooms() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from public.rooms
  where (status in ('LOBBY','FINISHED') and last_activity_at < now() - interval '10 minutes')
     or (status in ('COUNTDOWN','RUNNING') and last_activity_at < now() - interval '30 minutes');
$$;

-- Caller must hold the room row lock.
create or replace function public.fr_advance(p_room_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.rooms set status = 'RUNNING'
  where id = p_room_id and status = 'COUNTDOWN' and start_at <= now();
$$;

-- Caller must hold the room row lock. Assigns a host if the current one left; deletes empty rooms.
create or replace function public.fr_fix_host(p_room_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_next uuid;
begin
  if not exists (select 1 from public.room_players where room_id = p_room_id) then
    delete from public.rooms where id = p_room_id;
    return;
  end if;
  if not exists (
    select 1 from public.rooms r join public.room_players p on p.room_id = r.id and p.user_id = r.host_id
    where r.id = p_room_id
  ) then
    select user_id into v_next from public.room_players
    where room_id = p_room_id order by joined_at, lane limit 1;
    update public.rooms set host_id = v_next where id = p_room_id;
  end if;
end $$;

-- Caller must hold the room row lock. Lobby only: frees slots unseen for 10 seconds.
create or replace function public.fr_prune(p_room_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.rooms where id = p_room_id and status in ('LOBBY','FINISHED')) then
    delete from public.room_players
    where room_id = p_room_id and last_seen_at < now() - interval '10 seconds';
    perform public.fr_fix_host(p_room_id);
  end if;
end $$;

create or replace function public.fr_cancel(p_room_id uuid, p_reason text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.rooms
     set status = 'LOBBY', race_id = null, start_at = null, cancel_reason = p_reason
   where id = p_room_id;
  update public.room_players set ready = false where room_id = p_room_id;
$$;

-- Locks the room for a member, or raises ROOM_NOT_FOUND.
create or replace function public.fr_lock_member_room(p_room_id uuid, p_uid uuid) returns public.rooms
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or not exists (
    select 1 from public.room_players where room_id = p_room_id and user_id = p_uid
  ) then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;
  return v_room;
end $$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

create or replace function public.server_now() returns double precision
language sql volatile as $$
  select extract(epoch from clock_timestamp()) * 1000;
$$;

create or replace function public.create_room(nickname text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_nick text := public.fr_nickname(nickname);
  v_code text;
  v_room_id uuid;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  perform public.fr_cleanup_stale_rooms();
  for attempt in 1..20 loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    begin
      insert into public.rooms (code, host_id) values (v_code, v_uid) returning id into v_room_id;
      exit;
    exception when unique_violation then
      v_room_id := null;
    end;
  end loop;
  if v_room_id is null then
    raise exception 'ROOM_CODE_EXHAUSTED' using errcode = 'P0001';
  end if;
  insert into public.room_players (room_id, user_id, nickname, lane) values (v_room_id, v_uid, v_nick, 1);
  return public.fr_room_state(v_room_id);
end $$;

create or replace function public.join_room(room_code text, nickname text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_nick text := public.fr_nickname(nickname);
  v_room public.rooms;
  v_count int;
  v_lane int;
begin
  perform public.fr_cleanup_stale_rooms();
  -- Serializes concurrent joins to the same room.
  select * into v_room from public.rooms where code = upper(btrim(room_code)) for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform public.fr_advance(v_room.id);
  perform public.fr_prune(v_room.id);
  select * into v_room from public.rooms where id = v_room.id;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Same anonymous user returning: keep the slot (also mid-race).
  if exists (select 1 from public.room_players where room_id = v_room.id and user_id = v_uid) then
    update public.room_players set last_seen_at = now(), nickname = v_nick
     where room_id = v_room.id and user_id = v_uid;
    update public.rooms set last_activity_at = now() where id = v_room.id;
    return public.fr_room_state(v_room.id);
  end if;

  if v_room.status in ('COUNTDOWN','RUNNING') then
    raise exception 'ROOM_ALREADY_RUNNING' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.room_players where room_id = v_room.id;
  if v_count >= 7 then
    raise exception 'ROOM_FULL' using errcode = 'P0001';
  end if;

  select min(l) into v_lane from generate_series(1, 7) as l
  where l not in (select lane from public.room_players where room_id = v_room.id);
  if v_lane is null then
    raise exception 'ROOM_FULL' using errcode = 'P0001';
  end if;

  insert into public.room_players (room_id, user_id, nickname, lane) values (v_room.id, v_uid, v_nick, v_lane);
  update public.rooms set last_activity_at = now() where id = v_room.id;
  return public.fr_room_state(v_room.id);
end $$;

create or replace function public.leave_room(room_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_room public.rooms;
begin
  select * into v_room from public.rooms r where r.id = leave_room.room_id for update;
  if not found then
    return null;
  end if;
  delete from public.room_players p where p.room_id = v_room.id and p.user_id = v_uid;
  if v_room.host_id = v_uid and v_room.status in ('COUNTDOWN','RUNNING') then
    perform public.fr_cancel(v_room.id, 'HOST_DISCONNECTED');
  end if;
  perform public.fr_fix_host(v_room.id);
  return public.fr_room_state(v_room.id);
end $$;

create or replace function public.set_ready(room_id uuid, ready boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_room public.rooms := public.fr_lock_member_room(set_ready.room_id, v_uid);
begin
  perform public.fr_advance(v_room.id);
  if (select status from public.rooms where id = v_room.id) in ('COUNTDOWN','RUNNING') then
    raise exception 'ROOM_ALREADY_RUNNING' using errcode = 'P0001';
  end if;
  update public.room_players p set ready = set_ready.ready, last_seen_at = now()
   where p.room_id = v_room.id and p.user_id = v_uid;
  return public.fr_room_state(v_room.id);
end $$;

create or replace function public.start_room_race(room_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_room public.rooms := public.fr_lock_member_room(start_room_race.room_id, v_uid);
  v_count int;
begin
  perform public.fr_advance(v_room.id);
  perform public.fr_prune(v_room.id);
  select * into v_room from public.rooms where id = v_room.id;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_room.host_id <> v_uid then
    raise exception 'NOT_HOST' using errcode = 'P0001';
  end if;
  if v_room.status in ('COUNTDOWN','RUNNING') then
    raise exception 'ROOM_ALREADY_RUNNING' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.room_players p where p.room_id = v_room.id;
  if v_count < 2 or v_count > 7 then
    raise exception 'NOT_ENOUGH_PLAYERS' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.room_players p where p.room_id = v_room.id and not p.ready) then
    raise exception 'NOT_ALL_READY' using errcode = 'P0001';
  end if;

  update public.rooms
     set status = 'COUNTDOWN',
         race_id = gen_random_uuid(),
         start_at = now() + interval '5 seconds',
         cancel_reason = null,
         results = null,
         finished_at = null,
         last_activity_at = now()
   where id = v_room.id;
  -- Everyone must press READY again for a rematch.
  update public.room_players p set ready = false where p.room_id = v_room.id;
  return public.fr_room_state(v_room.id);
end $$;

create or replace function public.finish_room_race(room_id uuid, race_id uuid, results_json jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_room public.rooms := public.fr_lock_member_room(finish_room_race.room_id, v_uid);
begin
  if v_room.host_id <> v_uid then
    raise exception 'NOT_HOST' using errcode = 'P0001';
  end if;
  if jsonb_typeof(results_json) <> 'array' or jsonb_array_length(results_json) > 7 then
    raise exception 'INVALID_RESULTS' using errcode = 'P0001';
  end if;
  if v_room.race_id is distinct from finish_room_race.race_id or v_room.status not in ('COUNTDOWN','RUNNING') then
    -- Stale or duplicate finish: no change.
    return public.fr_room_state(v_room.id);
  end if;
  update public.rooms
     set status = 'FINISHED', results = results_json, finished_at = now(), last_activity_at = now()
   where id = v_room.id;
  return public.fr_room_state(v_room.id);
end $$;

create or replace function public.cancel_room_race(room_id uuid, race_id uuid, reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_room public.rooms := public.fr_lock_member_room(cancel_room_race.room_id, v_uid);
begin
  if v_room.host_id <> v_uid then
    raise exception 'NOT_HOST' using errcode = 'P0001';
  end if;
  if v_room.race_id = cancel_room_race.race_id and v_room.status in ('COUNTDOWN','RUNNING') then
    perform public.fr_cancel(v_room.id, left(coalesce(reason, 'CANCELLED'), 40));
  end if;
  return public.fr_room_state(v_room.id);
end $$;

create or replace function public.heartbeat_room(room_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.fr_uid();
  v_room public.rooms := public.fr_lock_member_room(heartbeat_room.room_id, v_uid);
  v_next uuid;
begin
  update public.room_players p set last_seen_at = now() where p.room_id = v_room.id and p.user_id = v_uid;
  update public.rooms set last_activity_at = now() where id = v_room.id;
  perform public.fr_advance(v_room.id);
  select * into v_room from public.rooms where id = v_room.id;

  if v_room.status in ('COUNTDOWN','RUNNING') and not exists (
    select 1 from public.room_players p
    where p.room_id = v_room.id and p.user_id = v_room.host_id and p.last_seen_at >= now() - interval '5 seconds'
  ) then
    perform public.fr_cancel(v_room.id, 'HOST_DISCONNECTED');
    select p.user_id into v_next from public.room_players p
    where p.room_id = v_room.id and p.user_id <> v_room.host_id and p.last_seen_at >= now() - interval '5 seconds'
    order by p.joined_at, p.lane limit 1;
    if v_next is not null then
      update public.rooms set host_id = v_next where id = v_room.id;
    end if;
  end if;

  perform public.fr_prune(v_room.id);
  if not exists (select 1 from public.room_players p where p.room_id = v_room.id and p.user_id = v_uid) then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0001';
  end if;
  return public.fr_room_state(v_room.id);
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: only the client RPCs are callable, only by signed-in users
-- (Supabase anonymous sign-ins use the authenticated role).
-- ---------------------------------------------------------------------------

revoke all on function
  public.fr_touch_updated_at(), public.fr_uid(), public.fr_nickname(text),
  public.fr_room_state(uuid), public.fr_cleanup_stale_rooms(), public.fr_advance(uuid),
  public.fr_fix_host(uuid), public.fr_prune(uuid), public.fr_cancel(uuid, text),
  public.fr_lock_member_room(uuid, uuid), public.fr_is_member(uuid), public.fr_is_host(uuid),
  public.server_now(), public.create_room(text), public.join_room(text, text),
  public.leave_room(uuid), public.set_ready(uuid, boolean), public.start_room_race(uuid),
  public.finish_room_race(uuid, uuid, jsonb), public.cancel_room_race(uuid, uuid, text),
  public.heartbeat_room(uuid)
from public, anon, authenticated;
-- RLS policies call these two.
grant execute on function public.fr_is_member(uuid), public.fr_is_host(uuid) to authenticated;

grant execute on function
  public.server_now(),
  public.create_room(text),
  public.join_room(text, text),
  public.leave_room(uuid),
  public.set_ready(uuid, boolean),
  public.start_room_race(uuid),
  public.finish_room_race(uuid, uuid, jsonb),
  public.cancel_room_race(uuid, uuid, text),
  public.heartbeat_room(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime authorization for private channels
--   room:{room_id}                  presence + room events  (members)
--   room:{room_id}:snapshot         read: members, write: host only
--   room:{room_id}:input:{user_id}  read: members (host listens), write: that user only
-- ---------------------------------------------------------------------------

create or replace function public.fr_topic_room(p_topic text) returns uuid
language plpgsql immutable as $$
begin
  if p_topic ~ '^room:[0-9a-fA-F-]{36}(:|$)' then
    return split_part(p_topic, ':', 2)::uuid;
  end if;
  return null;
end $$;

revoke all on function public.fr_topic_room(text) from public, anon;
grant execute on function public.fr_topic_room(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'realtime')
     and to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists finger_run_read on realtime.messages';
    execute $p$
      create policy finger_run_read on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension in ('broadcast', 'presence')
        and public.fr_is_member(public.fr_topic_room(realtime.topic()))
      )
    $p$;
    execute 'drop policy if exists finger_run_write on realtime.messages';
    execute $p$
      create policy finger_run_write on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension in ('broadcast', 'presence')
        and public.fr_is_member(public.fr_topic_room(realtime.topic()))
        and (
          realtime.topic() ~ '^room:[0-9a-fA-F-]{36}$'
          or (realtime.topic() ~ ':snapshot$' and public.fr_is_host(public.fr_topic_room(realtime.topic())))
          or realtime.topic() = 'room:' || public.fr_topic_room(realtime.topic())::text || ':input:' || auth.uid()::text
        )
      )
    $p$;
  end if;
end $$;
