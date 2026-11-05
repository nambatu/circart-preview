-- CIRCArt 009 — the Monthly Run: unlimited tries, 3 lives, best run counts.
--
-- A run is a one-player game (kind 'run') dealt from this month's theme
-- (monthly_challenges.deck_filter). Cards come one after another with the
-- usual 20 s clock, speed points, streak bonus and bonus questions. Every
-- wrong or timed-out card costs a life; the third ends the run (so does
-- running out of cards). The monthly board shows each player's best run.
--
-- The daily no longer uses the month's theme (it always uses the whole deck).
-- All-time points: daily + games with friends + your best run of each month
-- (not every run, or endless replays would decide the all-time board).

alter table public.games drop constraint games_kind_check;
alter table public.games add constraint games_kind_check check (kind in ('live', 'async', 'daily', 'run'));
alter table public.games drop constraint games_card_count_check;
alter table public.games add constraint games_card_count_check check (card_count between 3 and 80);
alter table public.games add column run_month date;
create index games_runs on public.games (run_month) where kind = 'run';

-- this month and the next ones (never overwrites a month set by hand)
insert into public.monthly_challenges (month, title, description, metric, deck_filter) values
  ('2026-11-01', 'Masterpieces Marathon', 'All of art history. Unlimited runs, 3 lives, your best run counts.', 'daily_best20', null),
  ('2026-12-01', 'Baroque & Golden Age', 'Caravaggio to Canaletto, 1580–1800. Unlimited runs, 3 lives, your best run counts.', 'daily_best20', '{"year_min":1580,"year_max":1800}'),
  ('2027-01-01', 'The Modern Break', 'From Impressionism to Surrealism, 1860–1945. Unlimited runs, 3 lives, your best run counts.', 'daily_best20', '{"year_min":1860,"year_max":1945}'),
  ('2027-02-01', 'Renaissance', 'Giotto to the late Renaissance, 1300–1600. Unlimited runs, 3 lives, your best run counts.', 'daily_best20', '{"year_min":1300,"year_max":1600}'),
  ('2027-03-01', 'After 1945', 'Pollock to Banksy. Unlimited runs, 3 lives, your best run counts.', 'daily_best20', '{"year_min":1945}')
on conflict (month) do nothing;

-- ─── lives ──────────────────────────────────────────────────────────────────
create function public._run_lives() returns trigger
language plpgsql security definer set search_path = public as $$
declare g games; wrong int; done int;
begin
  if not (new.answered_at is not null or new.timed_out) then return null; end if;
  if tg_op = 'UPDATE' and (old.answered_at is not null or old.timed_out) then return null; end if;
  select * into g from games where id = new.game_id;
  if g.kind <> 'run' or g.status <> 'playing' then return null; end if;
  select count(*) filter (where timed_out or (answered_at is not null and not correct)),
         count(*) filter (where timed_out or answered_at is not null)
    into wrong, done
    from answers where game_id = g.id and player_id = new.player_id and position > 0;
  if wrong >= 3 or done >= g.card_count then perform _finish(g.id); end if;
  return null;
end $$;
create trigger answers_run_lives after insert or update of answered_at, timed_out, correct on public.answers
  for each row execute function public._run_lives();

-- ─── start / continue a run ─────────────────────────────────────────────────
create function public.start_run(p_display_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := _me();
  name  text := _set_display_name(p_display_name);
  m     date := date_trunc('month', _today())::date;
  f     jsonb := (_month_rule(_today())).deck_filter;
  pool  int;
  gid   uuid;
begin
  -- an unfinished run of mine this month: continue it
  select g.id into gid from games g join game_players gp on gp.game_id = g.id and gp.player_id = me
   where g.kind = 'run' and g.status = 'playing' and g.run_month = m
   order by g.created_at desc limit 1;
  if gid is not null and (_tick(gid)).status = 'playing' then return get_game(gid); end if;

  if (select count(*) from games g join game_players gp on gp.game_id = g.id and gp.player_id = me
       where g.kind = 'run' and g.created_at > _now() - interval '1 minute') >= 5 then
    raise exception 'too_many_runs';
  end if;

  select count(*) into pool from cards c where c.active
     and (f->>'year_min' is null or c.year >= (f->>'year_min')::int)
     and (f->>'year_max' is null or c.year <= (f->>'year_max')::int)
     and (f->'movements' is null or c.movement = any(array(select jsonb_array_elements_text(f->'movements'))));
  insert into games (kind, status, host_id, card_count, cards_per_turn, max_players, run_month,
                     current_turn, started_at, turn_started_at, turn_deadline)
  values ('run', 'playing', me, least(60, greatest(pool - 1, 10)), least(60, greatest(pool - 1, 10)), 1, m,
          1, _now(), _now(), _now() + interval '3 hours')
  returning id into gid;
  insert into game_players (game_id, player_id, display_name) values (gid, me, name);
  -- cards from my last two runs go to the back of the pile
  perform _deal(gid,
    array(select gc.card_id from game_cards gc where gc.game_id in (
            select g.id from games g join game_players gp on gp.game_id = g.id and gp.player_id = me
             where g.kind = 'run' and g.id <> gid order by g.created_at desc limit 2)),
    f);
  return get_game(gid);
end $$;

-- ─── boards ─────────────────────────────────────────────────────────────────
create function public._run_best(p_month date)
returns table (player_id uuid, username text, is_guest boolean, best int, runs bigint)
language sql stable security definer set search_path = public as $$
  select gp.player_id, p.username, p.is_guest, max(gp.score)::int, count(*)
    from games g join game_players gp on gp.game_id = g.id join profiles p on p.id = gp.player_id
   where g.kind = 'run' and g.run_month = p_month and g.status = 'finished'
   group by gp.player_id, p.username, p.is_guest
$$;

create function public._run_ranked(p_month date)
returns table (player_id uuid, username text, value int, rk bigint)
language sql stable security definer set search_path = public as $$
  select player_id, username, best, rank() over (order by best desc)
    from _run_best(p_month) where username is not null and not is_guest and best > 0
$$;

create or replace function public.monthly_leaderboard(p_month date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  m      date := date_trunc('month', coalesce(p_month, _today()))::date;
  rule   monthly_challenges := _month_rule(m);
  v_rank bigint; v_val int; v_best int; v_runs bigint;
begin
  select rk, value into v_rank, v_val from _run_ranked(m) where player_id = me;
  select best, runs into v_best, v_runs from _run_best(m) where player_id = me;
  return jsonb_build_object(
    'month', m, 'title', rule.title, 'description', rule.description, 'metric', 'best_run',
    'days_left', greatest(0, ((m + interval '1 month')::date - _today())),
    'players', (select count(*) from _run_ranked(m)),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'value', value, 'is_me', player_id = me) order by rk, username), '[]')
                from (select * from _run_ranked(m) order by rk limit 50) t),
    'me', case when v_best is null then null else jsonb_build_object(
            'rank', v_rank, 'value', coalesce(v_val, v_best), 'best', v_best, 'runs', v_runs,
            'ranked', v_rank is not null) end);
end $$;

-- the home card: theme, my best, my rank, who's just above me, a run to continue
create function public.run_summary() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  m      date := date_trunc('month', _today())::date;
  rule   monthly_challenges := _month_rule(_today());
  v_rank bigint; v_val int; v_best int; v_runs bigint;
  a_user text; a_val int;
  act    uuid;
begin
  select rk, value into v_rank, v_val from _run_ranked(m) where player_id = me;
  select best, runs into v_best, v_runs from _run_best(m) where player_id = me;
  if v_rank is not null then
    select username, value into a_user, a_val from _run_ranked(m) where value > v_val order by value, username limit 1;
  end if;
  select g.id into act from games g join game_players gp on gp.game_id = g.id and gp.player_id = me
   where g.kind = 'run' and g.status = 'playing' and g.run_month = m and g.turn_deadline > _now()
   order by g.created_at desc limit 1;
  return jsonb_build_object(
    'month', m, 'title', rule.title, 'description', rule.description,
    'days_left', greatest(0, ((m + interval '1 month')::date - _today())),
    'players', (select count(*) from _run_ranked(m)),
    'best', v_best, 'runs', coalesce(v_runs, 0), 'rank', v_rank,
    'above', case when a_user is null then null else jsonb_build_object('username', a_user, 'value', a_val) end,
    'active', act, 'server_now', _now());
end $$;

-- all time: everything except runs, plus each month's best run
create or replace function public._alltime_values()
returns table (player_id uuid, username text, points bigint, rk bigint)
language sql stable security definer set search_path = public as $$
  with pts as (
    select gp.player_id, gp.score::bigint s
      from game_players gp join games g on g.id = gp.game_id
     where gp.answered > 0 and g.kind <> 'run'
    union all
    select gp.player_id, max(gp.score)::bigint
      from game_players gp join games g on g.id = gp.game_id
     where g.kind = 'run' and g.status = 'finished'
     group by gp.player_id, g.run_month)
  select pts.player_id, p.username, sum(pts.s)::bigint, rank() over (order by sum(pts.s) desc)
    from pts join profiles p on p.id = pts.player_id
   where p.username is not null and not p.is_guest
   group by pts.player_id, p.username
  having sum(pts.s) > 0
$$;

-- engine functions from 002/003/007/008: a run behaves like the daily
-- (one player, all cards in one turn), plus a finished check in next_card
create or replace function public._ensure_daily(p_date date) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  select id into gid from games where challenge_date = p_date;
  if gid is not null then return gid; end if;
  insert into games (kind, status, card_count, cards_per_turn, max_players, challenge_date,
                     current_turn, started_at, turn_started_at, turn_deadline)
  values ('daily', 'playing', 10, 10, 1000000, p_date,
          1, _day_start(p_date), _day_start(p_date), _day_start(p_date + 1))
  on conflict (challenge_date) do nothing
  returning id into gid;
  if gid is null then                                   -- someone else created it a moment ago
    select id into gid from games where challenge_date = p_date;
    return gid;
  end if;
  perform _deal(gid,
    array(select gc.card_id from game_cards gc join games g on g.id = gc.game_id
           where g.kind = 'daily' and g.challenge_date between p_date - 60 and p_date - 1),
    null);                                     -- the daily always uses the whole deck (themes are for runs)
  return gid;
end $$;

create or replace function public._tick(p_game uuid) returns public.games
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

  if g.kind in ('daily', 'run') then
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

create or replace function public.next_card(p_game uuid) returns jsonb
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

  t0 := case when g.kind in ('daily', 'run') then 1 else (g.current_turn - 1) * g.cards_per_turn + 1 end;
  t1 := case when g.kind in ('daily', 'run') then g.card_count else g.current_turn * g.cards_per_turn end;

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
    -- a timed-out card can end a run (third life gone)
    if (select status from games where id = g.id) <> 'playing' then
      return jsonb_build_object('wait', 'finished');
    end if;
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

  if closed or g.kind in ('daily', 'run') then
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

  t0 := case when g.kind in ('daily', 'run') then 1 else (g.current_turn - 1) * g.cards_per_turn + 1 end;
  t1 := case when g.kind in ('daily', 'run') then g.card_count else g.current_turn * g.cards_per_turn end;
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
    when g.kind in ('daily', 'run')       then 'done'
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
                from game_players p where p.game_id = g.id and g.kind not in ('daily', 'run')),
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

revoke execute on function public._run_lives(), public._run_best(date), public._run_ranked(date),
  public.start_run(text), public.run_summary() from public, anon, authenticated;
grant execute on function public.start_run(text), public.run_summary() to authenticated;
