-- CIRCArt 004 — polish: per-card results for sharing, and rematches.
--
--   my_results(game)   your own result per card (for the share squares).
--                      Live games: only once the game is over, so nothing
--                      leaks before a round's reveal.
--   rematch(game)      "Play again": the first player to ask creates a new
--                      lobby with the same settings and becomes its host;
--                      everyone after that joins the same lobby.
--   rematch_info(game) the rematch lobby, if there is one (for the podium).

alter table public.games add column rematch_id uuid references public.games(id) on delete set null;

create function public.my_results(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := _me(); g games;
begin
  select * into g from games where id = p_game;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = me) then
    raise exception 'game_not_found';
  end if;
  if g.kind = 'live' and g.status <> 'finished' then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'position', a.position, 'correct', a.correct, 'timed_out', a.timed_out,
            'artist', a.artist_correct, 'points', a.points) order by a.position), '[]')
          from answers a
         where a.game_id = g.id and a.player_id = me and a.position > 0
           and (a.answered_at is not null or a.timed_out));
end $$;

create function public.rematch_info(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me uuid := _me(); g games; r games;
begin
  select * into g from games where id = p_game;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = me) then
    raise exception 'game_not_found';
  end if;
  select * into r from games where id = g.rematch_id;
  if r.id is null or r.status = 'cancelled' then return null; end if;
  return jsonb_build_object('id', r.id, 'code', r.code, 'status', r.status,
    'host', (select display_name from game_players where game_id = r.id and player_id = r.host_id),
    'joined', exists (select 1 from game_players where game_id = r.id and player_id = me),
    'players', (select count(*) from game_players where game_id = r.id));
end $$;

create function public.rematch(p_game uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   uuid := _me();
  g    games;
  r    games;
  name text;
  res  jsonb;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = me) then
    raise exception 'game_not_found';
  end if;
  if g.kind not in ('live', 'async') or g.status <> 'finished' then raise exception 'bad_settings'; end if;
  select display_name into name from game_players where game_id = g.id and player_id = me;

  select * into r from games where id = g.rematch_id;
  if r.id is not null and r.status = 'lobby' then
    perform join_game(r.code, name);
    return jsonb_build_object('id', r.id, 'code', r.code);
  end if;
  if r.id is not null and r.status = 'playing'
     and exists (select 1 from game_players where game_id = r.id and player_id = me) then
    return jsonb_build_object('id', r.id, 'code', r.code);
  end if;

  res := create_game(g.kind, g.card_count, g.cards_per_turn, name);
  update games set rematch_id = (res->>'id')::uuid, updated_at = _now() where id = g.id;
  return res;
end $$;

revoke execute on function public.my_results(uuid), public.rematch_info(uuid), public.rematch(uuid)
  from public, anon;
grant execute on function public.my_results(uuid), public.rematch_info(uuid), public.rematch(uuid)
  to authenticated;
