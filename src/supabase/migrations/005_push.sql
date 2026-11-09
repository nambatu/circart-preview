-- CIRCArt 005 — push notifications for async games.
--
-- The app saves a Web Push subscription per device (save_push_subscription).
-- The database queues messages in push_outbox:
--   · a new async turn opens            → "Your turn"   (everyone still in)
--   · 3 h before an async turn closes   → "Closes in 3 h" (only if you haven't played)
--   · an async game ends                → "Game over · you came #2"
-- A Supabase Edge Function ("send-push") empties the queue every minute.
-- It calls push_batch() / push_done(), which only the service role may run.
-- Settings that must stay private (the VAPID private key) live in
-- private.settings, which the API cannot reach.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.settings (key text primary key, value text not null);

create table public.push_subscriptions (
  endpoint    text primary key,
  player_id   uuid not null references public.profiles(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index push_subscriptions_player on public.push_subscriptions (player_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create table public.push_outbox (
  id          bigint generated always as identity primary key,
  player_id   uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,                -- turn · reminder · finished
  game_id     uuid references public.games(id) on delete cascade,
  turn        int,
  title       text not null,
  body        text not null,
  url         text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  claimed_at  timestamptz,                  -- handed to a sender (another run won't take it for 5 min)
  unique (player_id, game_id, kind, turn)   -- never the same message twice
);
create index push_outbox_due on public.push_outbox (id) where sent_at is null;
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from anon, authenticated;

-- ─── the app ────────────────────────────────────────────────────────────────

create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _me();
begin
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100 then
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

create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and player_id = _me()
$$;

create function public.push_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from push_subscriptions where player_id = _me())
$$;

-- ─── queueing ───────────────────────────────────────────────────────────────

create function public._others(p_game uuid, p_player uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when count(*) = 0 then 'your friends'
              when count(*) <= 2 then string_agg(display_name, ' & ' order by joined_at)
              else (array_agg(display_name order by joined_at))[1] || ', '
                || (array_agg(display_name order by joined_at))[2] || ' +' || (count(*) - 2) end
    from game_players where game_id = p_game and player_id <> p_player
$$;

create function public._queue(p_player uuid, p_kind text, p_game uuid, p_turn int, p_title text, p_body text)
returns void language sql security definer set search_path = public as $$
  insert into push_outbox (player_id, kind, game_id, turn, title, body, url)
  select p_player, p_kind, p_game, p_turn, p_title, p_body, '?game=' || p_game
   where exists (select 1 from push_subscriptions where player_id = p_player)
  on conflict do nothing
$$;

-- a new async turn opened (turn 1 = the game started)
create function public._push_on_turn() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if new.kind = 'async' and new.status = 'playing' and new.current_turn is distinct from old.current_turn then
    for p in select player_id from game_players where game_id = new.id and not dropped loop
      perform _queue(p.player_id, 'turn', new.id, new.current_turn,
        'Your turn in CIRCArt',
        'Turn ' || new.current_turn || ' of ' || (new.card_count / new.cards_per_turn)
          || ' with ' || _others(new.id, p.player_id) || ' is open. You have '
          || new.turn_hours || ' h.');
    end loop;
  end if;
  return null;
end $$;
create trigger games_push_turn after update of current_turn, status on public.games
  for each row execute function public._push_on_turn();

-- an async game ended (final ranks are written just after the status)
create function public._push_on_finish() returns trigger
language plpgsql security definer set search_path = public as $$
declare g games;
begin
  if new.final_rank is not null and old.final_rank is null then
    select * into g from games where id = new.game_id;
    if g.kind = 'async' then
      perform _queue(new.player_id, 'finished', g.id, 0,
        case when new.final_rank = 1 then 'You won! 🏆' else 'Game over · you came #' || new.final_rank end,
        'Your game with ' || _others(g.id, new.player_id) || ' is finished. See the final timeline.');
    end if;
  end if;
  return null;
end $$;
create trigger game_players_push_finish after update of final_rank on public.game_players
  for each row execute function public._push_on_finish();

-- reminders: run every few minutes (cron); 3 h before an async turn closes,
-- for everyone who still has cards to play this turn
create function public.queue_turn_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare g record; p record; n int := 0;
begin
  for g in select * from games
            where kind = 'async' and status = 'playing'
              and turn_deadline between _now() and _now() + interval '3 hours'
              and turn_started_at < _now() - interval '1 hour' loop
    for p in select gp.player_id from game_players gp
              where gp.game_id = g.id and not gp.dropped
                and exists (select 1 from generate_series((g.current_turn - 1) * g.cards_per_turn + 1,
                                                          g.current_turn * g.cards_per_turn) q
                             where not exists (select 1 from answers a where a.game_id = g.id
                                                 and a.player_id = gp.player_id and a.position = q
                                                 and (a.answered_at is not null or a.timed_out))) loop
      perform _queue(p.player_id, 'reminder', g.id, g.current_turn,
        'Your turn closes soon',
        'Turn ' || g.current_turn || ' with ' || _others(g.id, p.player_id)
          || ' closes in under 3 h. Two minutes is all it takes.');
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- ─── sending (Edge Function, service role only) ─────────────────────────────

-- Up to 200 queued messages, one row per device, plus the VAPID keys.
-- Messages older than a day are dropped instead of sent late.
create function public.push_batch() returns jsonb
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
             join push_subscriptions s on s.player_id = o.player_id));
end $$;

-- p_ids: messages handled; p_gone: endpoints the push service says no longer exist
create function public.push_done(p_ids bigint[], p_gone text[]) returns void
language sql security definer set search_path = public as $$
  update push_outbox set sent_at = now() where id = any(p_ids);
  delete from push_subscriptions where endpoint = any(p_gone);
$$;

-- is there anything to send? (cron asks before calling the Edge Function)
create function public._push_pending() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from push_outbox where sent_at is null
                  and (claimed_at is null or claimed_at < now() - interval '5 minutes'))
$$;

revoke execute on function
  public.save_push_subscription(text, text, text, text), public.remove_push_subscription(text),
  public.push_enabled(), public._others(uuid, uuid), public._queue(uuid, text, uuid, int, text, text),
  public._push_on_turn(), public._push_on_finish(), public.queue_turn_reminders(),
  public.push_batch(), public.push_done(bigint[], text[]), public._push_pending()
  from public, anon, authenticated;
grant execute on function
  public.save_push_subscription(text, text, text, text), public.remove_push_subscription(text),
  public.push_enabled()
  to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant execute on function public.push_batch(), public.push_done(bigint[], text[]) to service_role;
  end if;
end $$;
