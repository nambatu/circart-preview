-- CIRCArt 035 — notification settings, daily reminder, review follow-ups (Admin, 26 Nov; tasks 60 + 62).
--
-- 1. One switch per kind of notification (privacy checklist): your turn in games with
--    friends, invitations and score challenges, and the new daily reminder.
--    Turn and invite pushes stay on for people who already allowed notifications
--    (that is what they agreed to); the daily reminder is off until a player picks a time.
-- 2. Daily reminder: at most one push a day, at the hour the player picked (their own
--    time zone from 034, Vienna if unknown), only if today's daily isn't played yet.
-- 3. Review follow-ups (task 60): reactions and calls in "Download my data", a 7-day
--    pause after a friend request was declined, and score challenges use the real score.
-- No existing rows are changed: new columns get defaults, new table starts empty.

-- ─── 1. switches ───────────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists push_turns   boolean not null default true,
  add column if not exists push_invites boolean not null default true,
  add column if not exists push_daily_hour smallint check (push_daily_hour between 0 and 23),
  add column if not exists push_lang    text check (push_lang in ('en', 'de'));

create function public.my_push_settings() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('turns', p.push_turns, 'invites', p.push_invites,
                            'daily_hour', p.push_daily_hour, 'lang', p.push_lang)
    from public.profiles p where p.id = public._me()
$$;

-- p_daily_hour: 0–23, or null for "no daily reminder"
create function public.set_push_settings(p_turns boolean, p_invites boolean, p_daily_hour int, p_lang text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me();
begin
  if p_daily_hour is not null and (p_daily_hour < 0 or p_daily_hour > 23) then
    raise exception 'bad_settings';
  end if;
  update public.profiles
     set push_turns = coalesce(p_turns, push_turns),
         push_invites = coalesce(p_invites, push_invites),
         push_daily_hour = p_daily_hour,
         push_lang = case when p_lang in ('en', 'de') then p_lang else push_lang end
   where id = me;
end $$;

-- every queued message passes this filter, whichever function queued it
create function public._push_allowed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = new.player_id;
  if new.kind in ('turn', 'reminder', 'finished') and not coalesce(p.push_turns, true) then return null; end if;
  if new.kind in ('invite', 'new_challenge') and not coalesce(p.push_invites, true) then return null; end if;
  if new.kind = 'daily' and p.push_daily_hour is null then return null; end if;
  return new;
end $$;
create trigger push_outbox_allowed before insert on public.push_outbox
  for each row execute function public._push_allowed();

-- ─── 2. daily reminder (cron every 15 minutes) ─────────────────────────────

create function public.queue_daily_reminders() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day  date := public._today();
  v_key  int  := to_char(public._today(), 'YYYYMMDD')::int;
  v_game uuid;
  n int;
begin
  select id into v_game from public.games where kind = 'daily' and challenge_date = v_day;
  insert into public.push_outbox (player_id, kind, game_id, turn, title, body, url)
  select p.id, 'daily', null, v_key,
         case when p.push_lang = 'de' then 'Die Daily wartet 🎨' else 'Today''s daily is waiting 🎨' end,
         case when p.push_lang = 'de' then 'Ein paar Minuten, ein paar Bilder. Wo gehören sie auf den Zeitstrahl?'
              else 'A few minutes, a few paintings. Where do they go on the timeline?' end,
         './'
    from public.profiles p
   where p.push_daily_hour is not null
     and p.push_daily_hour = extract(hour from public._now() at time zone coalesce(p.time_zone, 'Europe/Vienna'))
     and exists (select 1 from public.push_subscriptions s where s.player_id = p.id)
     and not exists (select 1 from public.game_players gp
                      where gp.game_id = v_game and gp.player_id = p.id and gp.answered > 0)
     and not exists (select 1 from public.push_outbox o
                      where o.player_id = p.id and o.kind = 'daily' and o.turn = v_key);
  get diagnostics n = row_count;
  return n;
end $$;

-- ─── 3a. "Download my data": reactions, calls, notification settings ───────
-- (the profile with the new columns is already in it; the rest is added here)

alter function public.export_my_data() rename to _export_my_data_034;
revoke execute on function public._export_my_data_034() from public, anon, authenticated;

create function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me();
begin
  return public._export_my_data_034() || jsonb_build_object(
    'game_reactions', (select coalesce(jsonb_agg(jsonb_build_object(
                          'game_id', r.game_id, 'turn', r.turn, 'emoji', r.emoji, 'created_at', r.created_at)
                          order by r.created_at), '[]') from public.game_reactions r where r.from_id = me),
    'game_calls', (select coalesce(jsonb_agg(jsonb_build_object(
                      'game_id', c.game_id, 'position', c.position, 'predicted_right', c.predict_ok,
                      'points', c.awarded, 'created_at', c.created_at)
                      order by c.created_at), '[]') from public.game_calls c where c.caller_id = me),
    'friend_requests_you_declined', (select coalesce(jsonb_agg(jsonb_build_object('declined_at', d.declined_at)
                      order by d.declined_at), '[]') from public.friend_declines d where d.target_id = me));
end $$;

-- ─── 3b. 7 days pause after a declined friend request ──────────────────────

create table public.friend_declines (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  target_id    uuid not null references public.profiles(id) on delete cascade,
  declined_at  timestamptz not null default public._now(),
  primary key (requester_id, target_id)
);
alter table public.friend_declines enable row level security;
revoke all on public.friend_declines from anon, authenticated;

alter function public.send_friend_request(text) rename to _send_friend_request_032;
revoke execute on function public._send_friend_request_032(text) from public, anon, authenticated;
alter function public.respond_friend_request(text, boolean) rename to _respond_friend_request_032;
revoke execute on function public._respond_friend_request_032(text, boolean) from public, anon, authenticated;

create function public.send_friend_request(p_username text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me(); v_target uuid;
begin
  delete from public.friend_declines where declined_at < public._now() - interval '7 days';
  select id into v_target from public.profiles
   where lower(username) = lower(nullif(trim(p_username), '')) and not is_guest;
  if v_target is not null and exists (select 1 from public.friend_declines
                                       where requester_id = me and target_id = v_target) then
    raise exception 'friend_cooldown';
  end if;
  return public._send_friend_request_032(p_username);
end $$;

create function public.respond_friend_request(p_username text, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me(); res jsonb; v_from uuid;
begin
  res := public._respond_friend_request_032(p_username, p_accept);
  if res->>'status' = 'declined' then
    select id into v_from from public.profiles
     where lower(username) = lower(nullif(trim(p_username), '')) and not is_guest;
    if v_from is not null then
      insert into public.friend_declines (requester_id, target_id) values (v_from, me)
      on conflict (requester_id, target_id) do update set declined_at = public._now();
    end if;
  end if;
  return res;
end $$;

-- ─── 3c. score challenges use the score the server knows ───────────────────

alter function public.send_score_challenge(text, text, int) rename to _send_score_challenge_032;
revoke execute on function public._send_score_challenge_032(text, text, int) from public, anon, authenticated;

create function public.send_score_challenge(p_username text, p_mode text, p_score int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_real int;
begin
  v_real := case p_mode
    when 'daily_score' then nullif(public.daily_summary()->'me'->>'score', '')::numeric::int
    when 'run_score'   then nullif(public.run_summary()->>'best', '')::numeric::int
    when 'price_score' then nullif(public.price_summary()->>'best', '')::numeric::int
  end;
  if v_real is null then
    raise exception 'bad_settings';
  end if;
  return public._send_score_challenge_032(p_username, p_mode, v_real);
end $$;

-- ─── rights ────────────────────────────────────────────────────────────────

revoke execute on function public.my_push_settings() from public, anon, authenticated;
revoke execute on function public.set_push_settings(boolean, boolean, int, text) from public, anon, authenticated;
revoke execute on function public._push_allowed() from public, anon, authenticated;
revoke execute on function public.queue_daily_reminders() from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
revoke execute on function public.send_friend_request(text) from public, anon, authenticated;
revoke execute on function public.respond_friend_request(text, boolean) from public, anon, authenticated;
revoke execute on function public.send_score_challenge(text, text, int) from public, anon, authenticated;

grant execute on function public.my_push_settings() to authenticated;
grant execute on function public.set_push_settings(boolean, boolean, int, text) to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_friend_request(text, boolean) to authenticated;
grant execute on function public.send_score_challenge(text, text, int) to authenticated;
