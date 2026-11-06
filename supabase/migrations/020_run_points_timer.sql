-- CIRCArt 020 — Monthly Run: one point per card; timer with your own seconds.
--
-- Julian (6 Nov):
--   "the monthly challenge should only be 1 point for each correctly placed
--    piece. The artist and style guess we can leave out."
--   "a setting for the timer not only 20 sec or none but a custom time"
--
-- 1. Runs: a right card is worth exactly 1 point (no speed points, no streak
--    bonus), and runs ask no artist or style questions. The run's score is
--    simply "cards placed right", so the board reads "14 cards". The 20-second
--    limit per card stays (no time to look things up). Runs already played
--    are recounted the same way, so the November board stays fair.
-- 2. Games with friends: the host picks the seconds per card (5 to 300) or no
--    timer at all. set_game_options() gets p_seconds; game_options() returns it.

-- ─── 1. Monthly Run ─────────────────────────────────────────────────────────
create function public._run_no_bonus() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'run' then
    new.artist_bonus := false;
    new.movement_bonus := false;
  end if;
  return new;
end $$;
create trigger games_run_no_bonus before insert on public.games
  for each row execute function public._run_no_bonus();

-- answer() from 007, with the run rule
create or replace function public.answer(p_game uuid, p_position int, p_slot int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me       uuid := _me();
  g        games;
  gp       game_players;
  a        answers;
  c        cards;
  years    int[];
  n        int;
  elapsed  numeric;
  ok       boolean;
  v_streak int;
  pts      int := 0;
  late     boolean;
  opts     text[];
  mopts    text[];
begin
  select * into g from games where id = p_game for update;
  select * into gp from game_players where game_id = p_game and player_id = me for update;
  if g.id is null or gp.player_id is null then raise exception 'game_not_found'; end if;
  if g.status <> 'playing' or gp.dropped then raise exception 'not_playing'; end if;
  select * into a from answers where game_id = p_game and player_id = me and position = p_position for update;
  if a.player_id is null or a.shown_at is null then raise exception 'card_not_open'; end if;
  if a.answered_at is not null or a.timed_out then raise exception 'already_answered'; end if;

  elapsed := extract(epoch from _now() - a.shown_at);
  late := elapsed > g.answer_seconds + extract(epoch from _grace());
  select c2.* into c from game_cards gc join cards c2 on c2.id = gc.card_id
   where gc.game_id = p_game and gc.position = p_position;
  select artist_options, movement_options into opts, mopts from game_cards where game_id = p_game and position = p_position;

  if late then
    update answers set timed_out = true, artist_done = true
     where game_id = p_game and player_id = me and position = p_position;
    update game_players set streak = 0 where game_id = p_game and player_id = me;
  else
    years := _years_before(p_game, p_position);
    n := coalesce(array_length(years, 1), 0);
    if p_slot is null or p_slot < 0 or p_slot > n then raise exception 'bad_slot'; end if;
    ok := (p_slot = 0 or c.year >= years[p_slot]) and (p_slot = n or c.year <= years[p_slot + 1]);
    v_streak := case when ok then gp.streak + 1 else 0 end;
    if ok and g.kind = 'run' then
      pts := 1;                                   -- Monthly Run: one point per card placed right (020)
    elsif ok then
      pts := round(1000 - 500 * least(elapsed / g.answer_seconds, 1))::int
           + 50 * least(greatest(v_streak - 1, 0), 4);
    end if;
    update answers set answered_at = _now(), slot = p_slot, correct = ok,
                       ms = round(elapsed * 1000)::int, points = pts
     where game_id = p_game and player_id = me and position = p_position;
    update game_players set
      score = score + pts, correct = correct + ok::int, streak = v_streak,
      best_streak = greatest(best_streak, v_streak), total_ms = total_ms + round(elapsed * 1000)::bigint
     where game_id = p_game and player_id = me;
  end if;
  perform _recount(p_game, me);
  update games set updated_at = _now() where id = p_game;
  perform _tick(p_game);

  -- live keeps the result secret until the round closes for everyone
  return jsonb_strip_nulls(jsonb_build_object(
    'timed_out', late,
    'artist_options', case when late then null else to_jsonb(opts) end,
    'movement_options', case when late then null else to_jsonb(mopts) end,
    'correct', case when g.kind <> 'live' then (not late and ok) end,
    'points',  case when g.kind <> 'live' then pts end,
    'streak',  case when g.kind <> 'live' and not late then v_streak end));
end $$;

-- runs played so far: recount as cards placed right; unfinished runs lose their open bonus questions
update public.games set artist_bonus = false, movement_bonus = false where kind = 'run';
update public.game_cards gc set artist_options = '{}', movement_options = '{}'
  from public.games g where g.id = gc.game_id and g.kind = 'run';
update public.answers a set points = case when a.correct then 1 else 0 end,
                            artist_choice = null, artist_correct = false, movement_choice = null, movement_correct = false, artist_done = true
  from public.games g where g.id = a.game_id and g.kind = 'run';
update public.game_players gp set score = gp.correct, artists_named = 0, movements_named = 0
  from public.games g where g.id = gp.game_id and g.kind = 'run';

-- ─── 2. timer with your own seconds ─────────────────────────────────────────
drop function public.set_game_options(uuid, boolean, boolean, boolean);
create function public.set_game_options(p_game uuid, p_artist_bonus boolean default null,
                                        p_movement_bonus boolean default null, p_timer boolean default null,
                                        p_seconds int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g games; on_ boolean; secs int;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  if g.host_id <> _me() then raise exception 'not_host'; end if;
  if g.status <> 'lobby' or g.kind not in ('live', 'async') then raise exception 'game_started'; end if;
  if p_seconds is not null and p_seconds not between 5 and 300 then raise exception 'bad_seconds'; end if;
  on_ := coalesce(p_timer, p_seconds is not null or g.timed);
  secs := case when not on_ then _untimed_seconds(g.kind)
               when p_seconds is not null then p_seconds
               when g.timed then g.answer_seconds
               else 20 end;
  update games set artist_bonus = coalesce(p_artist_bonus, artist_bonus),
                   movement_bonus = coalesce(p_movement_bonus, movement_bonus),
                   timed = on_, answer_seconds = secs, updated_at = _now()
   where id = g.id returning * into g;
  return jsonb_build_object('artist_bonus', g.artist_bonus, 'movement_bonus', g.movement_bonus,
                            'timer', g.timed, 'seconds', case when g.timed then g.answer_seconds end);
end $$;

create or replace function public.game_options(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g games;
begin
  select * into g from games where id = p_game;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  return jsonb_build_object('artist_bonus', g.artist_bonus, 'movement_bonus', g.movement_bonus,
                            'timer', g.timed, 'seconds', case when g.timed then g.answer_seconds end);
end $$;

revoke execute on function public._run_no_bonus(), public.set_game_options(uuid, boolean, boolean, boolean, int)
  from public, anon, authenticated;
grant execute on function public.set_game_options(uuid, boolean, boolean, boolean, int) to authenticated;
