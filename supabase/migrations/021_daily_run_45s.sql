-- CIRCArt 021 — Daily and Monthly Run: 45 seconds per card.
--
-- Julian (11 Nov): "Timer fuer die daily und monthly challenges erhoehen auf
-- 45 Sekunden insgesamt."
--   · new daily and run games get answer_seconds = 45 (a trigger, so every
--     place that creates them stays untouched). Games already in progress and
--     games with friends keep their own timer.
--   · the daily has the artist / style questions: the 45 seconds are for
--     placing AND the questions together, so the question window now closes
--     45 s after the card was shown (not 20 s after placing).
--   · speed points keep 1000 - 500 x (time / time allowed), so they scale.

create or replace function public._games_timer_default() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'async' then
    new.timed := false;
    new.answer_seconds := _untimed_seconds('async');
  elsif new.kind in ('daily', 'run') then
    new.answer_seconds := 45;
  end if;
  return new;
end $$;

-- pick_bonus() from 018: the daily's question window is the card's whole 45 s
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
     or (g.kind = 'daily' and g.timed and _now() > a.shown_at + make_interval(secs => g.answer_seconds) + _grace())
     or (g.kind not in ('live', 'daily') and g.timed and _now() > a.answered_at + interval '20 seconds') then
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
