-- CIRCArt 011 — privacy (GDPR / DSGVO) and the security-advisor fixes.
--
-- 1. export_my_data()     Art. 15 + 20: everything stored about the caller,
--                         as one JSON document (for a "Download my data" button).
-- 2. delete_my_account()  Art. 17: same call as before, now also removes the
--                         caller's one-player games (runs) and lobbies nobody
--                         else joined, cancels lobbies they host, and strips
--                         device details from feedback they sent (the message
--                         itself stays, no longer linked to anyone).
-- 3. submit_feedback()    keeps only the context fields the app needs, drops
--                         ?query and #hash from the page URL (a sign-in link can
--                         carry tokens there), caps sizes, and adds a daily cap
--                         for feedback sent without an account.
-- 4. privacy_cleanup()    Art. 5(1)(e) storage limitation. Run daily by cron:
--                           select cron.schedule('circart-privacy-cleanup', '17 3 * * *',
--                                                'select public.privacy_cleanup()');
--                         · guest accounts idle for 6 months   → deleted (with everything)
--                         · push devices of players idle 6 months → removed
--                         · sent push messages after 14 days, unsent after 2 days → deleted
--                         · lobbies never started, after 7 days; cancelled games after 30 days → deleted
--                         · games nobody is in any more (not dailies) → deleted
--                         · feedback: device + page dropped after 90 days,
--                           deleted 12 months after it's marked done, 24 months at the latest
-- 5. Security advisor: fixed search_path on six helpers; RLS policies use
--    (select auth.uid()); indexes on foreign keys (also makes account
--    deletion fast, it cascades through answers / feedback / games).

-- ─── 5. advisor fixes ───────────────────────────────────────────────────────

alter function public._now()                                   set search_path = public, pg_temp;
alter function public._grace()                                 set search_path = public, pg_temp;
alter function public._turn_of(public.games, int)              set search_path = public, pg_temp;
alter function public._is_done(public.answers, public.games)   set search_path = public, pg_temp;
alter function public._today()                                 set search_path = public, pg_temp;
alter function public._day_start(date)                         set search_path = public, pg_temp;

drop policy "own profile" on public.profiles;
create policy "own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy "own solo games" on public.solo_games;
create policy "own solo games" on public.solo_games for select to authenticated using (player_id = (select auth.uid()));

create index if not exists answers_player_idx     on public.answers (player_id);
create index if not exists feedback_player_idx    on public.feedback (player_id);
create index if not exists games_host_idx         on public.games (host_id);
create index if not exists games_rematch_idx      on public.games (rematch_id);
create index if not exists push_outbox_game_idx   on public.push_outbox (game_id);
create index if not exists game_cards_card_idx    on public.game_cards (card_id);

-- ─── helpers ────────────────────────────────────────────────────────────────

-- last sign of life of a player: profile opened, game joined, card answered, solo game saved
create function public._last_active(p_player uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select greatest(
    (select last_seen_at from profiles where id = p_player),
    (select max(joined_at) from game_players where player_id = p_player),
    (select max(coalesce(answered_at, shown_at)) from answers where player_id = p_player),
    (select max(created_at) from solo_games where player_id = p_player))
$$;

-- ─── 1. export ──────────────────────────────────────────────────────────────

create function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := _me();
  acct      jsonb;
  idents    jsonb := '[]';
begin
  -- the sign-in account: only the fields that describe the person (no tokens, no password hash)
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
    'profile', (select to_jsonb(p) from profiles p where p.id = me),

    'solo_games', (select coalesce(jsonb_agg((to_jsonb(g) - 'player_id') || jsonb_build_object(
                      'cards', (select coalesce(jsonb_agg(jsonb_build_object(
                                  'position', gc.position, 'card', k.source_id, 'title', k.title,
                                  'artist', k.artist, 'year', k.year, 'correct', gc.correct,
                                  'artist_bonus', gc.artist_bonus, 'title_bonus', gc.title_bonus,
                                  'year_bonus', gc.year_bonus) order by gc.position), '[]')
                                from solo_game_cards gc join cards k on k.id = gc.card_id
                               where gc.game_id = g.id))
                    order by g.finished_at), '[]')
                  from solo_games g where g.player_id = me),

    -- online games: the game, my place in it and my answers. Other players'
    -- names and answers are their data, not mine (Art. 15(4)), so not included.
    'games', (select coalesce(jsonb_agg(jsonb_build_object(
                 'game', jsonb_build_object('id', g.id, 'kind', g.kind, 'code', g.code, 'status', g.status,
                                            'created_at', g.created_at, 'started_at', g.started_at,
                                            'finished_at', g.finished_at, 'challenge_date', g.challenge_date,
                                            'run_month', g.run_month, 'i_was_host', g.host_id = me),
                 'me', to_jsonb(gp) - 'player_id' - 'game_id',
                 'answers', (select coalesce(jsonb_agg((to_jsonb(a) - 'player_id' - 'game_id') ||
                                case when g.status in ('finished', 'cancelled') then
                                  (select jsonb_build_object('card_title', k.title, 'card_artist', k.artist, 'card_year', k.year)
                                     from game_cards gc join cards k on k.id = gc.card_id
                                    where gc.game_id = g.id and gc.position = a.position)
                                else '{}' end
                               order by a.position), '[]')
                              from answers a where a.game_id = g.id and a.player_id = me))
               order by g.created_at), '[]')
              from game_players gp join games g on g.id = gp.game_id where gp.player_id = me),

    'feedback', (select coalesce(jsonb_agg(to_jsonb(f) - 'player_id' - 'emailed_at' order by f.created_at), '[]')
                   from feedback f where f.player_id = me),

    -- push devices: the device address and browser; the encryption keys are left out
    'push_devices', (select coalesce(jsonb_agg(jsonb_build_object(
                        'endpoint', s.endpoint, 'user_agent', s.user_agent, 'created_at', s.created_at)
                        order by s.created_at), '[]')
                       from push_subscriptions s where s.player_id = me),
    'push_messages', (select coalesce(jsonb_agg(jsonb_build_object(
                         'kind', o.kind, 'title', o.title, 'body', o.body, 'created_at', o.created_at,
                         'sent_at', o.sent_at) order by o.created_at), '[]')
                        from push_outbox o where o.player_id = me),

    'stored_on_this_device', 'The app also keeps settings (language, theme, onboarding seen, '
      || 'unsent solo games, sign-in session) in your browser''s local storage. '
      || 'They never leave your device except the session, which signs you in.');
end $$;

-- ─── 2. delete ──────────────────────────────────────────────────────────────

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := _me();
begin
  -- lobbies I host that others joined can't start without me
  update games set status = 'cancelled', updated_at = now() where host_id = me and status = 'lobby';
  -- games only I am in (my runs, lobbies nobody joined): nothing in them for anyone else
  delete from games g
   where g.kind <> 'daily'
     and exists (select 1 from game_players where game_id = g.id and player_id = me)
     and not exists (select 1 from game_players where game_id = g.id and player_id <> me);
  delete from push_outbox where player_id = me;
  delete from push_subscriptions where player_id = me;
  -- feedback stays (it's about the game), but without the device and no longer linked to me
  update feedback set player_id = null, context = context - 'ua' - 'page' where player_id = me;
  -- the rest (profile, solo games, places in games, answers) goes with the account
  delete from auth.users where id = me;
end $$;

-- ─── 3. feedback ────────────────────────────────────────────────────────────

create or replace function public.submit_feedback(
  p_topic text, p_message text, p_card_source_id text default null, p_context jsonb default '{}')
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := auth.uid();
  c   jsonb := case when jsonb_typeof(p_context) = 'object' then p_context else '{}' end;
  ctx jsonb;
  fid bigint;
begin
  if me is not null and (select count(*) from feedback
                         where player_id = me and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_much_feedback';
  end if;
  if me is null and ((select count(*) from feedback
                      where player_id is null and created_at > now() - interval '1 minute') >= 20
                  or (select count(*) from feedback
                      where player_id is null and created_at > now() - interval '1 day') >= 300) then
    raise exception 'too_much_feedback';
  end if;
  if p_card_source_id is not null and char_length(p_card_source_id) > 120 then
    raise exception 'bad_feedback';
  end if;
  ctx := jsonb_strip_nulls(jsonb_build_object(
    'round', case when jsonb_typeof(c->'round') = 'number' then c->'round' end,
    'page',  nullif(left(split_part(split_part(c->>'page', '#', 1), '?', 1), 300), ''),
    'ua',    left(c->>'ua', 200),
    'app',   left(c->>'app', 40)));
  insert into feedback (player_id, topic, message, card_source_id, context)
  values (me, left(trim(p_topic), 60), trim(p_message), p_card_source_id, ctx)
  returning id into fid;
  return fid;
end $$;

-- ─── 4. retention ───────────────────────────────────────────────────────────

create function public.privacy_cleanup(
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

  return jsonb_build_object('guests_deleted', n_guests, 'push_devices_removed', n_push,
    'push_messages_deleted', n_outbox, 'stale_games_deleted', n_lobby, 'empty_games_deleted', n_orphan,
    'feedback_stripped', n_fb_strip, 'feedback_deleted', n_fb_del);
end $$;

-- ─── permissions ────────────────────────────────────────────────────────────

revoke execute on function public._last_active(uuid), public.export_my_data(),
  public.privacy_cleanup(interval, interval, interval, interval, interval)
  from public, anon, authenticated;
grant execute on function public.export_my_data() to authenticated;
-- delete_my_account and submit_feedback keep their grants (create or replace keeps them)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.privacy_cleanup(interval, interval, interval, interval, interval) to service_role;
  end if;
end $$;
