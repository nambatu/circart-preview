-- CIRCArt 023 — a story daily can switch off the bonus questions.
--
-- Julian (14 Nov, after playing the Monet story): the questions after each
-- card ("who painted it?", "which style?") make no sense when every card is by
-- the same painter in the same style. A theme now says whether it asks them:
-- daily_themes.artist_bonus / movement_bonus (default true, as before). The
-- story file sets them with "artist_bonus": false / "movement_bonus": false.
--
-- If a theme switches a question off on its own day (the game is already
-- dealt), the open questions of that day's game are removed as well, so
-- nobody gets them any more.

alter table public.daily_themes add column artist_bonus   boolean not null default true;
alter table public.daily_themes add column movement_bonus boolean not null default true;

-- _ensure_daily() from 019: the game takes the theme's two switches. The
-- triggers from 006 (artist) and 007 (movement) then leave the options empty.
create or replace function public._ensure_daily(p_date date) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid; n int; themed boolean; th daily_themes;
begin
  select id into gid from games where challenge_date = p_date;
  if gid is not null then return gid; end if;
  select count(*) - 1 into n from daily_theme_cards where day = p_date;
  themed := n between 3 and 30
            and (select max(position) from daily_theme_cards where day = p_date) = n;
  if themed then select * into th from daily_themes where day = p_date; else n := 10; end if;
  insert into games (kind, status, card_count, cards_per_turn, max_players, challenge_date,
                     current_turn, started_at, turn_started_at, turn_deadline, artist_bonus, movement_bonus)
  values ('daily', 'playing', n, n, 1000000, p_date,
          1, _day_start(p_date), _day_start(p_date), _day_start(p_date + 1),
          coalesce(th.artist_bonus, true), coalesce(th.movement_bonus, true))
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

-- a switch turned off after the day was dealt: remove that question from the
-- day's game; answers that only waited for it are done
create function public._theme_bonus_off() returns trigger
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if new.artist_bonus and new.movement_bonus then return new; end if;
  select id into gid from games where challenge_date = new.day and kind = 'daily';
  if gid is null then return new; end if;
  update games set artist_bonus = artist_bonus and new.artist_bonus,
                   movement_bonus = movement_bonus and new.movement_bonus
   where id = gid;
  update game_cards set artist_options   = case when new.artist_bonus   then artist_options   else '{}' end,
                        movement_options = case when new.movement_bonus then movement_options else '{}' end
   where game_id = gid;
  update answers a set artist_done = true
    from game_cards gc
   where a.game_id = gid and gc.game_id = gid and gc.position = a.position
     and (a.answered_at is not null or a.timed_out) and not a.artist_done
     and cardinality(gc.artist_options) = 0 and cardinality(gc.movement_options) = 0;
  return new;
end $$;
create trigger daily_themes_bonus_off after insert or update of artist_bonus, movement_bonus on public.daily_themes
  for each row execute function public._theme_bonus_off();

revoke execute on function public._theme_bonus_off() from public, anon, authenticated;
