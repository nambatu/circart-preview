-- ============================================================================
-- CIRCArt — the game engine: live rooms and async games
--
-- One rule set for every competitive mode (live, async, and the daily
-- challenge in 003):
--   * Shared timeline. Everyone places the same card into the same timeline.
--     Once a card is played it joins the timeline at its correct spot for
--     everyone, right or wrong, so every player always faces the same question.
--   * Server-timed answers. The clock starts when the server hands out the
--     card (live: when the round starts) and the server alone measures it.
--     20 s per card plus 2 s for network lag.
--   * Scoring. Correct = 1000 points for an instant answer, down to 500 at the
--     limit. Streak bonus +50 per card in a row (from the 2nd, capped at +200).
--     Artist bonus +200: after placing, pick the artist from 4 names.
--     Wrong or too slow = 0, and the streak resets.
--
-- Cards are dealt in turns:
--   live   1 card per turn, 20 s, then an 8 s reveal for everyone
--   async  3 cards per turn, 24 h to play them, turn closes early when all
--          players are done; two missed turns in a row drop the player
--   daily  (003) all 10 cards in one turn that lasts the whole day
--
-- Nothing in here waits on a timer. Every call first runs _tick(), which
-- moves the game forward if a deadline has passed. A scheduled job
-- (close_expired_games, see README) does the same for games nobody opens.
-- ============================================================================

-- Server time. Tests can move the clock; real API calls (session user
-- "authenticator") always get the true time.
create function public._now() returns timestamptz
language sql stable as $$
  select case when session_user <> 'authenticator'
               and coalesce(current_setting('circart.test_now', true), '') <> ''
              then current_setting('circart.test_now', true)::timestamptz
              else now() end
$$;

-- ─── tables ─────────────────────────────────────────────────────────────────

create table public.games (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('live','async','daily')),
  code             text,                                  -- join code (live/async)
  host_id          uuid references public.profiles(id) on delete set null,
  status           text not null default 'lobby'
                     check (status in ('lobby','playing','finished','cancelled')),
  card_count       int  not null check (card_count between 3 and 30),
  cards_per_turn   int  not null check (cards_per_turn >= 1),
  answer_seconds   int  not null default 20,
  turn_hours       int,                                   -- async only
  reveal_seconds   int  not null default 8,               -- live only
  max_players      int  not null,
  challenge_date   date unique,                           -- daily only (003)
  current_turn     int  not null default 0,
  turn_started_at  timestamptz,
  turn_deadline    timestamptz,
  turn_closed_at   timestamptz,                           -- set when a turn closes
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  updated_at       timestamptz not null default now(),
  check (card_count % cards_per_turn = 0)
);
create unique index games_active_code on public.games (code) where status in ('lobby','playing');
create index games_due on public.games (turn_deadline) where status = 'playing';

-- position 0 is the face-up starting card
create table public.game_cards (
  game_id         uuid not null references public.games(id) on delete cascade,
  position        int  not null,
  card_id         text not null references public.cards(id),
  artist_options  text[] not null default '{}',           -- 4 names, shuffled
  primary key (game_id, position)
);

create table public.game_players (
  game_id         uuid not null references public.games(id) on delete cascade,
  player_id       uuid not null references public.profiles(id) on delete cascade,
  display_name    text not null,
  joined_at       timestamptz not null default now(),
  score           int  not null default 0,
  answered        int  not null default 0,                -- cards finished (incl. timeouts)
  correct         int  not null default 0,
  artists_named   int  not null default 0,
  streak          int  not null default 0,
  best_streak     int  not null default 0,
  total_ms        bigint not null default 0,              -- tie-breaker: faster wins
  missed_turns    int  not null default 0,                -- async: in a row
  dropped         boolean not null default false,
  final_rank      int,
  primary key (game_id, player_id)
);
create index game_players_player_idx on public.game_players (player_id);

create table public.answers (
  game_id         uuid not null references public.games(id) on delete cascade,
  player_id       uuid not null references public.profiles(id) on delete cascade,
  position        int  not null,
  shown_at        timestamptz,                            -- when the clock started
  answered_at     timestamptz,
  slot            int,                                    -- gap chosen: 0 = before everything
  correct         boolean not null default false,
  ms              int,
  timed_out       boolean not null default false,
  artist_choice   text,
  artist_correct  boolean not null default false,
  artist_done     boolean not null default false,         -- picked, skipped or forfeited
  points          int not null default 0,
  primary key (game_id, player_id, position)
);
create index answers_position_idx on public.answers (game_id, position);

-- ─── access ─────────────────────────────────────────────────────────────────
-- Members may read their game's row and player list (the app subscribes to
-- these for live updates). Answers and dealt cards stay server-only.

alter table public.games        enable row level security;
alter table public.game_cards   enable row level security;
alter table public.game_players enable row level security;
alter table public.answers      enable row level security;
revoke all on public.games, public.game_cards, public.game_players, public.answers from anon, authenticated;

create function public._is_member(p_game uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from game_players where game_id = p_game and player_id = auth.uid())
$$;

-- nothing secret in these two tables: no cards, no answers
grant select on public.games, public.game_players to authenticated;
create policy "members see their game"   on public.games        for select to authenticated using (_is_member(id));
create policy "members see the players"  on public.game_players for select to authenticated using (_is_member(game_id));

-- ─── helpers ────────────────────────────────────────────────────────────────

create function public._grace() returns interval language sql immutable as $$ select interval '2 seconds' $$;

create function public._turn_of(g public.games, p_position int) returns int
language sql immutable as $$ select (p_position - 1) / g.cards_per_turn + 1 $$;

create function public._new_code() returns text
language plpgsql volatile set search_path = public as $$
declare c text;
begin
  loop   -- 4 characters, no 0/O/1/I/L
    c := (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
          from generate_series(1, 4));
    exit when not exists (select 1 from games where code = c and status in ('lobby','playing'));
  end loop;
  return c;
end $$;

-- Cards these players have met recently (solo or online), to deal fresh ones.
create function public._recent_cards(p_players uuid[], p_days int) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct card_id), '{}') from (
    select gc.card_id from solo_game_cards gc join solo_games g on g.id = gc.game_id
     where g.player_id = any(p_players) and g.finished_at > now() - make_interval(days => p_days)
    union
    select gc.card_id from answers a join game_cards gc on gc.game_id = a.game_id and gc.position = a.position
     where a.player_id = any(p_players) and a.shown_at > now() - make_interval(days => p_days)
  ) s
$$;

-- The real artist plus three others who worked around the same time, shuffled.
create function public._artist_options(c public.cards) returns text[]
language sql volatile set search_path = public as $$
  select array_agg(name order by random()) from (
    select c.artist as name
    union all
    (select artist from (select artist, min(abs(year - c.year)) as dist
                           from cards where active and artist <> c.artist group by artist) s
      order by (dist > 150), random() limit 3)
  ) t
$$;

-- Deal like dealer.py: a familiar start card from 1600–1950, obscure cards
-- early and icons late, no artist twice within 3 cards, no back-to-back decade,
-- avoiding cards the players have seen. p_filter narrows the deck for themed
-- months: {"year_min": 1600, "year_max": 1700, "movements": ["Baroque"]}.
create function public._deal(p_game uuid, p_avoid text[], p_filter jsonb default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  g         games;
  t         float;
  r         float;
  want      int;
  pick      cards;
  chosen    text[] := '{}';
  recent    text[] := '{}';
  last_dec  int;
  f         jsonb := coalesce(p_filter, '{}');
begin
  select * into g from games where id = p_game;
  delete from game_cards where game_id = p_game;

  create temp table if not exists _pool (like cards) on commit drop;
  truncate _pool;
  insert into _pool select * from cards c
   where c.active
     and (f->>'year_min' is null or c.year >= (f->>'year_min')::int)
     and (f->>'year_max' is null or c.year <= (f->>'year_max')::int)
     and (f->'movements' is null or c.movement = any(array(select jsonb_array_elements_text(f->'movements'))));
  if (select count(*) from _pool) < g.card_count + 1 then
    truncate _pool;                                   -- theme too narrow: use the whole deck
    insert into _pool select * from cards where active;
  end if;

  select * into pick from _pool c
   order by (c.tier = 3 or c.year not between 1600 and 1950), (c.id = any(p_avoid)), random() limit 1;
  if pick.id is null then raise exception 'deck_too_small'; end if;
  insert into game_cards (game_id, position, card_id) values (p_game, 0, pick.id);
  chosen := array[pick.id]; recent := array[pick.artist]; last_dec := pick.year / 10;

  for i in 1..g.card_count loop
    t := (i - 1)::float / greatest(g.card_count - 1, 1);
    r := random();
    want := case when r < 0.45 - 0.45 * t then 3 when r < 0.90 - 0.45 * t then 2 else 1 end;
    pick := null;
    select * into pick from _pool c
     where not (c.id = any(chosen))
     order by (c.artist = any(recent)), (c.tier <> want), (c.id = any(p_avoid)),
              (c.year / 10 = last_dec), random()
     limit 1;
    if pick.id is null then raise exception 'deck_too_small'; end if;
    insert into game_cards (game_id, position, card_id, artist_options)
    values (p_game, i, pick.id, _artist_options(pick));
    chosen := chosen || pick.id;
    recent := (array[pick.artist] || recent)[1:3];
    last_dec := pick.year / 10;
  end loop;
end $$;

-- Years on the shared timeline just before card p_position is played.
create function public._years_before(p_game uuid, p_position int) returns int[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.year order by c.year), '{}')
  from game_cards gc join cards c on c.id = gc.card_id
  where gc.game_id = p_game and gc.position < p_position
$$;

-- Is this answer finished? (live also waits for the artist pick)
create function public._is_done(a public.answers, g public.games) returns boolean
language sql immutable as $$
  select a.timed_out or (a.answered_at is not null and (g.kind <> 'live' or a.artist_done))
$$;

create function public._recount(p_game uuid, p_player uuid) returns void
language sql security definer set search_path = public as $$
  update game_players set answered = (select count(*) from answers
                                      where game_id = p_game and player_id = p_player
                                        and (answered_at is not null or timed_out))
  where game_id = p_game and player_id = p_player
$$;

-- ─── turn lifecycle ─────────────────────────────────────────────────────────

create function public._open_turn(p_game uuid, p_turn int) returns void
language sql security definer set search_path = public as $$
  update games set
    current_turn    = p_turn,
    turn_started_at = _now(),
    turn_closed_at  = null,
    turn_deadline   = case kind
                        when 'live'  then _now() + make_interval(secs => answer_seconds) + _grace()
                        when 'async' then _now() + make_interval(hours => turn_hours)
                        else turn_deadline end,
    updated_at      = _now()
  where id = p_game
$$;

create function public._finish(p_game uuid) returns void
language sql security definer set search_path = public as $$
  update games set status = 'finished', finished_at = _now(), updated_at = _now(),
                   turn_closed_at = coalesce(turn_closed_at, _now())
   where id = p_game;
  update game_players gp set final_rank = r.rk
    from (select player_id, rank() over (order by score desc, total_ms) rk
            from game_players where game_id = p_game) r
   where gp.game_id = p_game and gp.player_id = r.player_id;
$$;

-- Close the current turn: unfinished cards become timeouts (0 points, streak
-- reset); async players who played nothing this turn get a strike.
create function public._close_turn(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g  games;
  t0 int;
  t1 int;
begin
  select * into g from games where id = p_game;
  t0 := (g.current_turn - 1) * g.cards_per_turn + 1;
  t1 := g.current_turn * g.cards_per_turn;

  with late as (
    insert into answers (game_id, player_id, position, timed_out, artist_done)
    select g.id, gp.player_id, p, true, true
      from game_players gp cross join generate_series(t0, t1) p
     where gp.game_id = g.id and not gp.dropped
    on conflict (game_id, player_id, position) do update
      set timed_out = true, artist_done = true
      where answers.answered_at is null and not answers.timed_out
    returning player_id
  )
  update game_players set streak = 0
   where game_id = g.id and player_id in (select player_id from late);

  -- live: an answer whose artist pick never came is simply done now
  update answers set artist_done = true
   where game_id = g.id and position between t0 and t1 and not artist_done;

  update game_players gp set answered = (select count(*) from answers a
                                          where a.game_id = g.id and a.player_id = gp.player_id
                                            and (a.answered_at is not null or a.timed_out))
   where gp.game_id = g.id;

  if g.kind = 'async' then
    update game_players gp
       set missed_turns = case when exists (select 1 from answers a
                                             where a.game_id = g.id and a.player_id = gp.player_id
                                               and a.position between t0 and t1 and a.answered_at is not null)
                               then 0 else gp.missed_turns + 1 end
     where gp.game_id = g.id and not gp.dropped;
    update game_players set dropped = true where game_id = g.id and missed_turns >= 2;
  end if;

  update games set turn_closed_at = _now(), updated_at = _now() where id = g.id;
end $$;

-- Move the game forward if anything is due. Safe to call any time.
create function public._tick(p_game uuid) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  g      games;
  turns  int;
  active int;
  done   int;
  t0     int;
  t1     int;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or g.status <> 'playing' then return g; end if;
  turns := g.card_count / g.cards_per_turn;

  if g.kind = 'daily' then
    if _now() > g.turn_deadline then perform _finish(g.id); end if;
    select * into g from games where id = p_game;
    return g;
  end if;

  -- async needs at least two players still in it
  if g.kind = 'async' and (select count(*) from game_players where game_id = g.id and not dropped) < 2 then
    if g.turn_closed_at is null then perform _close_turn(g.id); end if;
    perform _finish(g.id);
    select * into g from games where id = p_game;
    return g;
  end if;

  if g.turn_closed_at is null then
    t0 := (g.current_turn - 1) * g.cards_per_turn + 1;
    t1 := g.current_turn * g.cards_per_turn;
    select count(*) into active from game_players where game_id = g.id and not dropped;
    select count(*) into done
      from answers a join game_players gp on gp.game_id = a.game_id and gp.player_id = a.player_id
     where a.game_id = g.id and not gp.dropped and a.position between t0 and t1 and _is_done(a, g);
    if _now() <= g.turn_deadline and done < active * g.cards_per_turn then
      return g;                                       -- still playing this turn
    end if;
    perform _close_turn(g.id);
    select * into g from games where id = p_game;
  end if;

  -- after a turn: live pauses for the reveal, async moves on at once
  if g.kind = 'live' and _now() < g.turn_closed_at + make_interval(secs => g.reveal_seconds) then
    return g;
  end if;
  select count(*) into active from game_players where game_id = g.id and not dropped;
  if g.current_turn >= turns or (g.kind = 'async' and active < 2) then
    perform _finish(g.id);
  else
    perform _open_turn(g.id, g.current_turn + 1);
  end if;
  select * into g from games where id = p_game;
  return g;
end $$;

-- For the scheduled job: move every game whose deadline has passed.
create function public.close_expired_games() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; gid uuid;
begin
  for gid in select id from games
              where status = 'playing'
                and (turn_deadline < _now()
                     or (kind = 'live' and turn_closed_at is not null))
  loop
    perform _tick(gid);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ─── lobby ──────────────────────────────────────────────────────────────────

create function public._set_display_name(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); n text := nullif(trim(p_name), '');
begin
  if n is not null then
    if char_length(n) > 24 then raise exception 'display_name_invalid'; end if;
    update profiles set display_name = n where id = me;
  end if;
  return (select display_name from profiles where id = me);
end $$;

-- p_kind 'live' (10 cards, 1 per round) or 'async' (12 cards, 3 per turn, 24 h)
create function public.create_game(
  p_kind text, p_card_count int default null, p_cards_per_turn int default null,
  p_display_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := _me();
  name  text := _set_display_name(p_display_name);
  g     games;
begin
  if p_kind not in ('live', 'async') then raise exception 'bad_settings'; end if;
  insert into games (kind, code, host_id, card_count, cards_per_turn, turn_hours, max_players)
  values (p_kind, _new_code(), me,
          coalesce(p_card_count, case p_kind when 'live' then 10 else 12 end),
          case p_kind when 'live' then 1 else coalesce(p_cards_per_turn, 3) end,
          case p_kind when 'async' then 24 end,
          case p_kind when 'live' then 20 else 8 end)
  returning * into g;
  insert into game_players (game_id, player_id, display_name) values (g.id, me, name);
  return jsonb_build_object('id', g.id, 'code', g.code);
exception when check_violation then
  raise exception 'bad_settings';
end $$;

create function public.join_game(p_code text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := _me();
  name  text := _set_display_name(p_display_name);
  g     games;
begin
  select * into g from games where code = upper(trim(p_code)) and status in ('lobby','playing') for update;
  if g.id is null then raise exception 'game_not_found'; end if;
  if exists (select 1 from game_players where game_id = g.id and player_id = me) then return g.id; end if;
  if g.status <> 'lobby' then raise exception 'game_started'; end if;
  if (select count(*) from game_players where game_id = g.id) >= g.max_players then raise exception 'game_full'; end if;
  insert into game_players (game_id, player_id, display_name) values (g.id, me, name);
  update games set updated_at = _now() where id = g.id;
  return g.id;
end $$;

create function public.leave_game(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); g games;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or not exists (select 1 from game_players where game_id = g.id and player_id = me) then
    raise exception 'game_not_found';
  end if;
  if g.status = 'lobby' then
    delete from game_players where game_id = g.id and player_id = me;
    if g.host_id = me then
      update games set host_id = (select player_id from game_players where game_id = g.id order by joined_at limit 1)
       where id = g.id;
      update games set status = 'cancelled' where id = g.id and host_id is null;
    end if;
  else
    update game_players set dropped = true where game_id = g.id and player_id = me;
  end if;
  update games set updated_at = _now() where id = g.id;
  perform _tick(g.id);
end $$;

create function public.start_game(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); g games;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or g.host_id is distinct from me then raise exception 'not_host'; end if;
  if g.status <> 'lobby' then raise exception 'game_started'; end if;
  if (select count(*) from game_players where game_id = g.id) < 2 then raise exception 'need_two_players'; end if;
  perform _deal(g.id, _recent_cards(array(select player_id from game_players where game_id = g.id), 30));
  update games set status = 'playing', started_at = _now() where id = g.id;
  perform _open_turn(g.id, 1);
end $$;

-- ─── playing ────────────────────────────────────────────────────────────────

-- The next card for me: only the image (and the title for works without one).
-- Starts my clock (live: the round's clock).
create function public.next_card(p_game uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   uuid := _me();
  g    games := _tick(p_game);
  gp   game_players;
  pos  int;
  a    answers;
  t0   int;
  t1   int;
  c    cards;
begin
  select * into gp from game_players where game_id = p_game and player_id = me;
  if g.id is null or gp.player_id is null then raise exception 'game_not_found'; end if;
  if g.status = 'lobby'    then return jsonb_build_object('wait', 'lobby'); end if;
  if g.status <> 'playing' then return jsonb_build_object('wait', 'finished'); end if;
  if gp.dropped            then return jsonb_build_object('wait', 'dropped'); end if;
  if g.kind = 'live' and g.turn_closed_at is not null then
    return jsonb_build_object('wait', 'reveal',
      'next_at', g.turn_closed_at + make_interval(secs => g.reveal_seconds), 'server_now', _now());
  end if;

  t0 := case when g.kind = 'daily' then 1 else (g.current_turn - 1) * g.cards_per_turn + 1 end;
  t1 := case when g.kind = 'daily' then g.card_count else g.current_turn * g.cards_per_turn end;

  -- moving on forfeits an open artist pick (async/daily)
  update answers set artist_done = true
   where game_id = g.id and player_id = me and answered_at is not null and not artist_done and g.kind <> 'live';

  loop
    select min(p) into pos from generate_series(t0, t1) p
     where not exists (select 1 from answers x where x.game_id = g.id and x.player_id = me
                         and x.position = p and (x.answered_at is not null or x.timed_out));
    if pos is null then
      return jsonb_build_object('wait', 'turn_done', 'deadline', g.turn_deadline, 'server_now', _now());
    end if;
    select * into a from answers where game_id = g.id and player_id = me and position = pos;
    exit when a.player_id is null
           or _now() <= a.shown_at + make_interval(secs => g.answer_seconds) + _grace();
    -- the card was shown and the time ran out (app closed, reloaded...)
    update answers set timed_out = true, artist_done = true
     where game_id = g.id and player_id = me and position = pos;
    update game_players set streak = 0 where game_id = g.id and player_id = me;
    perform _recount(g.id, me);
  end loop;

  if a.player_id is null then
    insert into answers (game_id, player_id, position, shown_at)
    values (g.id, me, pos, case when g.kind = 'live' then g.turn_started_at else _now() end)
    returning * into a;
  end if;

  select c2.* into c from game_cards gc join cards c2 on c2.id = gc.card_id
   where gc.game_id = g.id and gc.position = pos;
  return jsonb_build_object(
    'position', pos, 'card_count', g.card_count,
    'image_url', c.image_url, 'visual_type', c.visual_type,
    'title', case when c.image_url is null then c.title end,
    'seconds', g.answer_seconds,
    'ends_at', a.shown_at + make_interval(secs => g.answer_seconds),
    'server_now', _now());
end $$;

-- Place the open card into gap p_slot of the shared timeline
-- (0 = before the first card, n = after the last).
create function public.answer(p_game uuid, p_position int, p_slot int) returns jsonb
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
  select artist_options into opts from game_cards where game_id = p_game and position = p_position;

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
    'correct', case when g.kind <> 'live' then (not late and ok) end,
    'points',  case when g.kind <> 'live' then pts end,
    'streak',  case when g.kind <> 'live' and not late then v_streak end));
end $$;

-- Second step after placing: pick the artist (or pass null to skip).
-- Live: before the round closes. Async/daily: within 15 s of placing.
create function public.pick_artist(p_game uuid, p_position int, p_choice text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := _me();
  g     games;
  a     answers;
  opts  text[];
  v_real text;
  ok    boolean := false;
begin
  select * into g from games where id = p_game for update;
  select * into a from answers where game_id = p_game and player_id = me and position = p_position for update;
  if g.id is null or a.player_id is null or a.answered_at is null then raise exception 'not_answered'; end if;
  if a.artist_done then raise exception 'artist_closed'; end if;
  if (g.kind = 'live' and (g.turn_closed_at is not null or _turn_of(g, p_position) <> g.current_turn))
     or (g.kind <> 'live' and _now() > a.answered_at + interval '15 seconds') then
    update answers set artist_done = true where game_id = p_game and player_id = me and position = p_position;
    raise exception 'artist_closed';
  end if;

  select gc.artist_options, c.artist into opts, v_real
    from game_cards gc join cards c on c.id = gc.card_id where gc.game_id = p_game and gc.position = p_position;
  if p_choice is not null and not (p_choice = any(opts)) then raise exception 'bad_choice'; end if;
  ok := p_choice is not null and p_choice = v_real;

  update answers set artist_choice = p_choice, artist_correct = ok, artist_done = true,
                     points = points + case when ok then 200 else 0 end
   where game_id = p_game and player_id = me and position = p_position;
  if ok then
    update game_players set score = score + 200, artists_named = artists_named + 1
     where game_id = p_game and player_id = me;
  end if;
  update games set updated_at = _now() where id = p_game;
  perform _tick(p_game);
  return case when g.kind = 'live' then '{}'::jsonb else jsonb_build_object('artist_correct', ok) end;
end $$;

-- Everything about a played card: the answer, my result, and (once the turn
-- has closed, or straight away in the daily) where everyone put it.
create function public.reveal(p_game uuid, p_position int) returns jsonb
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
                               'location', c.location, 'date_note', c.date_note, 'trivia', c.trivia),
    'correct_slot', (select count(*) from unnest(years) y where y < c.year),
    'timeline_years', to_jsonb(years),
    'mine', jsonb_build_object('slot', a.slot, 'correct', a.correct, 'timed_out', a.timed_out,
                               'ms', a.ms, 'points', a.points, 'artist_choice', a.artist_choice,
                               'artist_correct', a.artist_correct),
    'distribution', dist));
end $$;

-- One call for the whole game screen.
create function public.get_game(p_game uuid) returns jsonb
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
                        and x.position = gc.position and (x.answered_at is not null or x.timed_out)
                        and (g.kind <> 'live' or g.status = 'finished'
                             or _turn_of(g, gc.position) < g.current_turn or g.turn_closed_at is not null)))));
end $$;

-- Home screen list: my live/async games, "your turn" first.
create function public.my_games() returns jsonb
language sql security definer set search_path = public as $$
  with mine as (
    select g.*, gp.score as my_score, gp.final_rank as my_rank, gp.dropped as my_dropped,
           (g.kind = 'async' and g.status = 'playing' and not gp.dropped and exists (
              select 1 from generate_series((g.current_turn - 1) * g.cards_per_turn + 1,
                                            g.current_turn * g.cards_per_turn) p
               where not exists (select 1 from answers x where x.game_id = g.id and x.player_id = _me()
                                   and x.position = p and (x.answered_at is not null or x.timed_out)))) as my_turn
      from games g join game_players gp on gp.game_id = g.id and gp.player_id = _me()
     where g.kind in ('live','async')
       and (g.status in ('lobby','playing') or g.finished_at > now() - interval '7 days')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'kind', kind, 'code', code, 'status', status, 'my_turn', my_turn,
           'turn', current_turn, 'turns', card_count / cards_per_turn, 'turn_deadline', turn_deadline,
           'my_score', my_score, 'my_rank', my_rank, 'dropped', my_dropped,
           'others', (select coalesce(jsonb_agg(display_name order by joined_at), '[]')
                        from game_players where game_id = mine.id and player_id <> _me()))
         order by my_turn desc, status = 'finished', turn_deadline nulls last), '[]')
  from mine
$$;

-- ─── permissions ────────────────────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  -- from 001
  public.get_my_profile(), public.update_profile(text, text),
  public.username_available(text), public.delete_my_account(),
  public.submit_solo_game(jsonb), public.recently_seen_cards(int), public.my_solo_stats(),
  public.submit_feedback(text, text, text, jsonb),
  -- games
  public.create_game(text, int, int, text), public.join_game(text, text),
  public.leave_game(uuid), public.start_game(uuid),
  public.next_card(uuid), public.answer(uuid, int, int), public.pick_artist(uuid, int, text),
  public.reveal(uuid, int), public.get_game(uuid), public.my_games(),
  public._is_member(uuid)           -- used by the read policies
to authenticated;
grant execute on function public.submit_feedback(text, text, text, jsonb) to anon;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.games, public.game_players;
  end if;
end $$;
