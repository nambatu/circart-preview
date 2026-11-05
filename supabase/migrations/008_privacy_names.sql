-- CIRCArt 008 — two small fixes from the review.
--
-- 1. Live games: scores stay secret until the reveal.
--    Members could read game_players (directly or through Realtime) and see
--    another player's score jump the moment they answered — i.e. who got the
--    card right before the round closed. Now the app may only read who is in
--    the game (name, joined, dropped); scores come through get_game(), which
--    already shows them at the right time. Realtime keeps listening to
--    `games` (every join, answer and turn change touches games.updated_at).
--
-- 2. Names: the name typed for one game no longer overwrites your profile
--    name, unless the profile still has the default "Guest NNNN".

revoke select on public.game_players from authenticated;
grant select (game_id, player_id, display_name, joined_at, dropped) on public.game_players to authenticated;
do $$ begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_players') then
    alter publication supabase_realtime drop table public.game_players;
  end if;
end $$;

-- get_game() shows live scores only from the last closed round: while a live
-- round is open, everyone's score is reported as it was when the round opened.
alter table public.game_players add column round_score int not null default 0;   -- score at the last round start

create or replace function public._snapshot_round_scores() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'live' and new.current_turn is distinct from old.current_turn then
    update game_players set round_score = score where game_id = new.id;
  end if;
  return null;
end $$;
create trigger games_round_scores after update of current_turn on public.games
  for each row execute function public._snapshot_round_scores();

-- Keep the profile name; only a default guest name is replaced.
create or replace function public._set_display_name(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); n text := nullif(trim(p_name), '');
begin
  if n is not null then
    if char_length(n) > 24 then raise exception 'display_name_invalid'; end if;
    update profiles set display_name = n where id = me and display_name ~ '^Guest [0-9]+$';
    return n;
  end if;
  return (select display_name from profiles where id = me);
end $$;

-- get_game() from 007 with the round-start scores during an open live round
create or replace function public.get_game(p_game uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  g      games := _tick(p_game);
  gp     game_players;
  t0     int;
  t1     int;
  phase  text;
  mine_open boolean;
begin
  select * into gp from game_players where game_id = p_game and player_id = me;
  if g.id is null or gp.player_id is null then raise exception 'game_not_found'; end if;

  t0 := case when g.kind = 'daily' then 1 else (g.current_turn - 1) * g.cards_per_turn + 1 end;
  t1 := case when g.kind = 'daily' then g.card_count else g.current_turn * g.cards_per_turn end;
  mine_open := g.status = 'playing' and exists (
    select 1 from generate_series(t0, t1) p
     where not exists (select 1 from answers x where x.game_id = g.id and x.player_id = me
                         and x.position = p and (x.answered_at is not null or x.timed_out)));

  phase := case
    when g.status = 'lobby'     then 'lobby'
    when g.status = 'cancelled' then 'cancelled'
    when g.status = 'finished'  then 'finished'
    when gp.dropped             then 'dropped'
    when g.kind = 'live' and g.turn_closed_at is not null then 'reveal'
    when mine_open              then 'play'
    when g.kind = 'daily'       then 'done'
    else 'waiting' end;

  return jsonb_build_object(
    'id', g.id, 'kind', g.kind, 'code', g.code, 'status', g.status, 'phase', phase,
    'is_host', g.host_id = me,
    'card_count', g.card_count, 'cards_per_turn', g.cards_per_turn,
    'turns', g.card_count / g.cards_per_turn, 'current_turn', g.current_turn,
    'answer_seconds', g.answer_seconds,
    'turn_deadline', g.turn_deadline,
    'next_round_at', case when g.kind = 'live' and g.turn_closed_at is not null
                          then g.turn_closed_at + make_interval(secs => g.reveal_seconds) end,
    'server_now', _now(),
    'me', jsonb_build_object('score', case when g.kind = 'live' and g.status = 'playing' and g.turn_closed_at is null then gp.round_score else gp.score end, 'correct', gp.correct, 'answered', gp.answered,
                             'streak', gp.streak, 'best_streak', gp.best_streak,
                             'rank', gp.final_rank, 'missed_turns', gp.missed_turns),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', p.display_name, 'score', case when g.kind = 'live' and g.status = 'playing' and g.turn_closed_at is null then p.round_score else p.score end, 'is_me', p.player_id = me,
                  'is_host', p.player_id = g.host_id, 'dropped', p.dropped, 'rank', p.final_rank,
                  'done_this_turn', g.status = 'playing' and not exists (
                      select 1 from generate_series(t0, t1) q
                       where not exists (select 1 from answers x where x.game_id = g.id
                                           and x.player_id = p.player_id and x.position = q
                                           and (x.answered_at is not null or x.timed_out))))
                  order by case when g.kind = 'live' and g.status = 'playing' and g.turn_closed_at is null then p.round_score else p.score end desc, p.total_ms, p.joined_at), '[]')
                from game_players p where p.game_id = g.id and g.kind <> 'daily'),
    -- the shared timeline as I'm allowed to see it: the start card plus every
    -- card I've finished whose result is out
    'timeline', (select coalesce(jsonb_agg(jsonb_build_object(
                   'position', gc.position, 'year', c.year, 'title', c.title,
                   'artist', c.artist, 'image_url', c.image_url) order by c.year, gc.position), '[]')
                 from game_cards gc join cards c on c.id = gc.card_id
                 where gc.game_id = g.id
                   and (gc.position = 0 or exists (
                     select 1 from answers x where x.game_id = g.id and x.player_id = me
                        and x.position = gc.position and (x.timed_out or (x.answered_at is not null and x.artist_done))
                        and (g.kind <> 'live' or g.status = 'finished'
                             or _turn_of(g, gc.position) < g.current_turn or g.turn_closed_at is not null)))));
end $$;

revoke execute on function public._snapshot_round_scores() from public, anon, authenticated;
