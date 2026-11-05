-- ============================================================================
-- CIRCArt — daily challenge, monthly challenge, leaderboards and stats
--
-- Daily: the same 10 cards for everyone, one attempt, the game engine's timed
--   rules. A new one starts at midnight Vienna time. Leaderboard per day.
-- Monthly: a rule per month in `monthly_challenges` (metric + optional themed
--   deck for that month's dailies). Without a row the default is "most points,
--   best 20 daily challenges count".
-- Leaderboards list accounts with a username only; guests can play and see
--   their own score, but aren't ranked.
-- Solo games don't count: they're scored on the phone.
-- ============================================================================

create function public._today() returns date
language sql stable as $$ select (_now() at time zone 'Europe/Vienna')::date $$;

create function public._day_start(d date) returns timestamptz
language sql immutable as $$ select d::timestamp at time zone 'Europe/Vienna' $$;

-- ─── monthly rules ──────────────────────────────────────────────────────────
-- Add a month in the Supabase SQL editor, e.g.
--   insert into monthly_challenges (month, title, description, metric, deck_filter)
--   values ('2026-12-01', 'Baroque December', 'Every daily is 1600–1750. Most points wins.',
--           'daily_best20', '{"year_min":1600,"year_max":1750}');

create table public.monthly_challenges (
  month        date primary key check (extract(day from month) = 1),
  title        text not null,
  description  text not null,
  metric       text not null check (metric in
                 ('daily_points',     -- all daily scores added up
                  'daily_best20',     -- best 20 daily scores added up
                  'best_streak',      -- longest run of correct cards in any game
                  'accuracy',         -- % placed right (at least 50 cards)
                  'artists_named')),  -- artist bonuses
  deck_filter  jsonb,                 -- themed month: {"year_min","year_max","movements":[...]}
  created_at   timestamptz not null default now()
);
alter table public.monthly_challenges enable row level security;
revoke all on public.monthly_challenges from anon, authenticated;

create function public._month_rule(p_day date) returns public.monthly_challenges
language plpgsql stable security definer set search_path = public as $$
declare r monthly_challenges;
begin
  select * into r from monthly_challenges where month = date_trunc('month', p_day)::date;
  if r.month is null then
    r.month := date_trunc('month', p_day)::date;
    r.title := 'Most points in daily challenges';
    r.description := 'Your best 20 daily challenges this month count.';
    r.metric := 'daily_best20';
  end if;
  return r;
end $$;

-- ─── daily challenge ────────────────────────────────────────────────────────

create function public._ensure_daily(p_date date) returns uuid
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
    (_month_rule(p_date)).deck_filter);
  return gid;
end $$;

create function public._challenge_no(p_date date) returns int
language sql stable security definer set search_path = public as $$
  select (p_date - coalesce(min(challenge_date), p_date))::int + 1 from games where kind = 'daily'
$$;

-- Days in a row with a daily played, counting back from today (or yesterday,
-- so the streak survives until you've had a chance to play today).
create function public._daily_streak(p_player uuid) returns int
language plpgsql stable security definer set search_path = public as $$
declare d date := _today(); n int := 0;
begin
  if not exists (select 1 from game_players gp join games g on g.id = gp.game_id
                  where gp.player_id = p_player and g.challenge_date = d and gp.answered > 0) then
    d := d - 1;
  end if;
  while exists (select 1 from game_players gp join games g on g.id = gp.game_id
                 where gp.player_id = p_player and g.challenge_date = d and gp.answered > 0) loop
    n := n + 1; d := d - 1;
  end loop;
  return n;
end $$;

create function public._longest_daily_streak(p_player uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(n), 0) from (
    select count(*) n from (
      select g.challenge_date - (row_number() over (order by g.challenge_date))::int as grp
        from game_players gp join games g on g.id = gp.game_id
       where gp.player_id = p_player and g.kind = 'daily' and gp.answered > 0) x
    group by grp) y
$$;

-- Start (or continue) today's challenge. Returns the game screen data.
create function public.play_daily(p_display_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   uuid := _me();
  name text := _set_display_name(p_display_name);
  gid  uuid := _ensure_daily(_today());
begin
  insert into game_players (game_id, player_id, display_name) values (gid, me, name)
  on conflict do nothing;
  return get_game(gid) || jsonb_build_object('challenge_no', _challenge_no(_today()));
end $$;

-- Ranked daily results: accounts with a username, highest score first, faster wins ties.
create function public._daily_ranked(p_date date)
returns table (player_id uuid, username text, score int, correct int, rk bigint)
language sql stable security definer set search_path = public as $$
  select gp.player_id, p.username, gp.score, gp.correct,
         rank() over (order by gp.score desc, gp.total_ms)
    from game_players gp join games g on g.id = gp.game_id join profiles p on p.id = gp.player_id
   where g.challenge_date = p_date and gp.answered > 0 and p.username is not null and not p.is_guest
$$;

create function public.daily_leaderboard(p_date date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := _me();
  d   date := coalesce(p_date, _today());
  gp  game_players;
  r   record;
begin
  select x.* into gp from game_players x join games g on g.id = x.game_id
   where g.challenge_date = d and x.player_id = me;
  select * into r from _daily_ranked(d) where player_id = me;
  return jsonb_build_object(
    'date', d, 'challenge_no', _challenge_no(d),
    'players', (select count(*) from game_players x join games g on g.id = x.game_id
                 where g.challenge_date = d and x.answered > 0),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'score', score, 'correct', correct, 'is_me', player_id = me) order by rk, username), '[]')
                from (select * from _daily_ranked(d) order by rk limit 50) t),
    'me', case when gp.player_id is null then null else jsonb_build_object(
            'score', gp.score, 'correct', gp.correct, 'answered', gp.answered,
            'rank', r.rk, 'ranked', r.rk is not null) end);
end $$;

-- Everything the home screen's daily card needs, plus the monthly banner.
create function public.daily_summary() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  today  date := _today();
  gid    uuid := _ensure_daily(_today());
  gp     game_players;
  yday   uuid;
  hard   jsonb;
  board  jsonb;
  month  jsonb;
begin
  select * into gp from game_players where game_id = gid and player_id = me;
  select id into yday from games where challenge_date = today - 1;

  -- yesterday's hardest card: the lowest share placed right (at least 3 answers)
  select jsonb_build_object('title', c.title, 'artist', c.artist, 'year', c.year,
                            'image_url', c.image_url, 'percent_right', s.pct)
    into hard
    from (select a.position, round(100.0 * avg(a.correct::int))::int pct
            from answers a where a.game_id = yday and (a.answered_at is not null or a.timed_out)
           group by a.position having count(*) >= 3
           order by avg(a.correct::int), a.position limit 1) s
    join game_cards gc on gc.game_id = yday and gc.position = s.position
    join cards c on c.id = gc.card_id;

  if gp.player_id is not null then board := daily_leaderboard(today)->'me'; end if;
  month := monthly_leaderboard(null);

  return jsonb_build_object(
    'challenge_no', _challenge_no(today),
    'card_count', 10,
    'resets_at', _day_start(today + 1),
    'server_now', _now(),
    'status', case when gp.player_id is null then 'not_started'
                   when gp.answered >= 10 then 'done' else 'in_progress' end,
    'me', board,
    'streak', _daily_streak(me),
    'yesterdays_hardest', hard,
    'month', jsonb_build_object('title', month->'title', 'description', month->'description',
                                'days_left', month->'days_left', 'me', month->'me'));
end $$;

-- ─── monthly leaderboard ────────────────────────────────────────────────────

create function public._month_values(p_month date)
returns table (player_id uuid, username text, value numeric, rk bigint)
language sql stable security definer set search_path = public as $$
  with rule as (select * from _month_rule(p_month)),
  played as (
    select gp.*, g.kind
      from game_players gp join games g on g.id = gp.game_id
     where gp.answered > 0 and g.status in ('playing','finished')
       and coalesce(g.challenge_date, (g.started_at at time zone 'Europe/Vienna')::date)
           between date_trunc('month', p_month)::date
               and (date_trunc('month', p_month) + interval '1 month - 1 day')::date),
  best20 as (
    select player_id, sum(score) v from (
      select player_id, score, row_number() over (partition by player_id order by score desc) rn
        from played where kind = 'daily') x
     where rn <= 20 group by player_id),
  per as (
    select player_id,
           sum(score) filter (where kind = 'daily') daily_points,
           max(best_streak) best_streak,
           sum(correct) c, sum(answered) n,
           sum(artists_named) artists
      from played group by player_id),
  vals as (
    select per.player_id,
           case (select metric from rule)
             when 'daily_points'  then per.daily_points
             when 'daily_best20'  then b.v
             when 'best_streak'   then per.best_streak
             when 'accuracy'      then case when per.n >= 50 then round(100.0 * per.c / per.n, 1) end
             when 'artists_named' then per.artists
           end::numeric as value
      from per left join best20 b on b.player_id = per.player_id)
  select v.player_id, p.username, v.value, rank() over (order by v.value desc)
    from vals v join profiles p on p.id = v.player_id
   where v.value is not null and v.value > 0 and p.username is not null and not p.is_guest
$$;

create function public.monthly_leaderboard(p_month date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   uuid := _me();
  m    date := date_trunc('month', coalesce(p_month, _today()))::date;
  rule monthly_challenges := _month_rule(m);
  r    record;
begin
  select * into r from _month_values(m) where player_id = me;
  return jsonb_build_object(
    'month', m, 'title', rule.title, 'description', rule.description, 'metric', rule.metric,
    'days_left', greatest(0, ((m + interval '1 month')::date - _today())),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'value', value, 'is_me', player_id = me) order by rk, username), '[]')
                from (select * from _month_values(m) order by rk limit 50) t),
    'me', case when r.player_id is null then null
               else jsonb_build_object('rank', r.rk, 'value', r.value) end);
end $$;

-- ─── all time ───────────────────────────────────────────────────────────────

create function public._alltime_values()
returns table (player_id uuid, username text, points bigint, rk bigint)
language sql stable security definer set search_path = public as $$
  select gp.player_id, p.username, sum(gp.score)::bigint pts, rank() over (order by sum(gp.score) desc)
    from game_players gp join profiles p on p.id = gp.player_id
   where gp.answered > 0 and p.username is not null and not p.is_guest
   group by gp.player_id, p.username
  having sum(gp.score) > 0
$$;

create function public.alltime_leaderboard() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); r record;
begin
  select * into r from _alltime_values() where player_id = me;
  return jsonb_build_object(
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'points', points, 'is_me', player_id = me) order by rk, username), '[]')
                from (select * from _alltime_values() order by rk limit 50) t),
    'me', case when r.player_id is null then null
               else jsonb_build_object('rank', r.rk, 'points', r.points) end);
end $$;

-- The "Your stats" box: online games plus solo.
create function public.my_stats() returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select gp.*, g.kind, g.status,
           (select count(*) from game_players x where x.game_id = g.id) as n_players
      from game_players gp join games g on g.id = gp.game_id
     where gp.player_id = _me() and gp.answered > 0)
  select jsonb_build_object(
    'since',           (select created_at from profiles where id = _me()),
    'total_points',    coalesce((select sum(score) from mine), 0),
    'games_played',    (select count(*) from mine where kind = 'daily' or status = 'finished'),
    'cards_placed',    coalesce((select sum(answered) from mine), 0),
    'accuracy',        (select round(sum(correct)::numeric / nullif(sum(answered), 0), 3) from mine),
    'best_streak',     coalesce((select max(best_streak) from mine), 0),
    'artists_named',   coalesce((select sum(artists_named) from mine), 0),
    'daily_streak',    _daily_streak(_me()),
    'longest_daily_streak', _longest_daily_streak(_me()),
    'wins',            (select count(*) from mine where kind in ('live','async') and status = 'finished'
                                                and final_rank = 1 and n_players >= 2),
    'podiums',         (select count(*) from mine where kind in ('live','async') and status = 'finished'
                                                and final_rank <= 3 and n_players >= 3),
    'solo',            my_solo_stats())
$$;

-- ─── permissions (complete list: new functions default to executable) ───────

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  -- 001 accounts, solo, feedback
  public.get_my_profile(), public.update_profile(text, text),
  public.username_available(text), public.delete_my_account(),
  public.submit_solo_game(jsonb), public.recently_seen_cards(int), public.my_solo_stats(),
  public.submit_feedback(text, text, text, jsonb),
  -- 002 games
  public.create_game(text, int, int, text), public.join_game(text, text),
  public.leave_game(uuid), public.start_game(uuid),
  public.next_card(uuid), public.answer(uuid, int, int), public.pick_artist(uuid, int, text),
  public.reveal(uuid, int), public.get_game(uuid), public.my_games(),
  public._is_member(uuid),
  -- 003 challenges and rankings
  public.play_daily(text), public.daily_summary(), public.daily_leaderboard(date),
  public.monthly_leaderboard(date), public.alltime_leaderboard(), public.my_stats()
to authenticated;
grant execute on function public.submit_feedback(text, text, text, jsonb) to anon;
