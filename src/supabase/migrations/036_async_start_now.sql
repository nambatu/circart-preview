-- CIRCArt 036 — games over several days start right away (Admin, 26 Nov; task 63).
--
-- Before: an async game waited in a lobby until a second player joined, so both had
-- to be online at the same moment. Now:
--   · the host can start alone and plays turn 1 at once;
--   · anyone with the code, the link or an invite can join while turn 1 is open;
--   · turn 1 closes when everyone who joined has played AND at least two are in,
--     or when its time (24 h) runs out;
--   · if nobody joined by then, the game is cancelled and the host gets a push.
-- Live games are unchanged. No existing rows are changed.

-- an async game still taking players: lobby, or turn 1 still open
create function public._async_open_to_join(g public.games) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select g.kind = 'async'
     and (g.status = 'lobby'
          or (g.status = 'playing' and g.current_turn = 1 and g.turn_closed_at is null
              and public._now() <= g.turn_deadline))
$$;

-- ─── start: async needs only the host ──────────────────────────────────────

create or replace function public.start_game(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); g games;
begin
  select * into g from games where id = p_game for update;
  if g.id is null or g.host_id is distinct from me then raise exception 'not_host'; end if;
  if g.status <> 'lobby' then raise exception 'game_started'; end if;
  if g.kind <> 'async' and (select count(*) from game_players where game_id = g.id) < 2 then
    raise exception 'need_two_players';
  end if;
  perform _deal(g.id, _recent_cards(array(select player_id from game_players where game_id = g.id), 30));
  update games set status = 'playing', started_at = _now() where id = g.id;
  perform _open_turn(g.id, 1);
end $$;

-- ─── join: also during turn 1 of an async game ─────────────────────────────

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
  if g.status <> 'lobby' and not _async_open_to_join(g) then raise exception 'game_started'; end if;
  if (select count(*) from game_players where game_id = g.id) >= g.max_players then raise exception 'game_full'; end if;
  insert into game_players (game_id, player_id, display_name) values (g.id, me, name);
  update games set updated_at = _now() where id = g.id;
  if g.status = 'playing' then perform _push_joined(g.id, me); end if;
  return g.id;
end $$;

-- tell the others that someone joined a running game
create function public._push_joined(p_game uuid, p_new uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  select display_name into v_name from public.game_players where game_id = p_game and player_id = p_new;
  insert into public.push_outbox (player_id, kind, game_id, turn, title, body, url)
  select gp.player_id, 'joined', p_game, -abs(hashtext(p_new::text)),
         case when p.push_lang = 'de' then coalesce(v_name, 'Jemand') || ' spielt mit'
              else coalesce(v_name, 'Someone') || ' joined your game' end,
         case when p.push_lang = 'de' then 'Die erste Runde ist offen. Viel Spaß!'
              else 'Turn 1 is open. Have fun!' end,
         '?game=' || p_game
    from public.game_players gp join public.profiles p on p.id = gp.player_id
   where gp.game_id = p_game and gp.player_id <> p_new and not gp.dropped
     and exists (select 1 from public.push_subscriptions s where s.player_id = gp.player_id)
  on conflict do nothing;
end $$;

-- "joined" counts as a game notification (the "your turn" switch)
create or replace function public._push_allowed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = new.player_id;
  if new.kind in ('turn', 'reminder', 'finished', 'joined', 'nobody_joined') and not coalesce(p.push_turns, true) then return null; end if;
  if new.kind in ('invite', 'new_challenge') and not coalesce(p.push_invites, true) then return null; end if;
  if new.kind = 'daily' and p.push_daily_hour is null then return null; end if;
  return new;
end $$;

-- ─── invites: async games start at once, invited friends join during turn 1 ─

alter function public.invite_friends_to_game(text[], text, int, int) rename to _invite_friends_to_game_032;
revoke execute on function public._invite_friends_to_game_032(text[], text, int, int) from public, anon, authenticated;

create function public.invite_friends_to_game(
  p_usernames text[], p_kind text default 'async', p_card_count int default 12, p_cards_per_turn int default 3
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare res jsonb;
begin
  res := public._invite_friends_to_game_032(p_usernames, p_kind, p_card_count, p_cards_per_turn);
  if p_kind = 'async' then
    perform public.start_game((res->>'game_id')::uuid);
    res := res || jsonb_build_object('started', true);
  end if;
  return res;
end $$;

alter function public.respond_game_invite(uuid, boolean) rename to _respond_game_invite_032;
revoke execute on function public._respond_game_invite_032(uuid, boolean) from public, anon, authenticated;

create function public.respond_game_invite(p_invite_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me(); gi public.game_invites; g public.games; v_name text;
begin
  select * into gi from public.game_invites
   where id = p_invite_id and to_id = me and status = 'pending' and challenge_kind = 'game';
  if gi.id is not null and coalesce(p_accept, false) then
    select * into g from public.games where id = gi.game_id for update;
    if g.id is not null and g.status = 'playing' and public._async_open_to_join(g)
       and not exists (select 1 from public.game_players where game_id = g.id and player_id = me) then
      if (select count(*) from public.game_players where game_id = g.id) >= g.max_players then
        raise exception 'game_full';
      end if;
      select display_name into v_name from public.profiles where id = me;
      insert into public.game_players (game_id, player_id, display_name) values (g.id, me, v_name);
      update public.games set updated_at = public._now() where id = g.id;
      perform public._push_joined(g.id, me);
    end if;
  end if;
  return public._respond_game_invite_032(p_invite_id, p_accept);
end $$;

-- invites to a running async game stay visible while turn 1 is open
create or replace function public.my_game_invites() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me uuid := public._require_friend_account();
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', gi.id,
             'from_username', p.username,
             'challenge_kind', gi.challenge_kind,
             'game_id', gi.game_id,
             'code', g.code,
             'card_count', g.card_count,
             'cards_per_turn', g.cards_per_turn,
             'target_score', gi.target_score,
             'created_at', gi.created_at
           ) order by gi.created_at desc), '[]'::jsonb)
      from public.game_invites gi
      join public.profiles p on p.id = gi.from_id
      left join public.games g on g.id = gi.game_id
     where gi.to_id = me
       and gi.status = 'pending'
       and not p.is_guest
       and p.username is not null
       and not exists (
         select 1 from public.friendships f
          where f.user_low = least(me, gi.from_id)
            and f.user_high = greatest(me, gi.from_id)
            and f.status = 'blocked'
       )
       and (gi.challenge_kind <> 'game' or (g.id is not null and (g.status = 'lobby' or public._async_open_to_join(g))))
  );
end $$;

-- ─── the turn clock ────────────────────────────────────────────────────────
-- Same as 030, plus the async turn-1 joining window.

create or replace function public._tick(p_game uuid) returns public.games
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g      public.games;
  turns  int;
  active int;
  done   int;
  t0     int;
  t1     int;
  joining boolean;
begin
  select * into g from public.games where id = p_game;
  if found and g.kind in ('daily', 'run') and g.status = 'playing'
     and (g.turn_deadline is null or public._now() <= g.turn_deadline) then
    return g;
  end if;

  select * into g from public.games where id = p_game for update;
  if g.id is null or g.status <> 'playing' then return g; end if;
  turns := g.card_count / g.cards_per_turn;

  if g.kind in ('daily', 'run') then
    if public._now() > g.turn_deadline then perform public._finish(g.id); end if;
    select * into g from public.games where id = p_game;
    return g;
  end if;

  -- async turn 1 is the joining window: one player is fine until it closes
  joining := g.kind = 'async' and g.current_turn = 1 and g.turn_closed_at is null;
  select count(*) into active from public.game_players where game_id = g.id and not dropped;

  -- async needs at least two players still in it (after the joining window)
  if g.kind = 'async' and not joining and active < 2 then
    if g.turn_closed_at is null then perform public._close_turn(g.id); end if;
    perform public._finish(g.id);
    select * into g from public.games where id = p_game;
    return g;
  end if;

  if g.turn_closed_at is null then
    t0 := (g.current_turn - 1) * g.cards_per_turn + 1;
    t1 := g.current_turn * g.cards_per_turn;
    select count(*) into done
      from public.answers a join public.game_players gp on gp.game_id = a.game_id and gp.player_id = a.player_id
     where a.game_id = g.id and not gp.dropped and a.position between t0 and t1 and public._is_done(a, g);
    if public._now() <= g.turn_deadline
       and (done < active * g.cards_per_turn or (joining and active < 2)) then
      return g;                                       -- still playing (or still waiting for someone to join)
    end if;
    -- nobody joined in time: cancel and tell the host
    if joining and active < 2 then
      update public.games set status = 'cancelled', turn_closed_at = public._now(), updated_at = public._now()
       where id = g.id;
      update public.game_invites set status = 'expired', responded_at = public._now()
       where game_id = g.id and status = 'pending';
      insert into public.push_outbox (player_id, kind, game_id, turn, title, body, url)
      select gp.player_id, 'nobody_joined', g.id, 1,
             case when p.push_lang = 'de' then 'Niemand ist beigetreten' else 'Nobody joined your game' end,
             case when p.push_lang = 'de' then 'Die Partie ist beendet. Lade gern neu ein, wenn deine Freund:innen Zeit haben.'
                  else 'The game has ended. Invite your friends again when they have time.' end,
             './'
        from public.game_players gp join public.profiles p on p.id = gp.player_id
       where gp.game_id = g.id
         and exists (select 1 from public.push_subscriptions s where s.player_id = gp.player_id)
      on conflict do nothing;
      select * into g from public.games where id = p_game;
      return g;
    end if;
    perform public._close_turn(g.id);
    select * into g from public.games where id = p_game;
  end if;

  -- after a turn: live pauses for the reveal, async moves on at once
  if g.kind = 'live' and public._now() < g.turn_closed_at + make_interval(secs => g.reveal_seconds) then
    return g;
  end if;
  select count(*) into active from public.game_players where game_id = g.id and not dropped;
  if g.current_turn >= turns or (g.kind = 'async' and active < 2) then
    perform public._finish(g.id);
  else
    perform public._open_turn(g.id, g.current_turn + 1);
  end if;
  select * into g from public.games where id = p_game;
  return g;
end $$;

-- ─── rights ────────────────────────────────────────────────────────────────

revoke execute on function public._async_open_to_join(public.games) from public, anon, authenticated;
revoke execute on function public._push_joined(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._push_allowed() from public, anon, authenticated;
revoke execute on function public._tick(uuid) from public, anon, authenticated;
revoke execute on function public.start_game(uuid) from public, anon;
revoke execute on function public.join_game(text, text) from public, anon;
revoke execute on function public.invite_friends_to_game(text[], text, int, int) from public, anon, authenticated;
revoke execute on function public.respond_game_invite(uuid, boolean) from public, anon, authenticated;
grant execute on function public.start_game(uuid) to authenticated;
grant execute on function public.join_game(text, text) to authenticated;
grant execute on function public.invite_friends_to_game(text[], text, int, int) to authenticated;
grant execute on function public.respond_game_invite(uuid, boolean) to authenticated;
