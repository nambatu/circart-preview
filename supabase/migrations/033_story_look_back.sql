-- 033: story dailies that look back (Admin, 22 Nov 2026)
--
-- New way of writing stories: the chapter after a card talks only about THAT
-- card (the one the player just placed), so it can never give away the date of
-- a later card. At the end, the results screen shows every card oldest first
-- with its chapter, so the whole story reads in order.
--
-- daily_themes.look_back marks stories written this way (older stories keep
-- the old "the story goes on" display). The start card can now carry its own
-- chapter: daily_story() returns it as 'start_chapter' (the start card is
-- visible from the beginning, so its chapter is no spoiler).

alter table public.daily_themes add column if not exists look_back boolean not null default false;

create or replace function public.daily_story(p_date date default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me  uuid := public._me();
  d   date := coalesce(p_date, public._today());
  th  public.daily_themes;
  gid uuid;
  done boolean;
begin
  if d > public._today() then return null; end if;       -- no peeking at tomorrow
  select * into th from public.daily_themes where day = d;
  if th.day is null then return null; end if;
  select id into gid from public.games where challenge_date = d and kind = 'daily';
  if gid is null or exists (select 1 from public.daily_theme_cards tc
                             where tc.day = d and not exists (select 1 from public.game_cards gc
                                where gc.game_id = gid and gc.position = tc.position and gc.card_id = tc.card_id)) then
    return null;
  end if;
  done := exists (select 1 from public.game_players gp where gp.game_id = gid and gp.player_id = me
                    and gp.answered >= (select card_count from public.games where id = gid))
          or (select status from public.games where id = gid) = 'finished';
  return jsonb_build_object(
    'date', d, 'slug', th.slug, 'title', th.title, 'title_de', th.title_de,
    'intro', th.intro, 'intro_de', th.intro_de,
    'outro', case when done then th.outro end, 'outro_de', case when done then th.outro_de end,
    'look_back', th.look_back,
    'start_credit', (select credit from public.daily_theme_cards where day = d and position = 0),
    'start_chapter', case when th.look_back then
                       (select chapter from public.daily_theme_cards where day = d and position = 0) end,
    'start_chapter_de', case when th.look_back then
                       (select chapter_de from public.daily_theme_cards where day = d and position = 0) end,
    'chapters', (select coalesce(jsonb_agg(jsonb_build_object(
                   'position', tc.position, 'chapter', tc.chapter, 'chapter_de', tc.chapter_de, 'credit', tc.credit)
                   order by tc.position), '[]')
                 from public.daily_theme_cards tc
                where tc.day = d and tc.position > 0
                  and exists (select 1 from public.answers a where a.game_id = gid and a.player_id = me
                                and a.position = tc.position
                                and (a.timed_out or (a.answered_at is not null and a.artist_done)))));
end $$;

revoke all on function public.daily_story(date) from public, anon;
grant execute on function public.daily_story(date) to authenticated;
