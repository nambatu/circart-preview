-- ============================================================================
-- CIRCArt — foundation: accounts, deck, saved solo games, feedback
--
-- Multiplayer (live rooms, async games, daily/monthly challenges, leaderboards)
-- builds on top of this in later migrations.
--
-- Security model
--   * Clients never read tables they shouldn't. Every table has row-level
--     security switched on, and most access goes through the functions at the
--     bottom, which check who is calling.
--   * The `cards` table is not readable from the app at all. Its public id is
--     a random key with no year in it; the original artline.json id (which
--     starts with the year) is kept in `source_id` for the sync and for solo
--     history only.
-- ============================================================================

-- ─── accounts ───────────────────────────────────────────────────────────────

create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  -- shown in game lobbies and standings; guests pick one when they join a game
  display_name   text not null check (char_length(display_name) between 1 and 24),
  -- unique handle, needed to appear on leaderboards; null until chosen
  username       text check (username ~ '^[A-Za-z0-9_.]{3,20}$'),
  is_guest       boolean not null default true,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create unique index profiles_username_lower on public.profiles (lower(username));

-- ─── the deck ───────────────────────────────────────────────────────────────

create table public.cards (
  id            text primary key,                 -- neutral key, e.g. 'q7m2xk9a'
  source_id     text not null unique,             -- artline.json id (contains the year)
  title         text not null,
  artist        text not null,
  year          int  not null,
  date_note     text,
  movement      text,
  medium        text,
  location      text,
  tier          smallint not null check (tier between 1 and 3),   -- 1 icon · 2 recognisable · 3 obscure
  explicit      boolean not null default false,       -- kept as data; the app shows everything
  visual_type   text not null default 'object',
  image_url     text,                             -- year-free filename
  trivia        text,
  wikidata_qid  text,
  active        boolean not null default true,    -- false once removed from artline.json
  updated_at    timestamptz not null default now()
);

-- ─── saved solo games ───────────────────────────────────────────────────────
-- Solo games are scored on the phone (the game works offline), so these
-- results are personal history and stats only. Leaderboards will use modes
-- the server scores itself.

create table public.solo_games (
  id                  uuid primary key default gen_random_uuid(),
  player_id           uuid not null references public.profiles(id) on delete cascade,
  client_id           uuid not null,              -- made on the phone: re-sending is harmless
  mode                text not null default 'classic',
  rounds              int  not null check (rounds between 1 and 100),
  score               int  not null check (score >= 0),
  placements_correct  int  not null check (placements_correct >= 0),
  bonus_points        int  not null default 0 check (bonus_points >= 0),
  best_streak         int  not null default 0 check (best_streak >= 0),
  started_at          timestamptz,
  finished_at         timestamptz not null,
  created_at          timestamptz not null default now(),
  unique (player_id, client_id)
);
create index solo_games_player_idx on public.solo_games (player_id, finished_at desc);

create table public.solo_game_cards (
  game_id       uuid not null references public.solo_games(id) on delete cascade,
  position      int  not null,                    -- 0 = starting card
  card_id       text not null references public.cards(id),
  correct       boolean,                          -- null for the starting card
  artist_bonus  boolean not null default false,
  title_bonus   boolean not null default false,
  year_bonus    boolean not null default false,
  primary key (game_id, position)
);
create index solo_game_cards_card_idx on public.solo_game_cards (card_id);

-- ─── feedback ───────────────────────────────────────────────────────────────

create table public.feedback (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  player_id       uuid references public.profiles(id) on delete set null,
  topic           text not null check (char_length(topic) between 1 and 60),
  message         text not null check (char_length(message) between 1 and 4000),
  card_source_id  text,                           -- the card on screen, if any
  context         jsonb not null default '{}',    -- round, page, app version, device
  status          text not null default 'new' check (status in ('new','read','done')),
  emailed_at      timestamptz                     -- for the later email notification
);
create index feedback_status_idx on public.feedback (status, created_at desc);

-- ─── row-level security ─────────────────────────────────────────────────────

alter table public.profiles        enable row level security;
alter table public.cards           enable row level security;
alter table public.solo_games      enable row level security;
alter table public.solo_game_cards enable row level security;
alter table public.feedback        enable row level security;

revoke all on public.profiles, public.cards, public.solo_games,
              public.solo_game_cards, public.feedback from anon, authenticated;

grant select on public.profiles, public.solo_games to authenticated;
create policy "own profile"    on public.profiles   for select to authenticated using (id = auth.uid());
create policy "own solo games" on public.solo_games for select to authenticated using (player_id = auth.uid());
-- cards, solo_game_cards, feedback: no client access; functions only.

-- ─── helpers ────────────────────────────────────────────────────────────────

create function public._me() returns uuid
language plpgsql stable set search_path = public as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'not_signed_in'; end if;
  return u;
end $$;

-- ─── account lifecycle ──────────────────────────────────────────────────────

-- Every new sign-in gets a profile. Google supplies a name; guests get "Guest 4821".
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  given text := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name');
begin
  insert into profiles (id, display_name, is_guest)
  values (new.id,
          left(coalesce(nullif(split_part(trim(given), ' ', 1), ''),
                        'Guest ' || lpad((floor(random() * 10000))::int::text, 4, '0')), 24),
          coalesce(new.is_anonymous, false));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- A guest who links Google or an email keeps the same id, so nothing is lost.
create function public.handle_user_upgraded() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(old.is_anonymous, false) and not coalesce(new.is_anonymous, false) then
    update profiles set is_guest = false where id = new.id;
  end if;
  return new;
end $$;
create trigger on_auth_user_upgraded after update on auth.users
  for each row execute function public.handle_user_upgraded();

create function public.get_my_profile() returns jsonb
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  update profiles set last_seen_at = now() where id = _me() returning * into p;
  return jsonb_build_object(
    'display_name', p.display_name, 'username', p.username,
    'is_guest', p.is_guest,
    'needs_username', p.username is null and not p.is_guest);
end $$;

-- Pass only what changes; nulls are left alone.
create function public.update_profile(
  p_display_name text default null, p_username text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := _me();
begin
  if p_display_name is not null and char_length(trim(p_display_name)) not between 1 and 24 then
    raise exception 'display_name_invalid';
  end if;
  if p_username is not null then
    if p_username !~ '^[A-Za-z0-9_.]{3,20}$' then raise exception 'username_invalid'; end if;
    if exists (select 1 from profiles where lower(username) = lower(p_username) and id <> me) then
      raise exception 'username_taken';
    end if;
  end if;
  update profiles set
    display_name  = coalesce(trim(p_display_name), display_name),
    username      = coalesce(p_username, username)
  where id = me;
  return get_my_profile();
end $$;

create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_username ~ '^[A-Za-z0-9_.]{3,20}$'
     and not exists (select 1 from profiles where lower(username) = lower(p_username))
$$;

-- Required by Google Play and Apple: delete the account from inside the app.
-- Feedback stays, but no longer points to the person.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  delete from auth.users where id = _me();
end $$;

-- ─── solo games ─────────────────────────────────────────────────────────────

-- Payload (what app.js sends at the end of a game):
-- { "client_id": "uuid", "mode": "classic", "started_at": "...", "finished_at": "...",
--   "score": 14, "bonus_points": 3, "best_streak": 5,
--   "cards": [ {"id": "1503-leonardo-da-vinci-mona-lisa"},                     -- start card
--              {"id": "...", "correct": true, "artist": true, "title": false, "year": false}, ... ] }
create function public.submit_solo_game(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := _me();
  gid       uuid;
  cards     jsonb := coalesce(p->'cards', '[]');
  n_rounds  int;
  n_correct int;
  unknown   int;
begin
  if jsonb_typeof(cards) <> 'array' or jsonb_array_length(cards) < 2 then raise exception 'bad_game'; end if;
  n_rounds  := jsonb_array_length(cards) - 1;
  n_correct := (select count(*) from jsonb_array_elements(cards) with ordinality c(v, i)
                where i > 1 and (v->>'correct')::boolean);

  -- solo bonuses are worth at most 4 per card (artist 1, title 1, year 2)
  if (p->>'score')::int > n_rounds * 5 or (p->>'bonus_points')::int > n_rounds * 4 then
    raise exception 'bad_game';
  end if;

  insert into solo_games (player_id, client_id, mode, rounds, score, placements_correct,
                          bonus_points, best_streak, started_at, finished_at)
  values (me, (p->>'client_id')::uuid, coalesce(p->>'mode', 'classic'), n_rounds,
          (p->>'score')::int, n_correct, coalesce((p->>'bonus_points')::int, 0),
          coalesce((p->>'best_streak')::int, 0),
          (p->>'started_at')::timestamptz, coalesce((p->>'finished_at')::timestamptz, now()))
  on conflict (player_id, client_id) do nothing
  returning id into gid;

  if gid is null then   -- already saved earlier (offline queue re-sent it)
    select id into gid from solo_games where player_id = me and client_id = (p->>'client_id')::uuid;
    return jsonb_build_object('id', gid, 'duplicate', true);
  end if;

  insert into solo_game_cards (game_id, position, card_id, correct, artist_bonus, title_bonus, year_bonus)
  select gid, (i - 1)::int, k.id,
         case when i = 1 then null else coalesce((v->>'correct')::boolean, false) end,
         coalesce((v->>'artist')::boolean, false),
         coalesce((v->>'title')::boolean, false),
         coalesce((v->>'year')::boolean, false)
  from jsonb_array_elements(cards) with ordinality c(v, i)
  join public.cards k on k.source_id = v->>'id';

  unknown := jsonb_array_length(cards) - (select count(*) from solo_game_cards where game_id = gid);
  return jsonb_build_object('id', gid, 'duplicate', false, 'unknown_cards', unknown);
end $$;

-- Cards this player was dealt recently, on any device. Replaces the 6-hour
-- localStorage memory in app.js. Returns artline.json ids, which the solo game
-- already has locally.
create function public.recently_seen_cards(p_hours int default 168) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct k.source_id), '{}')
  from solo_games g
  join solo_game_cards gc on gc.game_id = g.id
  join cards k on k.id = gc.card_id
  where g.player_id = _me() and g.finished_at > now() - make_interval(hours => p_hours)
$$;

create function public.my_solo_stats() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'games',          count(*),
    'total_score',    coalesce(sum(score), 0),
    'cards_placed',   coalesce(sum(rounds), 0),
    'accuracy',       round(sum(placements_correct)::numeric / nullif(sum(rounds), 0), 3),
    'best_score',     coalesce(max(score), 0),
    'best_streak',    coalesce(max(best_streak), 0),
    'last_played',    max(finished_at))
  from solo_games where player_id = _me()
$$;

-- ─── feedback ───────────────────────────────────────────────────────────────

-- Works signed in or not. Limited to 10 per hour per player to keep spam out.
create function public.submit_feedback(
  p_topic text, p_message text, p_card_source_id text default null, p_context jsonb default '{}')
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  fid bigint;
begin
  if me is not null and (select count(*) from feedback
                         where player_id = me and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_much_feedback';
  end if;
  if me is null and (select count(*) from feedback
                     where player_id is null and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'too_much_feedback';
  end if;
  insert into feedback (player_id, topic, message, card_source_id, context)
  values (me, left(trim(p_topic), 60), trim(p_message), p_card_source_id, coalesce(p_context, '{}'))
  returning id into fid;
  return fid;
end $$;

-- ─── permissions ────────────────────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.get_my_profile(), public.update_profile(text, text),
  public.username_available(text), public.delete_my_account(),
  public.submit_solo_game(jsonb), public.recently_seen_cards(int), public.my_solo_stats(),
  public.submit_feedback(text, text, text, jsonb)
to authenticated;
grant execute on function public.submit_feedback(text, text, text, jsonb) to anon;
