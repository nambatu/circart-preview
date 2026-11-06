-- CIRCArt 019 — story dailies: a themed daily challenge with a red thread.
--
-- Julian (6 Nov): "a challenge with only those pieces together with a story
-- told along a red string". On a date with a theme, the daily deals the
-- theme's works in a fixed order (position 0 = the start card on the
-- timeline) instead of random cards. A story can be short or long: 3 to 30
-- cards to place (Julian: "sometimes shortness is the sweetest"). Each work has a short chapter that is
-- shown after the player placed it; read in order, the chapters tell one
-- story (e.g. a walk through Würzburg Cathedral). Days without a theme stay
-- random, exactly as before.
--
-- Theme cards live in `cards` with active = false (like pack cards), so they
-- never show up in random games. The rows are written by the build
-- (supabase/dailies.sql from dailies/<date>-<slug>.json).

create table public.daily_themes (
  day        date primary key,
  slug       text not null,
  title      text not null,  title_de  text,
  intro      text not null,  intro_de  text,
  outro      text,           outro_de  text,
  updated_at timestamptz not null default now()
);
create table public.daily_theme_cards (
  day        date not null references public.daily_themes(day) on delete cascade,
  position   int  not null check (position between 0 and 30),
  card_id    text not null references public.cards(id),
  chapter    text,  chapter_de text,
  credit     text,                                   -- photo credit, shown with the picture
  primary key (day, position)
);
alter table public.daily_themes enable row level security;
alter table public.daily_theme_cards enable row level security;
revoke all on public.daily_themes, public.daily_theme_cards from anon, authenticated;

-- _ensure_daily() from 009: a theme (start card + 3 to 30 cards, positions
-- 0..n without gaps) replaces the random deal; the game gets n cards
create or replace function public._ensure_daily(p_date date) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid; n int; themed boolean;
begin
  select id into gid from games where challenge_date = p_date;
  if gid is not null then return gid; end if;
  select count(*) - 1 into n from daily_theme_cards where day = p_date;
  themed := n between 3 and 30
            and (select max(position) from daily_theme_cards where day = p_date) = n;
  if not themed then n := 10; end if;
  insert into games (kind, status, card_count, cards_per_turn, max_players, challenge_date,
                     current_turn, started_at, turn_started_at, turn_deadline)
  values ('daily', 'playing', n, n, 1000000, p_date,
          1, _day_start(p_date), _day_start(p_date), _day_start(p_date + 1))
  on conflict (challenge_date) do nothing
  returning id into gid;
  if gid is null then                                   -- someone else created it a moment ago
    select id into gid from games where challenge_date = p_date;
    return gid;
  end if;
  if themed then
    insert into game_cards (game_id, position, card_id, artist_options)
    select gid, tc.position, tc.card_id, case when tc.position > 0 then _artist_options(c) else '{}' end
      from daily_theme_cards tc join cards c on c.id = tc.card_id
     where tc.day = p_date;
  else
    perform _deal(gid,
      array(select gc.card_id from game_cards gc join games g on g.id = gc.game_id
             where g.kind = 'daily' and g.challenge_date between p_date - 60 and p_date - 1),
      null);                                   -- the daily always uses the whole deck (themes are for runs)
  end if;
  return gid;
end $$;

-- The story of today's daily, as far as I'm allowed to see it:
-- title + intro always; the chapter (and photo credit) of each card I have
-- answered; the outro once I'm done. null on days without a theme.
create function public.daily_story(p_date date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := _me();
  d   date := coalesce(p_date, _today());
  th  daily_themes;
  gid uuid;
  done boolean;
begin
  if d > _today() then return null; end if;              -- no peeking at tomorrow
  select * into th from daily_themes where day = d;
  if th.day is null then return null; end if;
  select id into gid from games where challenge_date = d and kind = 'daily';
  -- only if the game really uses the theme's cards (it may have been dealt before the theme existed)
  if gid is null or exists (select 1 from daily_theme_cards tc
                             where tc.day = d and not exists (select 1 from game_cards gc
                                where gc.game_id = gid and gc.position = tc.position and gc.card_id = tc.card_id)) then
    return null;
  end if;
  done := exists (select 1 from game_players gp where gp.game_id = gid and gp.player_id = me
                    and gp.answered >= (select card_count from games where id = gid))
          or (select status from games where id = gid) = 'finished';
  return jsonb_build_object(
    'date', d, 'slug', th.slug, 'title', th.title, 'title_de', th.title_de,
    'intro', th.intro, 'intro_de', th.intro_de,
    'outro', case when done then th.outro end, 'outro_de', case when done then th.outro_de end,
    'start_credit', (select credit from daily_theme_cards where day = d and position = 0),
    'chapters', (select coalesce(jsonb_agg(jsonb_build_object(
                   'position', tc.position, 'chapter', tc.chapter, 'chapter_de', tc.chapter_de, 'credit', tc.credit)
                   order by tc.position), '[]')
                 from daily_theme_cards tc
                where tc.day = d and tc.position > 0
                  and exists (select 1 from answers a where a.game_id = gid and a.player_id = me
                                and a.position = tc.position and (a.answered_at is not null or a.timed_out))));
end $$;

-- daily_summary() from 003: a story daily can have more or fewer than 10 cards
create or replace function public.daily_summary() returns jsonb
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
    'card_count', (select card_count from games where id = gid),
    'resets_at', _day_start(today + 1),
    'server_now', _now(),
    'status', case when gp.player_id is null then 'not_started'
                   when gp.answered >= (select card_count from games where id = gid) then 'done' else 'in_progress' end,
    'me', board,
    'streak', _daily_streak(me),
    'yesterdays_hardest', hard,
    'month', jsonb_build_object('title', month->'title', 'description', month->'description',
                                'days_left', month->'days_left', 'me', month->'me'));
end $$;

revoke execute on function public.daily_story(date) from public, anon, authenticated;
grant execute on function public.daily_story(date) to authenticated;
