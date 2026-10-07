-- Finger Run skins: each player's drawing as a small PNG, visible only to their room.
-- Safe to re-run.
--
-- Path: skins/{room_id}/{user_id}.png
--   read:   members of that room
--   write:  only your own file, only while you are a member of the room
--   delete: only your own file (also after leaving)
-- The app deletes your file when you leave a room. Files of players who closed the tab
-- without leaving remain until removed (Storage → skins) — each is at most 256 KB.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('skins', 'skins', false, 262144, array['image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Room id from "room_id/user_id.png"; null for anything else.
create or replace function public.fr_skin_room(p_name text) returns uuid
language plpgsql immutable as $$
begin
  if p_name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.png$' then
    return split_part(p_name, '/', 1)::uuid;
  end if;
  return null;
end $$;

create or replace function public.fr_is_own_skin(p_name text) returns boolean
language sql stable as $$
  select p_name = public.fr_skin_room(p_name)::text || '/' || auth.uid()::text || '.png';
$$;

revoke all on function public.fr_skin_room(text), public.fr_is_own_skin(text) from public, anon;
grant execute on function public.fr_skin_room(text), public.fr_is_own_skin(text) to authenticated;

drop policy if exists finger_run_skins_read on storage.objects;
create policy finger_run_skins_read on storage.objects
  for select to authenticated
  using (bucket_id = 'skins' and public.fr_is_member(public.fr_skin_room(name)));

drop policy if exists finger_run_skins_insert on storage.objects;
create policy finger_run_skins_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'skins'
    and public.fr_is_own_skin(name)
    and public.fr_is_member(public.fr_skin_room(name))
  );

drop policy if exists finger_run_skins_update on storage.objects;
create policy finger_run_skins_update on storage.objects
  for update to authenticated
  using (bucket_id = 'skins' and public.fr_is_own_skin(name))
  with check (
    bucket_id = 'skins'
    and public.fr_is_own_skin(name)
    and public.fr_is_member(public.fr_skin_room(name))
  );

drop policy if exists finger_run_skins_delete on storage.objects;
create policy finger_run_skins_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'skins' and public.fr_is_own_skin(name));
