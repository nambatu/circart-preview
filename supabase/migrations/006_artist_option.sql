-- CIRCArt 006 — "Artist bonus" can be switched off for games with friends.
--
-- Off = the raw game: place the card, done. No artist question, no +200.
-- The host sets it in the lobby (set_game_options). The daily always has it.
-- Implemented with two small triggers so the engine (002) stays untouched:
--   · cards dealt into such a game get no artist options
--   · an answer in such a game counts as "artist done" straight away, so
--     live rounds still close as soon as everyone has placed

alter table public.games add column artist_bonus boolean not null default true;

create function public._no_artist_options() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (select artist_bonus from games where id = new.game_id) then new.artist_options := '{}'; end if;
  return new;
end $$;
create trigger game_cards_artist_option before insert on public.game_cards
  for each row execute function public._no_artist_options();

create function public._no_artist_answer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.answered_at is not null or new.timed_out) and not new.artist_done
     and not (select artist_bonus from games where id = new.game_id) then
    new.artist_done := true;
  end if;
  return new;
end $$;
create trigger answers_artist_option before insert or update on public.answers
  for each row execute function public._no_artist_answer();

create function public.set_game_options(p_game uuid, p_artist_bonus boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g games;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  if g.host_id <> _me() then raise exception 'not_host'; end if;
  if g.status <> 'lobby' or g.kind not in ('live', 'async') then raise exception 'game_started'; end if;
  update games set artist_bonus = coalesce(p_artist_bonus, true), updated_at = _now() where id = g.id;
  return jsonb_build_object('artist_bonus', coalesce(p_artist_bonus, true));
end $$;

create function public.game_options(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g games;
begin
  select * into g from games where id = p_game;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  return jsonb_build_object('artist_bonus', g.artist_bonus);
end $$;

-- a rematch keeps the setting
create function public._rematch_keeps_options() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rematch_id is distinct from old.rematch_id and new.rematch_id is not null then
    update games set artist_bonus = new.artist_bonus where id = new.rematch_id and status = 'lobby';
  end if;
  return null;
end $$;
create trigger games_rematch_options after update of rematch_id on public.games
  for each row execute function public._rematch_keeps_options();

revoke execute on function public._no_artist_options(), public._no_artist_answer(), public._rematch_keeps_options(),
  public.set_game_options(uuid, boolean), public.game_options(uuid) from public, anon, authenticated;
grant execute on function public.set_game_options(uuid, boolean), public.game_options(uuid) to authenticated;
