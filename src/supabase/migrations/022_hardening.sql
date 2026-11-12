-- CIRCArt 022 — hardening after the security review.
--
-- What and why, in plain words:
--   1. Push endpoints: the server only ever sends notifications to the real
--      push services (Google, Mozilla, Apple, Windows). Before, a player could
--      save any https address and make our server call it. Old odd endpoints
--      are removed.
--   2. Join codes have only 4 characters, so someone could try them all.
--      Now 8 wrong codes in 10 minutes block further tries for a while.
--      A wrong code now returns null (an error would undo the note we keep
--      of the failed try); the app turns that into "game not found".
--   3. Lobbies: at most 5 open lobbies per host and 30 new games per hour.
--   4. Solo games: at most 120 per hour per player and at most 101 cards each.
--   5. A search_path for _untimed_seconds and two missing indexes.

-- ─── 1. push endpoints only to real push services ───────────────────────────
create function public._push_host_ok(p_endpoint text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)/', false)
$$;

-- from 005, plus the host check
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _me();
begin
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100
     or not _push_host_ok(p_endpoint) then
    raise exception 'bad_settings';
  end if;
  insert into push_subscriptions (endpoint, player_id, p256dh, auth, user_agent)
  values (p_endpoint, me, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
                                       user_agent = excluded.user_agent
   where push_subscriptions.player_id = me;      -- a device can't be taken over by someone else
  if (select count(*) from push_subscriptions where player_id = me) > 10 then   -- keep the newest 10 devices
    delete from push_subscriptions where endpoint in (
      select endpoint from push_subscriptions where player_id = me order by created_at desc offset 10);
  end if;
end $$;

delete from public.push_subscriptions where not public._push_host_ok(endpoint);

-- from 005 (renamed in 017), plus the host check in the join
create or replace function public._push_batch_unchecked() returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids bigint[];
begin
  -- give up on: messages older than a day, and players with no device left
  update push_outbox o set sent_at = now()
   where sent_at is null and (created_at < now() - interval '1 day'
         or not exists (select 1 from push_subscriptions s where s.player_id = o.player_id));
  delete from push_outbox where sent_at < now() - interval '14 days';
  -- claim up to 200 so two overlapping runs never send the same message
  with c as (
    update push_outbox set claimed_at = now()
     where id in (select id from push_outbox
                   where sent_at is null and (claimed_at is null or claimed_at < now() - interval '5 minutes')
                   order by id limit 200 for update skip locked)
    returning id)
  select coalesce(array_agg(id), '{}') into ids from c;
  return jsonb_build_object(
    'vapid_public',  (select value from private.settings where key = 'vapid_public'),
    'vapid_private', (select value from private.settings where key = 'vapid_private'),
    'vapid_subject', (select value from private.settings where key = 'vapid_subject'),
    'site',          (select value from private.settings where key = 'site'),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object(
               'id', o.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
               'title', o.title, 'body', o.body, 'url', o.url, 'tag', o.kind || '-' || o.game_id)), '[]')
             from (select * from push_outbox where id = any(ids)) o
             join push_subscriptions s on s.player_id = o.player_id and _push_host_ok(s.endpoint)));
end $$;

-- ─── 2. join-code guessing ──────────────────────────────────────────────────
create table public.join_failures (
  player_id uuid not null references auth.users(id) on delete cascade,
  at        timestamptz not null default now()
);
create index join_failures_player_idx on public.join_failures (player_id, at);
alter table public.join_failures enable row level security;
revoke all on public.join_failures from anon, authenticated;

-- from 002: too many wrong codes are refused; a wrong code returns null
create or replace function public.join_game(p_code text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := _me();
  name  text;
  g     games;
begin
  if (select count(*) from join_failures where player_id = me and at > now() - interval '10 minutes') >= 8 then
    raise exception 'too_many_tries';
  end if;
  name := _set_display_name(p_display_name);
  select * into g from games where code = upper(trim(p_code)) and status in ('lobby','playing') for update;
  if g.id is null then
    insert into join_failures (player_id) values (me);
    return null;
  end if;
  if exists (select 1 from game_players where game_id = g.id and player_id = me) then return g.id; end if;
  if g.status <> 'lobby' then raise exception 'game_started'; end if;
  if (select count(*) from game_players where game_id = g.id) >= g.max_players then raise exception 'game_full'; end if;
  insert into game_players (game_id, player_id, display_name) values (g.id, me, name);
  update games set updated_at = _now() where id = g.id;
  return g.id;
end $$;

-- from 011, plus the clean-up of old failed tries
create or replace function public.privacy_cleanup(
  p_guest_idle      interval default '6 months',
  p_push_idle       interval default '6 months',
  p_feedback_strip  interval default '90 days',
  p_feedback_done   interval default '12 months',
  p_feedback_max    interval default '24 months')
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  t   timestamptz := _now();
  n_guests int; n_push int; n_outbox int; n_lobby int; n_orphan int; n_fb_strip int; n_fb_del int;
begin
  -- idle guest accounts (no email, no Google) and everything in them
  with idle as (
    select p.id from profiles p
     where p.is_guest and coalesce(_last_active(p.id), p.created_at) < t - p_guest_idle)
  delete from auth.users u using idle where u.id = idle.id and coalesce(u.is_anonymous, true);
  get diagnostics n_guests = row_count;

  delete from push_subscriptions s
   where coalesce(_last_active(s.player_id), s.created_at) < t - p_push_idle;
  get diagnostics n_push = row_count;

  delete from push_outbox
   where sent_at < t - interval '14 days'
      or (sent_at is null and created_at < t - interval '2 days');
  get diagnostics n_outbox = row_count;

  delete from games
   where (status = 'lobby' and created_at < t - interval '7 days')
      or (status = 'cancelled' and created_at < t - interval '30 days');
  get diagnostics n_lobby = row_count;

  delete from games g
   where g.kind <> 'daily' and g.created_at < t - interval '1 day'
     and not exists (select 1 from game_players where game_id = g.id);
  get diagnostics n_orphan = row_count;

  update feedback set context = context - 'ua' - 'page'
   where created_at < t - p_feedback_strip and (context ? 'ua' or context ? 'page');
  get diagnostics n_fb_strip = row_count;

  delete from feedback
   where (status = 'done' and created_at < t - p_feedback_done)
      or created_at < t - p_feedback_max;
  get diagnostics n_fb_del = row_count;

  delete from join_failures where at < t - interval '1 day';

  return jsonb_build_object('guests_deleted', n_guests, 'push_devices_removed', n_push,
    'push_messages_deleted', n_outbox, 'stale_games_deleted', n_lobby, 'empty_games_deleted', n_orphan,
    'feedback_stripped', n_fb_strip, 'feedback_deleted', n_fb_del);
end $$;

-- ─── 3. unlimited lobbies ───────────────────────────────────────────────────
-- from 002, plus the two limits
create or replace function public.create_game(
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
  if (select count(*) from games where host_id = me and status = 'lobby') >= 5
     or (select count(*) from games where host_id = me and created_at > _now() - interval '1 hour') >= 30 then
    raise exception 'too_many_games';
  end if;
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

-- ─── 4. solo-game spam ──────────────────────────────────────────────────────
-- from 001, plus the two limits
create or replace function public.submit_solo_game(p jsonb) returns jsonb
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
  if (select count(*) from solo_games where player_id = me and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'too_many_games';
  end if;
  if jsonb_array_length(cards) > 101 then raise exception 'bad_game'; end if;
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

-- ─── 5. search_path and indexes ─────────────────────────────────────────────
alter function public._untimed_seconds(text) set search_path = public;

create index if not exists daily_theme_cards_card_idx on public.daily_theme_cards (card_id);
create index if not exists player_packs_pack_idx on public.player_packs (pack_id);

-- ─── permissions ────────────────────────────────────────────────────────────
revoke execute on function public._push_host_ok(text), public._push_batch_unchecked(),
  public.save_push_subscription(text, text, text, text), public.join_game(text, text),
  public.create_game(text, int, int, text), public.submit_solo_game(jsonb),
  public.privacy_cleanup(interval, interval, interval, interval, interval)
  from public, anon, authenticated;
grant execute on function public.save_push_subscription(text, text, text, text),
  public.join_game(text, text), public.create_game(text, int, int, text), public.submit_solo_game(jsonb)
  to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public._push_batch_unchecked() from service_role;
    grant execute on function public.privacy_cleanup(interval, interval, interval, interval, interval) to service_role;
  end if;
end $$;
