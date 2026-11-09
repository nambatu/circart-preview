-- CIRCArt 018 — games with friends: the timer can be switched off.
--
-- Julian (6 Nov): "in multiplayer mode the timer should be a setting that can
-- also be off". The host decides in the lobby, like the bonus questions.
--   · games.timed: true = 20 seconds per card (as before), false = no timer
--   · defaults: live games ON, games over a few days (async) OFF
--   · no timer = a long time per card instead of 20 s, so every existing rule
--     keeps working without being rewritten:
--       async: 24 h per card (the turn itself still closes after its 24 h)
--       live:  10 minutes per card (a safety net, so one player who walked
--              away can't freeze the round forever); no countdown is shown
--     Points: 1000 − 500 × (time / time allowed), so without a timer every
--     right card is worth (almost exactly) the full 1000 again.
--   · the artist / style question: in async games it closed silently 20 s
--     after placing the card (players then saw no right answers and got no
--     points). With the timer off it stays open until you move on; with the
--     timer on the app now shows that countdown.

alter table public.games add column timed boolean not null default true;

create function public._untimed_seconds(p_kind text) returns int
language sql immutable as $$ select case p_kind when 'live' then 600 else 86400 end $$;

-- new async games start without a timer
create function public._games_timer_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'async' then
    new.timed := false;
    new.answer_seconds := _untimed_seconds('async');
  end if;
  return new;
end $$;
create trigger games_timer_default before insert on public.games
  for each row execute function public._games_timer_default();

-- the host switches it in the lobby (with the bonus questions)
drop function public.set_game_options(uuid, boolean, boolean);
create function public.set_game_options(p_game uuid, p_artist_bonus boolean default null,
                                        p_movement_bonus boolean default null, p_timer boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g games;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  if g.host_id <> _me() then raise exception 'not_host'; end if;
  if g.status <> 'lobby' or g.kind not in ('live', 'async') then raise exception 'game_started'; end if;
  update games set artist_bonus = coalesce(p_artist_bonus, artist_bonus),
                   movement_bonus = coalesce(p_movement_bonus, movement_bonus),
                   timed = coalesce(p_timer, timed),
                   answer_seconds = case when coalesce(p_timer, timed) then 20 else _untimed_seconds(kind) end,
                   updated_at = _now()
   where id = g.id returning * into g;
  return jsonb_build_object('artist_bonus', g.artist_bonus, 'movement_bonus', g.movement_bonus, 'timer', g.timed);
end $$;

create or replace function public.game_options(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g games;
begin
  select * into g from games where id = p_game;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  return jsonb_build_object('artist_bonus', g.artist_bonus, 'movement_bonus', g.movement_bonus, 'timer', g.timed);
end $$;

-- a rematch keeps the host's settings, the timer included
create or replace function public._rematch_keeps_options() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rematch_id is distinct from old.rematch_id and new.rematch_id is not null then
    update games set artist_bonus = new.artist_bonus, movement_bonus = new.movement_bonus,
                     timed = new.timed, answer_seconds = new.answer_seconds
     where id = new.rematch_id and status = 'lobby';
  end if;
  return null;
end $$;

-- pick_bonus() from 007: the 20-second window only applies with the timer on
create or replace function public.pick_bonus(p_game uuid, p_position int, p_artist text, p_movement text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  g      games;
  a      answers;
  gc     game_cards;
  v_real text;
  v_mov  text;
  a_ok   boolean := false;
  m_ok   boolean := false;
begin
  select * into g from games where id = p_game for update;
  select * into a from answers where game_id = p_game and player_id = me and position = p_position for update;
  if g.id is null or a.player_id is null or a.answered_at is null then raise exception 'not_answered'; end if;
  if a.artist_done then raise exception 'artist_closed'; end if;
  if (g.kind = 'live' and (g.turn_closed_at is not null or _turn_of(g, p_position) <> g.current_turn))
     or (g.kind <> 'live' and g.timed and _now() > a.answered_at + interval '20 seconds') then
    update answers set artist_done = true where game_id = p_game and player_id = me and position = p_position;
    raise exception 'artist_closed';
  end if;

  select * into gc from game_cards where game_id = p_game and position = p_position;
  select c.artist, _movement_group(c.movement) into v_real, v_mov from cards c where c.id = gc.card_id;
  if p_artist is not null and not (p_artist = any(gc.artist_options)) then raise exception 'bad_choice'; end if;
  if p_movement is not null and not (p_movement = any(gc.movement_options)) then raise exception 'bad_choice'; end if;
  a_ok := p_artist is not null and p_artist = v_real;
  m_ok := p_movement is not null and p_movement = v_mov;

  update answers set artist_choice = p_artist, artist_correct = a_ok,
                     movement_choice = p_movement, movement_correct = m_ok, artist_done = true,
                     points = points + case when a_ok then 200 else 0 end + case when m_ok then 100 else 0 end
   where game_id = p_game and player_id = me and position = p_position;
  update game_players set score = score + case when a_ok then 200 else 0 end + case when m_ok then 100 else 0 end,
                          artists_named = artists_named + a_ok::int, movements_named = movements_named + m_ok::int
   where game_id = p_game and player_id = me;
  update games set updated_at = _now() where id = p_game;
  perform _tick(p_game);
  return case when g.kind = 'live' then '{}'::jsonb
              else jsonb_build_object('artist_correct', a_ok, 'artist', case when p_artist is not null then v_real end,
                                      'movement_correct', m_ok, 'movement', case when p_movement is not null then v_mov end) end;
end $$;

revoke execute on function public._untimed_seconds(text), public._games_timer_default(),
  public.set_game_options(uuid, boolean, boolean, boolean), public.pick_bonus(uuid, int, text, text)
  from public, anon, authenticated;
grant execute on function public.set_game_options(uuid, boolean, boolean, boolean),
  public.pick_bonus(uuid, int, text, text) to authenticated;
