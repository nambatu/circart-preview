-- CIRCArt 007 — second bonus question: "Which movement?" (+100).
--
-- The deck's ~70 movement labels are too fine for a quiz ("Sienese School",
-- "Blue Period"), so they map onto ~30 well-known movements (movement_groups).
-- Wrong answers are random movements from the same broad period, so it's a real question.
-- Cards whose label fits no clear movement (photography, "Contemporary", …)
-- get no movement question. Unknown future labels: none either, until mapped.
--
-- The host can switch it off like the artist bonus (set_game_options).
-- After placing, the app shows both questions; pick_bonus answers them in one go.

create table public.movement_groups (
  movement text primary key,       -- label as it appears in cards.movement
  grp      text not null,          -- what the player sees
  ord      int  not null           -- rough chronological order (for near-in-time wrong answers)
);
alter table public.movement_groups enable row level security;
revoke all on public.movement_groups from anon, authenticated;
insert into public.movement_groups (movement, grp, ord) values
  ('Proto-Renaissance', 'Gothic', 1),
  ('Sienese School', 'Gothic', 1),
  ('International Gothic', 'Gothic', 1),
  ('Early Renaissance', 'Renaissance', 2),
  ('High Renaissance', 'Renaissance', 2),
  ('Venetian Renaissance', 'Renaissance', 2),
  ('Northern Renaissance', 'Northern Renaissance', 3),
  ('Mannerism', 'Mannerism', 4),
  ('Baroque', 'Baroque', 5),
  ('Baroque Classicism', 'Baroque', 5),
  ('Dutch Golden Age', 'Dutch Golden Age', 6),
  ('Rococo', 'Rococo', 7),
  ('Vedutismo', 'Rococo', 7),
  ('Neoclassicism', 'Neoclassicism', 8),
  ('Enlightenment', 'Neoclassicism', 8),
  ('Romanticism', 'Romanticism', 9),
  ('Biedermeier', 'Romanticism', 9),
  ('Ukiyo-e', 'Ukiyo-e', 10),
  ('Pre-Raphaelite', 'Pre-Raphaelites', 11),
  ('Realism', 'Realism', 12),
  ('Academic art', 'Realism', 12),
  ('Impressionism', 'Impressionism', 13),
  ('Post-Impressionism', 'Post-Impressionism', 14),
  ('Neo-Impressionism', 'Post-Impressionism', 14),
  ('Naive art', 'Post-Impressionism', 14),
  ('Symbolism', 'Symbolism', 15),
  ('Art Nouveau', 'Art Nouveau', 16),
  ('Fauvism', 'Fauvism', 17),
  ('Expressionism', 'Expressionism', 18),
  ('Blue Period', 'Expressionism', 18),
  ('New Objectivity', 'Expressionism', 18),
  ('Proto-Cubism', 'Cubism', 19),
  ('Analytic Cubism', 'Cubism', 19),
  ('Cubism', 'Cubism', 19),
  ('Futurism', 'Futurism', 20),
  ('Abstract art', 'Abstract art', 21),
  ('Suprematism', 'Abstract art', 21),
  ('De Stijl', 'Abstract art', 21),
  ('Bauhaus', 'Abstract art', 21),
  ('Modernism', 'Abstract art', 21),
  ('Dada', 'Dada', 22),
  ('Art Deco', 'Art Deco', 23),
  ('Surrealism', 'Surrealism', 24),
  ('Magic Realism', 'Surrealism', 24),
  ('American Realism', 'American Realism', 25),
  ('Regionalism', 'American Realism', 25),
  ('American Modernism', 'American Realism', 25),
  ('American Illustration', 'American Realism', 25),
  ('Abstract Expressionism', 'Abstract Expressionism', 26),
  ('Op art', 'Op art', 27),
  ('Pop art', 'Pop art', 28),
  ('Neo-Dada', 'Pop art', 28),
  ('Nouveau Realisme', 'Pop art', 28),
  ('Neo-Pop', 'Pop art', 28),
  ('Neo-expressionism', 'Neo-Expressionism', 29),
  ('Photorealism', 'Photorealism', 30),
  ('Street art', 'Street art', 31),
  ('Conceptual art', 'Conceptual art', 32),
  ('Installation art', 'Conceptual art', 32),
  ('Young British Artists', 'Conceptual art', 32);

alter table public.games       add column movement_bonus boolean not null default true;
alter table public.game_cards  add column movement_options text[] not null default '{}';
alter table public.answers     add column movement_choice text,
                               add column movement_correct boolean not null default false;
alter table public.game_players add column movements_named int not null default 0;

create function public._movement_group(p_movement text) returns text
language sql stable security definer set search_path = public as $$
  select grp from movement_groups where movement = p_movement
$$;

-- the right movement plus 3 others from the nearest few in time, shuffled
create function public._movement_options(p_movement text) returns text[]
language sql volatile security definer set search_path = public as $$
  with me as (select grp, ord from movement_groups where movement = p_movement limit 1),
  g as (select distinct grp, ord from movement_groups),
  -- 3 random movements from within 5 places in time (either side), so the
  -- right answer isn't simply "the one in the middle"
  wrong as (select g.grp from g, me where g.grp <> me.grp
             order by (abs(g.ord - me.ord) <= 5) desc, random() limit 3)
  select case when (select grp from me) is null then '{}'::text[]
              else (select array_agg(x order by random()) from
                     (select grp x from me union all select grp from wrong) s) end
$$;

create function public._add_movement_options() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select movement_bonus from games where id = new.game_id) then
    new.movement_options := _movement_options((select movement from cards where id = new.card_id));
  end if;
  return new;
end $$;
create trigger game_cards_movement_option before insert on public.game_cards
  for each row execute function public._add_movement_options();

-- an answer with no bonus questions to ask is "bonus done" straight away
create or replace function public._no_artist_answer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.answered_at is not null or new.timed_out) and not new.artist_done
     and (select cardinality(artist_options) = 0 and cardinality(movement_options) = 0
            from game_cards where game_id = new.game_id and position = new.position) then
    new.artist_done := true;
  end if;
  return new;
end $$;

-- Both bonus answers at once (either may be null = skipped). Live: until the
-- round closes. Async/daily: 20 s after placing (two questions, so 5 s more
-- than the old artist-only pick_artist).
create function public.pick_bonus(p_game uuid, p_position int, p_artist text, p_movement text) returns jsonb
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
     or (g.kind <> 'live' and _now() > a.answered_at + interval '20 seconds') then
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

-- options: both switches
drop function public.set_game_options(uuid, boolean);
create or replace function public.set_game_options(p_game uuid, p_artist_bonus boolean default null, p_movement_bonus boolean default null)
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
                   movement_bonus = coalesce(p_movement_bonus, movement_bonus), updated_at = _now()
   where id = g.id returning * into g;
  return jsonb_build_object('artist_bonus', g.artist_bonus, 'movement_bonus', g.movement_bonus);
end $$;

create or replace function public.game_options(p_game uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g games;
begin
  select * into g from games where id = p_game;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = _me()) then
    raise exception 'game_not_found';
  end if;
  return jsonb_build_object('artist_bonus', g.artist_bonus, 'movement_bonus', g.movement_bonus);
end $$;

create or replace function public._rematch_keeps_options() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rematch_id is distinct from old.rematch_id and new.rematch_id is not null then
    update games set artist_bonus = new.artist_bonus, movement_bonus = new.movement_bonus
     where id = new.rematch_id and status = 'lobby';
  end if;
  return null;
end $$;

-- get_game() from 002: a placed card joins your timeline only once its bonus
-- questions are closed (else its artist would be visible while you answer).
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
    'me', jsonb_build_object('score', gp.score, 'correct', gp.correct, 'answered', gp.answered,
                             'streak', gp.streak, 'best_streak', gp.best_streak,
                             'rank', gp.final_rank, 'missed_turns', gp.missed_turns),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', p.display_name, 'score', p.score, 'is_me', p.player_id = me,
                  'is_host', p.player_id = g.host_id, 'dropped', p.dropped, 'rank', p.final_rank,
                  'done_this_turn', g.status = 'playing' and not exists (
                      select 1 from generate_series(t0, t1) q
                       where not exists (select 1 from answers x where x.game_id = g.id
                                           and x.player_id = p.player_id and x.position = q
                                           and (x.answered_at is not null or x.timed_out))))
                  order by p.score desc, p.total_ms, p.joined_at), '[]')
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

-- answer() and reveal() from 002, now also with the movement question

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
    if ok then
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

create or replace function public.reveal(p_game uuid, p_position int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  g      games := _tick(p_game);
  a      answers;
  c      cards;
  years  int[];
  closed boolean;
  dist   jsonb;
begin
  select * into a from answers where game_id = p_game and player_id = me and position = p_position;
  if g.id is null or a.player_id is null or (a.answered_at is null and not a.timed_out) then
    raise exception 'not_answered';
  end if;
  closed := g.status = 'finished'
         or _turn_of(g, p_position) < g.current_turn
         or g.turn_closed_at is not null;
  if g.kind = 'live' and not closed then raise exception 'not_yet'; end if;
  if not a.artist_done then
    update answers set artist_done = true where game_id = p_game and player_id = me and position = p_position;
  end if;

  select c2.* into c from game_cards gc join cards c2 on c2.id = gc.card_id
   where gc.game_id = p_game and gc.position = p_position;
  years := _years_before(p_game, p_position);

  if closed or g.kind = 'daily' then
    select coalesce(jsonb_object_agg(slot, n), '{}') into dist
      from (select slot, count(*) n from answers
             where game_id = p_game and position = p_position and slot is not null group by slot) s;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'position', p_position,
    'card', jsonb_build_object('title', c.title, 'artist', c.artist, 'year', c.year,
                               'image_url', c.image_url, 'movement', c.movement, 'medium', c.medium,
                               'location', c.location, 'date_note', c.date_note, 'trivia', c.trivia,
                               'movement_group', _movement_group(c.movement)),
    'correct_slot', (select count(*) from unnest(years) y where y < c.year),
    'timeline_years', to_jsonb(years),
    'mine', jsonb_build_object('slot', a.slot, 'correct', a.correct, 'timed_out', a.timed_out,
                               'ms', a.ms, 'points', a.points, 'artist_choice', a.artist_choice,
                               'artist_correct', a.artist_correct,
                               'movement_choice', a.movement_choice, 'movement_correct', a.movement_correct),
    'distribution', dist));
end $$;

revoke execute on function public._movement_group(text), public._movement_options(text), public._add_movement_options(),
  public.pick_bonus(uuid, int, text, text), public.set_game_options(uuid, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.pick_bonus(uuid, int, text, text), public.set_game_options(uuid, boolean, boolean)
  to authenticated;
