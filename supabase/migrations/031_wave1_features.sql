-- CIRCArt 031 — Wave 1 features:
--   1. Price Mode summary & leaderboard (task 46)
--   2. Grace Daily Streak (1 missed day per ISO week) + Painting of the Week (task 45)
--   3. Compact Play History across all modes (task 34)
--   4. Privacy 24-month inactive account expiry warning & cleanup, export & guest transfer (task 56b)
--   5. All remaining achievement badges + bug reporter reward flag (task 40)

-- ─── 1. Schema additions ────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists expiry_warned_at timestamptz;

alter table public.feedback
  add column if not exists bug_rewarded boolean not null default false;

create table public.weekly_paintings (
  week_start     date primary key,
  card_id        text not null references public.cards(id),
  varnish_url    text not null,
  patch_urls     text[] not null check (cardinality(patch_urls) = 7),
  artist_options text[] not null default '{}',
  story          text,
  story_de       text,
  created_at     timestamptz not null default now()
);
alter table public.weekly_paintings enable row level security;
revoke all on public.weekly_paintings from anon, authenticated;

create table public.weekly_painting_guesses (
  player_id  uuid not null references public.profiles(id) on delete cascade,
  week_start date not null references public.weekly_paintings(week_start) on delete cascade,
  guessed_on date not null,
  day_index  int  not null check (day_index between 1 and 7),
  choice     text not null,
  correct    boolean not null,
  created_at timestamptz not null default now(),
  primary key (player_id, guessed_on)
);
create index weekly_painting_guesses_week_idx
  on public.weekly_painting_guesses (player_id, week_start);
alter table public.weekly_painting_guesses enable row level security;
revoke all on public.weekly_painting_guesses from anon, authenticated;

-- ─── 2. Price Mode (46) ─────────────────────────────────────────────────────

create function public._price_best()
returns table (player_id uuid, username text, is_guest boolean, best int, runs bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select sg.player_id, p.username, p.is_guest, max(sg.score)::int, count(*)::bigint
    from public.solo_games sg
    join public.profiles p on p.id = sg.player_id
   where sg.mode = 'price'
   group by sg.player_id, p.username, p.is_guest
$$;

create function public._price_ranked()
returns table (player_id uuid, username text, value int, rk bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.player_id, b.username, b.best, rank() over (order by b.best desc)
    from public._price_best() b
   where b.username is not null and not b.is_guest and b.best > 0
$$;

create function public.price_summary() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._me();
  v_rank bigint;
  v_val  int;
  v_best int;
  v_runs bigint;
  a_user text;
  a_val  int;
begin
  select rk, value into v_rank, v_val from public._price_ranked() where player_id = me;
  select best, runs into v_best, v_runs from public._price_best() where player_id = me;
  if v_rank is not null then
    select username, value into a_user, a_val
      from public._price_ranked()
     where value > v_val
     order by value, username
     limit 1;
  end if;
  return jsonb_build_object(
    'best', v_best,
    'runs', coalesce(v_runs, 0),
    'rank', v_rank,
    'players', (select count(*) from public._price_ranked()),
    'above', case when a_user is null then null else jsonb_build_object('username', a_user, 'value', a_val) end,
    'server_now', public._now()
  );
end $$;

create function public.price_leaderboard() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._me();
  v_rank bigint;
  v_val  int;
  v_best int;
  v_runs bigint;
begin
  select rk, value into v_rank, v_val from public._price_ranked() where player_id = me;
  select best, runs into v_best, v_runs from public._price_best() where player_id = me;
  return jsonb_build_object(
    'metric', 'price_best',
    'players', (select count(*) from public._price_ranked()),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'rank', rk, 'username', username, 'value', value, 'is_me', player_id = me)
                  order by rk, username), '[]'::jsonb)
                from (select * from public._price_ranked() order by rk, username limit 50) t),
    'me', case when v_best is null then null else jsonb_build_object(
            'rank', v_rank,
            'value', coalesce(v_val, v_best),
            'best', v_best,
            'runs', v_runs,
            'ranked', v_rank is not null) end
  );
end $$;

-- ─── 3. Grace Daily Streak + Painting of the Week (45) ──────────────────────

create function public._grace_streak(p_player uuid)
returns table (streak int, longest int, free_day_used boolean, played_today boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today        date := public._today();
  v_this_wk      date := date_trunc('week', v_today::timestamp)::date;
  v_dates        date[];
  v_n            int;
  v_played_today boolean := false;
  v_streak       int := 0;
  v_longest      int := 0;
  v_free_used    boolean := false;
  v_pending_miss boolean := false;
  v_d            date;
  v_wk           date;
  v_wk_target    date;
  v_cur_wk       date;
  v_misses       int;
  v_cur          int;
  v_since_miss   int;
  v_idx          int;
begin
  select coalesce(array_agg(distinct g.challenge_date order by g.challenge_date), '{}')
    into v_dates
    from public.game_players gp
    join public.games g on g.id = gp.game_id
   where gp.player_id = p_player
     and g.kind = 'daily'
     and g.challenge_date is not null
     and g.challenge_date <= v_today
     and gp.answered >= g.card_count;

  v_n := coalesce(array_length(v_dates, 1), 0);
  if v_n = 0 then
    streak := 0;
    longest := 0;
    free_day_used := false;
    played_today := false;
    return next;
    return;
  end if;

  v_played_today := (v_dates[v_n] = v_today);

  -- Forward pass across played history for longest streak (1 missed day allowed per ISO week)
  v_cur_wk := null;
  v_misses := 0;
  v_cur := 0;
  v_since_miss := 0;
  v_idx := 1;
  v_d := v_dates[1];
  while v_d <= v_dates[v_n] loop
    v_wk := date_trunc('week', v_d::timestamp)::date;
    if v_cur_wk is null or v_wk <> v_cur_wk then
      v_cur_wk := v_wk;
      v_misses := 0;
      v_since_miss := 0;
    end if;

    if v_idx <= v_n and v_dates[v_idx] = v_d then
      v_cur := v_cur + 1;
      v_since_miss := v_since_miss + 1;
      if v_cur > v_longest then
        v_longest := v_cur;
      end if;
      v_idx := v_idx + 1;
      v_d := v_d + 1;
    else
      v_wk_target := date_trunc('week', v_dates[v_idx]::timestamp)::date;
      if v_wk_target - v_d >= 7 then
        -- Jump directly to Monday of the next played day's ISO week after a multi-week gap
        v_cur := 0;
        v_since_miss := 0;
        v_misses := 0;
        v_cur_wk := null;
        v_d := v_wk_target;
      else
        v_misses := v_misses + 1;
        if v_misses = 1 then
          v_since_miss := 0;
        else
          -- Drop everything up to the 1st missed day in this ISO week; current day becomes the 1st miss
          v_cur := v_since_miss;
          v_since_miss := 0;
          v_misses := 1;
        end if;
        v_d := v_d + 1;
      end if;
    end if;
  end loop;

  -- Backward pass from today (or yesterday if today is still open) for active streak & free_day_used
  v_d := case when v_played_today then v_today else v_today - 1 end;
  v_idx := v_n;
  v_cur_wk := null;
  v_misses := 0;
  while v_d >= v_dates[1] and v_idx >= 1 loop
    v_wk := date_trunc('week', v_d::timestamp)::date;
    if v_cur_wk is null or v_wk <> v_cur_wk then
      v_cur_wk := v_wk;
      v_misses := 0;
    end if;

    if v_dates[v_idx] = v_d then
      v_streak := v_streak + 1;
      if v_pending_miss then
        v_free_used := true;
        v_pending_miss := false;
      end if;
      v_idx := v_idx - 1;
      v_d := v_d - 1;
    else
      v_misses := v_misses + 1;
      if v_misses > 1 then
        exit;
      end if;
      if v_wk = v_this_wk and v_d < v_today then
        v_pending_miss := true;
      end if;
      v_d := v_d - 1;
    end if;
  end loop;

  streak := v_streak;
  longest := greatest(v_longest, v_streak);
  free_day_used := v_free_used;
  played_today := v_played_today;
  return next;
end $$;

create function public.my_streak() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me      uuid := public._me();
  v_today date := public._today();
  v_wk    date := date_trunc('week', v_today::timestamp)::date;
  gs      record;
  v_days  jsonb;
begin
  select * into gs from public._grace_streak(me);
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', i,
           'date', (v_wk + i),
           'played', exists (
             select 1
               from public.game_players gp
               join public.games g on g.id = gp.game_id
              where gp.player_id = me
                and g.kind = 'daily'
                and g.challenge_date = v_wk + i
                and (v_wk + i) <= v_today
                and gp.answered >= g.card_count
           ),
           'perfect', exists (
             select 1
               from public.game_players gp
               join public.games g on g.id = gp.game_id
              where gp.player_id = me
                and g.kind = 'daily'
                and g.challenge_date = v_wk + i
                and (v_wk + i) <= v_today
                and gp.answered >= g.card_count
                and gp.correct = gp.answered
           )
         ) order by i), '[]'::jsonb)
    into v_days
    from generate_series(0, 6) as i;

  return jsonb_build_object(
    'streak', gs.streak,
    'longest', gs.longest,
    'free_day_used', gs.free_day_used,
    'played_today', gs.played_today,
    'week_days', v_days
  );
end $$;

create function public._painting_artist_options(p_wp public.weekly_paintings, p_card public.cards)
returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when coalesce(array_length(p_wp.artist_options, 1), 0) > 0 then p_wp.artist_options
    else (
      select coalesce(array_agg(t.name order by md5(p_wp.card_id || '!' || t.name)), '{}'::text[])
        from (
          select p_card.artist as name
          union all
          (select s.artist
             from (select artist, min(abs(year - p_card.year)) as dist
                     from public.cards
                    where active and artist <> p_card.artist
                    group by artist) s
            order by (s.dist > 150), md5(p_wp.card_id || ':' || s.artist)
            limit 3)
        ) t
    )
  end
$$;

create function public.my_painting(p_week date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me              uuid := public._me();
  v_today         date := public._today();
  v_cur_wk        date := date_trunc('week', v_today::timestamp)::date;
  wk              date := date_trunc('week', coalesce(p_week, v_today)::timestamp)::date;
  wp              public.weekly_paintings;
  c               public.cards;
  v_days          jsonb;
  v_earned_count  int;
  v_sunday_earned boolean;
  v_revealed_ok   boolean;
  v_opts          text[];
  v_guesses       jsonb;
  v_guessed_right boolean;
  v_played_today  boolean;
  v_can_guess     boolean;
begin
  if wk > v_cur_wk then
    return null;
  end if;

  select * into wp from public.weekly_paintings where week_start = wk;
  if wp.week_start is null then
    return null;
  end if;

  select * into c from public.cards where id = wp.card_id;

  with d as (
    select i,
           exists (
             select 1
               from public.game_players gp
               join public.games g on g.id = gp.game_id
              where gp.player_id = me
                and g.kind = 'daily'
                and g.challenge_date = wk + i
                and (wk + i) <= v_today
                and gp.answered >= g.card_count
           ) as earned,
           exists (
             select 1
               from public.game_players gp
               join public.games g on g.id = gp.game_id
              where gp.player_id = me
                and g.kind = 'daily'
                and g.challenge_date = wk + i
                and (wk + i) <= v_today
                and gp.answered >= g.card_count
                and gp.correct = gp.answered
           ) as perfect
      from generate_series(0, 6) as i
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d.i,
           'earned', d.earned,
           'perfect', d.perfect,
           'patch_url', case when d.earned then wp.patch_urls[d.i + 1] else null end
         ) order by d.i), '[]'::jsonb),
         count(*) filter (where d.earned)::int,
         coalesce(bool_or(d.earned) filter (where d.i = 6), false)
    into v_days, v_earned_count, v_sunday_earned
    from d;

  v_revealed_ok := (v_today >= wk + 6 and v_sunday_earned) or (v_today > wk + 6 and v_earned_count > 0);

  if v_earned_count >= 3 or v_revealed_ok then
    v_opts := public._painting_artist_options(wp, c);
  else
    v_opts := '{}'::text[];
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'guessed_on', wpg.guessed_on,
           'day_index', wpg.day_index,
           'choice', wpg.choice,
           'correct', wpg.correct
         ) order by wpg.guessed_on), '[]'::jsonb),
         coalesce(bool_or(wpg.correct), false)
    into v_guesses, v_guessed_right
    from public.weekly_painting_guesses wpg
   where wpg.player_id = me and wpg.week_start = wk;

  v_played_today := exists (
    select 1
      from public.game_players gp
      join public.games g on g.id = gp.game_id
     where gp.player_id = me
       and g.kind = 'daily'
       and g.challenge_date = v_today
       and gp.answered >= g.card_count
  );

  v_can_guess := (not v_revealed_ok)
             and v_earned_count >= 3
             and (not v_guessed_right)
             and not exists (
               select 1 from public.weekly_painting_guesses wpg
                where wpg.player_id = me and wpg.guessed_on = v_today
             )
             and wk = v_cur_wk;

  return jsonb_build_object(
    'week_start', wk,
    'varnish_url', wp.varnish_url,
    'days', v_days,
    'earned_count', v_earned_count,
    'today_index', (v_today - wk),
    'played_today', v_played_today,
    'can_guess', v_can_guess,
    'artist_options', to_jsonb(v_opts),
    'guesses', v_guesses,
    'guessed_right', v_guessed_right,
    'revealed', case when v_revealed_ok then jsonb_build_object(
                  'title', c.title,
                  'artist', c.artist,
                  'year', c.year,
                  'image_url', c.image_url,
                  'story', wp.story,
                  'story_de', wp.story_de
                ) else null end
  );
end $$;

create function public.guess_painting(p_choice text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me              uuid := public._me();
  v_today         date := public._today();
  wk              date := date_trunc('week', v_today::timestamp)::date;
  wp              public.weekly_paintings;
  c               public.cards;
  v_earned_count  int;
  v_sunday_earned boolean;
  v_opts          text[];
  v_correct       boolean;
begin
  select * into wp from public.weekly_paintings where week_start = wk;
  if wp.week_start is null then
    raise exception 'no_painting';
  end if;

  with d as (
    select i,
           exists (
             select 1
               from public.game_players gp
               join public.games g on g.id = gp.game_id
              where gp.player_id = me
                and g.kind = 'daily'
                and g.challenge_date = wk + i
                and (wk + i) <= v_today
                and gp.answered >= g.card_count
           ) as earned
      from generate_series(0, 6) as i
  )
  select count(*) filter (where d.earned)::int,
         coalesce(bool_or(d.earned) filter (where d.i = 6), false)
    into v_earned_count, v_sunday_earned
    from d;

  if v_earned_count < 3 then
    raise exception 'not_enough_patches';
  end if;
  if v_today >= wk + 6 and v_sunday_earned then
    raise exception 'already_revealed';
  end if;
  if exists (
    select 1 from public.weekly_painting_guesses wpg
     where wpg.player_id = me and wpg.week_start = wk and wpg.correct
  ) then
    raise exception 'already_guessed';
  end if;
  if exists (
    select 1 from public.weekly_painting_guesses wpg
     where wpg.player_id = me and wpg.guessed_on = v_today
  ) then
    raise exception 'already_guessed';
  end if;

  select * into c from public.cards where id = wp.card_id;
  v_opts := public._painting_artist_options(wp, c);
  if p_choice is null or not (p_choice = any(v_opts)) then
    raise exception 'bad_choice';
  end if;

  v_correct := (p_choice = c.artist);

  insert into public.weekly_painting_guesses (player_id, week_start, guessed_on, day_index, choice, correct)
  values (me, wp.week_start, v_today, v_earned_count, p_choice, v_correct);

  return jsonb_build_object(
    'correct', v_correct,
    'choice', p_choice,
    'day_index', v_earned_count
  );
end $$;

create function public.my_restorations() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with per_week as (
    select wp.week_start,
           wp.varnish_url,
           wp.story,
           wp.story_de,
           c.title,
           c.artist,
           c.year,
           c.image_url,
           d.days,
           d.earned_count,
           d.sunday_earned
      from public.weekly_paintings wp
      join public.cards c on c.id = wp.card_id
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'day', x.i,
                 'earned', x.earned,
                 'perfect', x.perfect,
                 'patch_url', case when x.earned then wp.patch_urls[x.i + 1] else null end
               ) order by x.i), '[]'::jsonb) as days,
               count(*) filter (where x.earned)::int as earned_count,
               coalesce(bool_or(x.earned) filter (where x.i = 6), false) as sunday_earned
          from (
            select i,
                   exists (
                     select 1
                       from public.game_players gp
                       join public.games g on g.id = gp.game_id
                      where gp.player_id = public._me()
                        and g.kind = 'daily'
                        and g.challenge_date = wp.week_start + i
                        and (wp.week_start + i) <= public._today()
                        and gp.answered >= g.card_count
                   ) as earned,
                   exists (
                     select 1
                       from public.game_players gp
                       join public.games g on g.id = gp.game_id
                      where gp.player_id = public._me()
                        and g.kind = 'daily'
                        and g.challenge_date = wp.week_start + i
                        and (wp.week_start + i) <= public._today()
                        and gp.answered >= g.card_count
                        and gp.correct = gp.answered
                   ) as perfect
              from generate_series(0, 6) as i
          ) x
      ) d
     where d.earned_count > 0
       and (
         public._today() > wp.week_start + 6
         or (public._today() = wp.week_start + 6 and d.sunday_earned)
       )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'week_start', pw.week_start,
           'varnish_url', pw.varnish_url,
           'title', pw.title,
           'artist', pw.artist,
           'year', pw.year,
           'image_url', pw.image_url,
           'story', pw.story,
           'story_de', pw.story_de,
           'days', pw.days
         ) order by pw.week_start desc), '[]'::jsonb)
    from per_week pw
$$;

-- ─── 4. Compact Play History (34) ───────────────────────────────────────────

create function public.my_history(
  p_kind text default null,
  p_limit int default 30,
  p_offset int default 0
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me       uuid := public._me();
  v_kind   text := coalesce(nullif(trim(p_kind), ''), 'all');
  v_limit  int  := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_items  jsonb;
  v_more   boolean;
begin
  if v_kind not in ('all', 'daily', 'run', 'price', 'friends', 'solo') then
    raise exception 'bad_settings';
  end if;

  with all_rows as (
    select g.id,
           case
             when g.kind = 'daily' then 'daily'
             when g.kind = 'run' then 'run'
             else 'friends'
           end as kind,
           g.kind as mode,
           case
             when g.kind = 'daily' then dt.title
             when g.kind = 'run' then (public._month_rule(coalesce(g.run_month, (g.created_at at time zone 'Europe/Vienna')::date))).title
             else (select string_agg(x.display_name, ', ' order by x.joined_at)
                     from public.game_players x
                    where x.game_id = g.id and x.player_id <> me)
           end as title,
           case
             when g.kind = 'daily' then dt.title_de
             when g.kind = 'run' then (public._month_rule(coalesce(g.run_month, (g.created_at at time zone 'Europe/Vienna')::date))).title_de
             else null
           end as title_de,
           case when g.kind = 'daily' then public._challenge_no(g.challenge_date) else null end as challenge_no,
           case when g.kind = 'run' then g.run_month else null end as run_month,
           case
             when g.kind in ('daily', 'run') then coalesce(
               (select max(coalesce(a.answered_at, a.shown_at))
                  from public.answers a
                 where a.game_id = g.id and a.player_id = me),
               g.finished_at, g.started_at, g.created_at)
             else coalesce(g.finished_at, g.updated_at, g.created_at)
           end as played_at,
           gp.score,
           gp.correct,
           case when g.kind = 'run' then gp.answered else g.card_count end as total,
           case
             when g.kind = 'daily' then (select dr.rk::int from public._daily_ranked(g.challenge_date) dr where dr.player_id = me)
             when g.kind in ('live', 'async') then gp.final_rank
             else null
           end as rank,
           case
             when g.kind = 'daily' then (select count(*)::int from public.game_players x where x.game_id = g.id and x.answered > 0)
             when g.kind in ('live', 'async') then (select count(*)::int from public.game_players x where x.game_id = g.id)
             else 1
           end as players,
           g.status
      from public.game_players gp
      join public.games g on g.id = gp.game_id
      left join public.daily_themes dt on g.kind = 'daily' and dt.day = g.challenge_date
     where gp.player_id = me
       and (
         (g.kind = 'daily' and gp.answered > 0 and v_kind in ('all', 'daily'))
         or (g.kind = 'run' and gp.answered > 0 and v_kind in ('all', 'run'))
         or (g.kind in ('live', 'async') and g.status = 'finished' and v_kind in ('all', 'friends'))
       )

    union all

    select sg.id,
           case when sg.mode = 'price' then 'price' else 'solo' end as kind,
           sg.mode as mode,
           pk.title,
           pk.title_de,
           null::int as challenge_no,
           null::date as run_month,
           sg.finished_at as played_at,
           sg.score,
           sg.placements_correct as correct,
           sg.rounds as total,
           null::int as rank,
           1 as players,
           'finished'::text as status
      from public.solo_games sg
      left join public.packs pk on pk.id = sg.mode
     where sg.player_id = me
       and (
         (sg.mode = 'price' and v_kind in ('all', 'price'))
         or (sg.mode <> 'price' and v_kind in ('all', 'solo'))
       )
  ),
  page as (
    select *
      from all_rows
     order by played_at desc, id desc
     offset v_offset
     limit v_limit + 1
  ),
  trimmed as (
    select *
      from page
     order by played_at desc, id desc
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'kind', t.kind,
           'mode', t.mode,
           'title', t.title,
           'title_de', t.title_de,
           'challenge_no', t.challenge_no,
           'run_month', t.run_month,
           'played_at', t.played_at,
           'score', t.score,
           'correct', t.correct,
           'total', t.total,
           'rank', t.rank,
           'players', t.players,
           'status', t.status
         ) order by t.played_at desc, t.id desc), '[]'::jsonb),
         (select count(*) > v_limit from page)
    into v_items, v_more
    from trimmed t;

  return jsonb_build_object('items', v_items, 'has_more', v_more);
end $$;

-- ─── 5. Privacy 56b: Expiry warning, cleanup, export & guest transfer ────────

create function public._clear_expiry_warn() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.profiles
     set expiry_warned_at = null
   where id = new.player_id
     and expiry_warned_at is not null;
  return null;
end $$;

create function public._clear_expiry_warn_on_seen() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.last_seen_at > old.last_seen_at
     and old.expiry_warned_at is not null
     and new.last_seen_at > old.expiry_warned_at then
    new.expiry_warned_at := null;
  end if;
  return new;
end $$;

create trigger profiles_clear_expiry_warn_seen
  before update of last_seen_at on public.profiles
  for each row execute function public._clear_expiry_warn_on_seen();

create trigger solo_games_clear_expiry_warn
  after insert on public.solo_games
  for each row execute function public._clear_expiry_warn();

create trigger game_players_clear_expiry_warn
  after insert on public.game_players
  for each row execute function public._clear_expiry_warn();

create trigger answers_clear_expiry_warn
  after insert or update of answered_at on public.answers
  for each row execute function public._clear_expiry_warn();

create trigger weekly_painting_guesses_clear_expiry_warn
  after insert on public.weekly_painting_guesses
  for each row execute function public._clear_expiry_warn();

create function public.inactive_accounts_to_warn(p_idle interval default '23 months')
returns table (player_id uuid, email text, display_name text, last_active timestamptz)
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select p.id as player_id,
         u.email::text as email,
         p.display_name,
         coalesce(public._last_active(p.id), p.created_at) as last_active
    from public.profiles p
    join auth.users u on u.id = p.id
   where not p.is_guest
     and not coalesce(u.is_anonymous, false)
     and u.email is not null
     and nullif(btrim(u.email), '') is not null
     and p.expiry_warned_at is null
     and coalesce(public._last_active(p.id), p.created_at) < public._now() - p_idle
   order by coalesce(public._last_active(p.id), p.created_at) asc, p.id asc
   limit 500
$$;

create function public.mark_expiry_warned(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  update public.profiles
     set expiry_warned_at = public._now()
   where id = any(p_ids)
     and expiry_warned_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.privacy_cleanup(
  p_guest_idle      interval default '6 months',
  p_push_idle       interval default '6 months',
  p_feedback_strip  interval default '90 days',
  p_feedback_done   interval default '12 months',
  p_feedback_max    interval default '24 months')
returns jsonb
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  t          timestamptz := public._now();
  n_guests   int;
  n_accounts int;
  n_push     int;
  n_outbox   int;
  n_lobby    int;
  n_orphan   int;
  n_fb_strip int;
  n_fb_del   int;
begin
  with idle as (
    select p.id from public.profiles p
     where p.is_guest and coalesce(public._last_active(p.id), p.created_at) < t - p_guest_idle)
  delete from auth.users u using idle where u.id = idle.id and coalesce(u.is_anonymous, true);
  get diagnostics n_guests = row_count;

  with expired as (
    select p.id from public.profiles p
     where not p.is_guest
       and p.expiry_warned_at is not null
       and p.expiry_warned_at < t - interval '30 days'
       and coalesce(public._last_active(p.id), p.created_at) < t - interval '24 months'
       and coalesce(public._last_active(p.id), p.created_at) < p.expiry_warned_at)
  delete from auth.users u using expired where u.id = expired.id and not coalesce(u.is_anonymous, false);
  get diagnostics n_accounts = row_count;

  delete from public.push_subscriptions s
   where coalesce(public._last_active(s.player_id), s.created_at) < t - p_push_idle;
  get diagnostics n_push = row_count;

  delete from public.push_outbox
   where sent_at < t - interval '14 days'
      or (sent_at is null and created_at < t - interval '2 days');
  get diagnostics n_outbox = row_count;

  delete from public.games
   where (status = 'lobby' and created_at < t - interval '1 day')
      or (status = 'cancelled' and created_at < t - interval '30 days');
  get diagnostics n_lobby = row_count;

  delete from public.games g
   where g.kind <> 'daily' and g.created_at < t - interval '1 day'
     and not exists (select 1 from public.game_players where game_id = g.id);
  get diagnostics n_orphan = row_count;

  update public.feedback set context = context - 'ua' - 'page'
   where created_at < t - p_feedback_strip and (context ? 'ua' or context ? 'page');
  get diagnostics n_fb_strip = row_count;

  delete from public.feedback
   where (status = 'done' and created_at < t - p_feedback_done)
      or created_at < t - p_feedback_max;
  get diagnostics n_fb_del = row_count;

  delete from public.join_failures where at < t - interval '1 day';
  delete from public.guest_transfers where created_at < t - interval '1 day';

  return jsonb_build_object(
    'guests_deleted', n_guests,
    'accounts_deleted', n_accounts,
    'push_devices_removed', n_push,
    'push_messages_deleted', n_outbox,
    'stale_games_deleted', n_lobby,
    'empty_games_deleted', n_orphan,
    'feedback_stripped', n_fb_strip,
    'feedback_deleted', n_fb_del
  );
end $$;

create or replace function public.finish_guest_transfer(p_token text) returns jsonb
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  me     uuid := public._me();
  guest  uuid;
  n_solo int; n_games int; n_packs int;
begin
  if exists (select 1 from auth.users where id = me and coalesce(is_anonymous, false)) then
    raise exception 'not_signed_in';
  end if;
  delete from public.guest_transfers
   where token = p_token and created_at > now() - interval '15 minutes'
  returning guest_id into guest;
  if guest is null or guest = me
     or not exists (select 1 from auth.users where id = guest and coalesce(is_anonymous, false)) then
    return jsonb_build_object('moved', false);
  end if;

  -- solo games (a game already saved for the account wins)
  delete from public.solo_games g where g.player_id = guest
     and exists (select 1 from public.solo_games x where x.player_id = me and x.client_id = g.client_id);
  update public.solo_games set player_id = me where player_id = guest;
  get diagnostics n_solo = row_count;

  -- card packs
  insert into public.player_packs (player_id, pack_id, unlocked_at, seen)
  select me, pack_id, unlocked_at, seen from public.player_packs where player_id = guest
  on conflict (player_id, pack_id) do nothing;
  get diagnostics n_packs = row_count;

  -- painting guesses (target account's own guess on same date wins)
  insert into public.weekly_painting_guesses (player_id, week_start, guessed_on, day_index, choice, correct, created_at)
  select me, week_start, guessed_on, day_index, choice, correct, created_at
    from public.weekly_painting_guesses
   where player_id = guest
  on conflict (player_id, guessed_on) do nothing;

  -- games with friends, unless the account plays in the same game already
  create temp table if not exists _moving (game_id uuid) on commit drop;
  truncate _moving;
  insert into _moving (game_id)
  select gp.game_id from public.game_players gp join public.games g on g.id = gp.game_id
   where gp.player_id = guest and g.kind in ('live', 'async')
     and not exists (select 1 from public.game_players x where x.game_id = gp.game_id and x.player_id = me);
  update public.game_players set player_id = me where player_id = guest and game_id in (select game_id from _moving);
  get diagnostics n_games = row_count;
  update public.answers set player_id = me where player_id = guest and game_id in (select game_id from _moving);
  update public.games set host_id = me where host_id = guest and id in (select game_id from _moving);

  -- any unmoved lobby hosted by the guest loses its host once the guest is deleted
  update public.games set status = 'cancelled', updated_at = public._now()
   where host_id = guest and status = 'lobby';

  -- devices (keep newest 10 for the account) and feedback
  update public.push_subscriptions set player_id = me where player_id = guest;
  if (select count(*) from public.push_subscriptions where player_id = me) > 10 then
    delete from public.push_subscriptions where endpoint in (
      select endpoint from public.push_subscriptions where player_id = me order by created_at desc offset 10);
  end if;
  update public.feedback set player_id = me where player_id = guest;

  delete from auth.users where id = guest;

  return jsonb_build_object('moved', true, 'solo_games', n_solo, 'games', n_games, 'packs', n_packs);
end $$;

create or replace function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  me        uuid := public._me();
  acct      jsonb;
  idents    jsonb := '[]';
begin
  select coalesce(jsonb_object_agg(k, v), '{}') into acct
    from auth.users u, jsonb_each(to_jsonb(u)) e(k, v)
   where u.id = me
     and k in ('id', 'email', 'phone', 'is_anonymous', 'created_at', 'updated_at', 'last_sign_in_at',
               'email_confirmed_at', 'confirmed_at', 'raw_user_meta_data');
  if to_regclass('auth.identities') is not null then
    execute $q$ select coalesce(jsonb_agg(jsonb_build_object(
                  'provider', provider, 'created_at', created_at, 'last_sign_in_at', last_sign_in_at)), '[]')
                  from auth.identities where user_id = $1 $q$
      into idents using me;
  end if;

  return jsonb_build_object(
    'format', 'circart-export-1',
    'exported_at', now(),
    'controller', 'CIRCArt (see the privacy policy in the app for contact details)',
    'account', acct || jsonb_build_object('sign_in_methods', idents),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = me),

    'solo_games', (select coalesce(jsonb_agg((to_jsonb(g) - 'player_id') || jsonb_build_object(
                      'cards', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'position', gc.position, 'card', k.source_id, 'title', k.title,
                                  'artist', k.artist, 'year', k.year, 'correct', gc.correct,
                                  'artist_bonus', gc.artist_bonus, 'title_bonus', gc.title_bonus,
                                  'year_bonus', gc.year_bonus) order by gc.position), '[]')
                                from public.solo_game_cards gc join public.cards k on k.id = gc.card_id
                               where gc.game_id = g.id))
                    order by g.finished_at), '[]')
                  from public.solo_games g where g.player_id = me),

    'games', (select coalesce(jsonb_agg(jsonb_build_object(
                 'game', jsonb_build_object('id', g.id, 'kind', g.kind, 'code', g.code, 'status', g.status,
                                            'created_at', g.created_at, 'started_at', g.started_at,
                                            'finished_at', g.finished_at, 'challenge_date', g.challenge_date,
                                            'run_month', g.run_month, 'i_was_host', g.host_id = me),
                 'me', to_jsonb(gp) - 'player_id' - 'game_id',
                 'answers', (select coalesce(jsonb_agg((to_jsonb(a) - 'player_id' - 'game_id') ||
                                case when g.status in ('finished', 'cancelled') then
                                  (select jsonb_build_object('card_title', k.title, 'card_artist', k.artist, 'card_year', k.year)
                                     from public.game_cards gc join public.cards k on k.id = gc.card_id
                                    where gc.game_id = g.id and gc.position = a.position)
                                else '{}' end
                               order by a.position), '[]')
                              from public.answers a where a.game_id = g.id and a.player_id = me))
               order by g.created_at), '[]')
              from public.game_players gp join public.games g on g.id = gp.game_id where gp.player_id = me),

    'feedback', (select coalesce(jsonb_agg(to_jsonb(f) - 'player_id' - 'emailed_at' order by f.created_at), '[]')
                   from public.feedback f where f.player_id = me),

    'push_devices', (select coalesce(jsonb_agg(jsonb_build_object(
                        'endpoint', s.endpoint, 'user_agent', s.user_agent, 'created_at', s.created_at)
                        order by s.created_at), '[]')
                       from public.push_subscriptions s where s.player_id = me),
    'push_messages', (select coalesce(jsonb_agg(jsonb_build_object(
                         'kind', o.kind, 'title', o.title, 'body', o.body, 'created_at', o.created_at,
                         'sent_at', o.sent_at) order by o.created_at), '[]')
                        from public.push_outbox o where o.player_id = me),
    'card_packs', (select coalesce(jsonb_agg(jsonb_build_object(
                      'pack', pp.pack_id, 'unlocked_at', pp.unlocked_at) order by pp.unlocked_at), '[]')
                     from public.player_packs pp where pp.player_id = me),
    'weekly_painting_guesses', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'week_start', g.week_start,
                                   'guessed_on', g.guessed_on,
                                   'day_index', g.day_index,
                                   'choice', g.choice,
                                   'correct', g.correct
                                 ) order by g.guessed_on), '[]'::jsonb)
                                  from public.weekly_painting_guesses g where g.player_id = me),
    'join_failures', (select coalesce(jsonb_agg(jsonb_build_object('at', jf.at) order by jf.at), '[]')
                        from public.join_failures jf where jf.player_id = me),
    'guest_transfers', (select coalesce(jsonb_agg(jsonb_build_object('created_at', gt.created_at) order by gt.created_at), '[]')
                          from public.guest_transfers gt where gt.guest_id = me),

    'stored_on_this_device', 'The app also keeps settings (language, theme, onboarding seen, '
      || 'unsent solo games, your lasting gallery collection, a temporary guest-transfer ticket '
      || 'while signing in, and your sign-in session) in your browser''s local storage. '
      || 'They never leave your device except the session (which signs you in) and the temporary transfer ticket (used once to move your guest games).');
end $$;

-- ─── 6. All Remaining Badges (40) ───────────────────────────────────────────

create function public.mark_bug_reporter(p_feedback_id bigint, p_rewarded boolean default true) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.feedback
     set bug_rewarded = coalesce(p_rewarded, true)
   where id = p_feedback_id
$$;

create or replace function public.my_achievements() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with caller as (
    select public._me() as me, public._today() as today
  ),
  mine as (
    select gp.*, g.kind, g.status, g.card_count,
           (select count(*) from public.game_players x where x.game_id = g.id) as n_players,
           (select max(x.score) from public.game_players x where x.game_id = g.id and x.player_id <> gp.player_id) as best_other
      from public.game_players gp
      join public.games g on g.id = gp.game_id
      cross join caller c
     where gp.player_id = c.me and gp.answered > 0
  ),
  best_streak as (
    select greatest(
      public._longest_daily_streak(c.me),
      coalesce((select gs.longest from public._grace_streak(c.me) gs), 0)
    ) as val
      from caller c
  ),
  b(key, tier) as (
    select 'daily_streak', t
      from unnest(array[7, 30, 100]) t, best_streak bs
     where bs.val >= t

    union all
    select 'perfect_daily', least(count(*), 10)::int
      from mine
     where kind = 'daily' and answered >= 5 and correct = answered
    having count(*) > 0

    union all
    select 'signature_spotter', 100
     where coalesce((select sum(artists_named) from mine), 0) >= 100

    union all
    select 'movement_maker', 100
     where coalesce((select sum(movements_named) from mine), 0) >= 100

    union all
    select 'photo_finish', count(*)::int
      from mine
     where kind in ('live', 'async') and status = 'finished' and final_rank = 1
       and n_players >= 2 and score - best_other < 100
    having count(*) > 0

    union all
    select 'storyteller', count(*)::int
      from (
        select date_trunc('month', dt.day::timestamp)::date as m
          from public.daily_themes dt, caller c
         group by 1, c.today
        having c.today >= (date_trunc('month', dt.day::timestamp)::date + interval '1 month')::date
           and bool_and(exists (
             select 1
               from public.games g
               join public.game_players gp on gp.game_id = g.id
              where g.kind = 'daily'
                and g.challenge_date = dt.day
                and gp.player_id = (select me from caller)
                and gp.answered >= g.card_count
           ))
      ) sm
    having count(*) > 0

    union all
    select 'full_gallery', 1
      from caller c
     where (select count(*) from public.packs where active) > 0
       and (select count(*) from public.player_packs pp
              join public.packs pk on pk.id = pp.pack_id
             where pp.player_id = c.me and pk.active)
           >= (select count(*) from public.packs where active)

    union all
    select 'sharp_eye', 1
      from caller c
     where exists (
       select 1
         from public.weekly_painting_guesses wpg
        where wpg.player_id = c.me
          and wpg.correct = true
          and wpg.day_index in (3, 4)
     )

    union all
    select 'going_going_gone', 15
      from caller c
     where exists (
       select 1
         from public.solo_games sg
        where sg.player_id = c.me
          and sg.mode = 'price'
          and sg.score >= 15
     )

    union all
    select 'restorer', 1
      from caller c
     where exists (
       select 1
         from public.feedback f
        where f.player_id = c.me
          and f.bug_rewarded = true
     )

    union all
    select 'vernissage_guest', 1
      from caller c
     where exists (
       select 1
         from public.profiles p
        where p.id = c.me
          and not p.is_guest
          and p.created_at < '2027-01-01'::timestamptz
     )
       and (
         exists (
           select 1
             from public.game_players gp
             join public.games g on g.id = gp.game_id
            where gp.player_id = c.me
              and (
                (g.kind = 'daily' and gp.answered >= g.card_count)
                or (g.kind = 'run' and g.status = 'finished' and gp.answered > 0)
                or (g.kind in ('live', 'async') and g.status = 'finished')
              )
         )
         or exists (
           select 1 from public.solo_games sg where sg.player_id = c.me
         )
       )
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'tier', tier) order by key, tier), '[]'::jsonb)
    from b
$$;

-- ─── 7. Explicit execute permissions ────────────────────────────────────────

revoke execute on function
  public._price_best(),
  public._price_ranked(),
  public.price_summary(),
  public.price_leaderboard(),
  public._grace_streak(uuid),
  public.my_streak(),
  public._painting_artist_options(public.weekly_paintings, public.cards),
  public.my_painting(date),
  public.guess_painting(text),
  public.my_restorations(),
  public.my_history(text, int, int),
  public._clear_expiry_warn(),
  public._clear_expiry_warn_on_seen(),
  public.inactive_accounts_to_warn(interval),
  public.mark_expiry_warned(uuid[]),
  public.privacy_cleanup(interval, interval, interval, interval, interval),
  public.finish_guest_transfer(text),
  public.export_my_data(),
  public.mark_bug_reporter(bigint, boolean),
  public.my_achievements()
  from public, anon, authenticated;

grant execute on function
  public.price_summary(),
  public.price_leaderboard(),
  public.my_streak(),
  public.my_painting(date),
  public.guess_painting(text),
  public.my_restorations(),
  public.my_history(text, int, int),
  public.finish_guest_transfer(text),
  public.export_my_data(),
  public.my_achievements()
  to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant execute on function
      public.inactive_accounts_to_warn(interval),
      public.mark_expiry_warned(uuid[]),
      public.privacy_cleanup(interval, interval, interval, interval, interval),
      public.mark_bug_reporter(bigint, boolean)
      to service_role;
  end if;
end $$;
