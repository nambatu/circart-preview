-- CIRCArt 032 — Wave 2: Live Waiting Room, Call-It (+25), Reactions, Round Results (Task 32)
--                 and Friendships, Friend Profiles, Friends Leaderboards, Challenges & Game Invites (Tasks 33 & 44).

-- ─── 1. Task 32 tables ───────────────────────────────────────────────────────

create table public.game_reactions (
  id         bigint generated always as identity primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  turn       int  not null,
  from_id    uuid not null references public.profiles(id) on delete cascade,
  to_id      uuid references public.profiles(id) on delete cascade,
  emoji      text not null check (emoji in ('🎨','👏','😮','😅','🔥')),
  created_at timestamptz not null default public._now()
);
create index game_reactions_game_turn_idx on public.game_reactions (game_id, turn, id desc);
create index game_reactions_from_idx      on public.game_reactions (from_id);
create index game_reactions_to_idx        on public.game_reactions (to_id);
alter table public.game_reactions enable row level security;
revoke all on public.game_reactions from anon, authenticated;

create table public.game_calls (
  game_id    uuid not null references public.games(id) on delete cascade,
  position   int  not null,
  caller_id  uuid not null references public.profiles(id) on delete cascade,
  target_id  uuid not null references public.profiles(id) on delete cascade,
  predict_ok boolean not null,
  awarded    int  not null default 0,
  scored     boolean not null default false,
  created_at timestamptz not null default public._now(),
  primary key (game_id, position, caller_id, target_id),
  check (caller_id <> target_id)
);
create index game_calls_caller_idx on public.game_calls (caller_id);
create index game_calls_target_idx on public.game_calls (target_id);
alter table public.game_calls enable row level security;
revoke all on public.game_calls from anon, authenticated;

-- ─── 2. Tasks 33 & 44 tables ─────────────────────────────────────────────────

create table public.friendships (
  user_low     uuid not null references public.profiles(id) on delete cascade,
  user_high    uuid not null references public.profiles(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  blocked_by   uuid references public.profiles(id) on delete cascade,
  status       text not null check (status in ('pending', 'accepted', 'blocked')),
  created_at   timestamptz not null default public._now(),
  updated_at   timestamptz not null default public._now(),
  primary key (user_low, user_high),
  check (user_low < user_high),
  check (requester_id in (user_low, user_high)),
  check (blocked_by is null or blocked_by in (user_low, user_high))
);
create index friendships_high_status_idx on public.friendships (user_high, status);
create index friendships_requester_idx   on public.friendships (requester_id);
create index friendships_blocked_by_idx  on public.friendships (blocked_by);
alter table public.friendships enable row level security;
revoke all on public.friendships from anon, authenticated;

create table public.game_invites (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid references public.games(id) on delete cascade,
  from_id        uuid not null references public.profiles(id) on delete cascade,
  to_id          uuid not null references public.profiles(id) on delete cascade,
  challenge_kind text not null default 'game'
                   check (challenge_kind in ('game', 'daily_score', 'run_score', 'price_score')),
  target_score   int,
  status         text not null default 'pending'
                   check (status in ('pending', 'accepted', 'declined', 'expired')),
  created_at     timestamptz not null default public._now(),
  responded_at   timestamptz,
  check (from_id <> to_id)
);
create index game_invites_to_pending_idx on public.game_invites (to_id, status, created_at desc);
create index game_invites_game_status_idx on public.game_invites (game_id, status);
create index game_invites_from_idx on public.game_invites (from_id);
alter table public.game_invites enable row level security;
revoke all on public.game_invites from anon, authenticated;

-- ─── 3. _close_turn: preserve 002 logic + score Call-It (+25) ────────────────

create or replace function public._close_turn(p_game uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g  public.games;
  t0 int;
  t1 int;
begin
  select * into g from public.games where id = p_game;
  t0 := (g.current_turn - 1) * g.cards_per_turn + 1;
  t1 := g.current_turn * g.cards_per_turn;

  with late as (
    insert into public.answers (game_id, player_id, position, timed_out, artist_done)
    select g.id, gp.player_id, p, true, true
      from public.game_players gp cross join generate_series(t0, t1) p
     where gp.game_id = g.id and not gp.dropped
    on conflict (game_id, player_id, position) do update
      set timed_out = true, artist_done = true
      where public.answers.answered_at is null and not public.answers.timed_out
    returning player_id
  )
  update public.game_players set streak = 0
   where game_id = g.id and player_id in (select player_id from late);

  -- live: an answer whose artist pick never came is simply done now
  update public.answers set artist_done = true
   where game_id = g.id and position between t0 and t1 and not artist_done;

  update public.game_players gp set answered = (select count(*) from public.answers a
                                                 where a.game_id = g.id and a.player_id = gp.player_id
                                                   and (a.answered_at is not null or a.timed_out))
   where gp.game_id = g.id;

  if g.kind = 'async' then
    update public.game_players gp
       set missed_turns = case when exists (select 1 from public.answers a
                                             where a.game_id = g.id and a.player_id = gp.player_id
                                               and a.position between t0 and t1 and a.answered_at is not null)
                               then 0 else gp.missed_turns + 1 end
     where gp.game_id = g.id and not gp.dropped;
    update public.game_players set dropped = true where game_id = g.id and missed_turns >= 2;
  end if;

  -- score open Call-It predictions for this turn (idempotent via scored flag)
  with targets as (
    select gc.game_id, gc.position, gc.caller_id, gc.target_id,
           case
             when gp_target.player_id is not null and not gp_target.dropped
                  and gc.predict_ok = (coalesce(target_ans.correct, false) and not coalesce(target_ans.timed_out, true))
             then 25 else 0 end as pts
      from public.game_calls gc
      left join public.game_players gp_target
        on gp_target.game_id = g.id and gp_target.player_id = gc.target_id
      left join public.answers target_ans
        on target_ans.game_id = g.id and target_ans.player_id = gc.target_id and target_ans.position = gc.position
     where gc.game_id = g.id
       and gc.position between t0 and t1
       and not gc.scored
  ),
  evaluated as (
    update public.game_calls gc
       set scored = true,
           awarded = t.pts
      from targets t
     where gc.game_id = t.game_id
       and gc.position = t.position
       and gc.caller_id = t.caller_id
       and gc.target_id = t.target_id
       and not gc.scored
    returning gc.caller_id, gc.awarded
  ),
  bonus as (
    select e.caller_id, sum(e.awarded)::int as pts
      from evaluated e
     where e.awarded > 0
     group by e.caller_id
  )
  update public.game_players gp
     set score = gp.score + b.pts
    from bonus b
   where gp.game_id = g.id and gp.player_id = b.caller_id;

  update public.games set turn_closed_at = public._now(), updated_at = public._now() where id = g.id;
end $$;

-- Ensure push_batch tag stays non-null for game_id-less score challenges
create or replace function public._push_batch_unchecked() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids bigint[];
begin
  update public.push_outbox o set sent_at = now()
   where sent_at is null and (created_at < now() - interval '1 day'
         or not exists (select 1 from public.push_subscriptions s where s.player_id = o.player_id));
  delete from public.push_outbox where sent_at < now() - interval '14 days';
  with c as (
    update public.push_outbox set claimed_at = now()
     where id in (select id from public.push_outbox
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
               'title', o.title, 'body', o.body, 'url', o.url,
               'tag', o.kind || '-' || coalesce(o.game_id::text, o.id::text))), '[]')
             from (select * from public.push_outbox where id = any(ids)) o
             join public.push_subscriptions s on s.player_id = o.player_id and public._push_host_ok(s.endpoint)));
end $$;

-- ─── 4. Task 32 RPCs: round_live, call_it, send_reaction, round_results ──────

create function public.round_live(p_game uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me            uuid := public._me();
  g             public.games := public._tick(p_game);
  v_pos         int;
  v_turn_closed boolean;
  v_me_locked   boolean := false;
  my_ans        public.answers;
  c             public.cards;
  v_trivia      text := null;
  v_years       jsonb := '[]'::jsonb;
  v_slot_counts jsonb := '{}'::jsonb;
  v_players     jsonb;
  v_my_calls    jsonb := '{}'::jsonb;
  v_reactions   jsonb := '[]'::jsonb;
begin
  if g.id is null or not public._is_member(p_game) then
    raise exception 'game_not_found';
  end if;
  if g.kind <> 'live' then
    raise exception 'bad_settings';
  end if;

  v_turn_closed := (g.status = 'finished' or g.turn_closed_at is not null);
  if g.status in ('playing', 'finished') and g.current_turn >= 1 then
    v_pos := (g.current_turn - 1) * g.cards_per_turn + 1;
    select * into my_ans
      from public.answers
     where game_id = p_game and player_id = me and position = v_pos;
    v_me_locked := v_turn_closed or coalesce(public._is_done(my_ans, g), false);
  else
    v_pos := 0;
  end if;

  if v_me_locked and v_pos >= 1 then
    select c2.* into c
      from public.game_cards gc
      join public.cards c2 on c2.id = gc.card_id
     where gc.game_id = p_game and gc.position = v_pos;
    v_trivia := nullif(c.trivia, '');
    v_years := to_jsonb(public._years_before(p_game, v_pos));
  end if;

  with seats as (
    select gp.*,
           row_number() over (order by gp.joined_at, gp.player_id)::int as seat
      from public.game_players gp
     where gp.game_id = p_game
  ),
  active as (
    select s.*,
           a.slot as ans_slot,
           coalesce(a.timed_out, false) as ans_timed_out,
           (v_turn_closed or coalesce(public._is_done(a, g), false)) as is_locked
      from seats s
      left join public.answers a
        on a.game_id = p_game and a.player_id = s.player_id and a.position = v_pos and v_pos >= 1
     where not s.dropped
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', a.seat,
           'name', a.display_name,
           'is_me', a.player_id = me,
           'locked', a.is_locked,
           'slot', case when v_me_locked and a.is_locked then a.ans_slot else null end,
           'timed_out', case when v_me_locked and a.is_locked then a.ans_timed_out else null end,
           'score', case when g.status = 'playing' and g.turn_closed_at is null then a.round_score else a.score end
         ) order by a.seat), '[]'::jsonb),
         case when v_me_locked and v_pos >= 1 then
           coalesce((select jsonb_object_agg(cnt.slot_key, cnt.n)
                       from (select a2.ans_slot::text as slot_key, count(*)::int as n
                               from active a2
                              where a2.is_locked and a2.ans_slot is not null
                              group by a2.ans_slot) cnt), '{}'::jsonb)
         else '{}'::jsonb end
    into v_players, v_slot_counts
    from active a;

  if v_pos >= 1 then
    with seats as (
      select gp.player_id,
             gp.display_name,
             row_number() over (order by gp.joined_at, gp.player_id)::int as seat
        from public.game_players gp
       where gp.game_id = p_game
    )
    select coalesce(jsonb_object_agg(st.seat::text, gc.predict_ok), '{}'::jsonb)
      into v_my_calls
      from public.game_calls gc
      join seats st on st.player_id = gc.target_id
     where gc.game_id = p_game
       and gc.position = v_pos
       and gc.caller_id = me;

    with seats as (
      select gp.player_id,
             gp.display_name,
             row_number() over (order by gp.joined_at, gp.player_id)::int as seat
        from public.game_players gp
       where gp.game_id = p_game
    ),
    latest as (
      select r.id,
             sf.seat as seat,
             sf.display_name as name,
             st.seat as to_seat,
             r.emoji,
             r.created_at as at
        from public.game_reactions r
        join seats sf on sf.player_id = r.from_id
        left join seats st on st.player_id = r.to_id
       where r.game_id = p_game and r.turn = g.current_turn
       order by r.id desc
       limit 25
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', l.id,
             'seat', l.seat,
             'name', l.name,
             'to_seat', l.to_seat,
             'emoji', l.emoji,
             'at', l.at
           ) order by l.id desc), '[]'::jsonb)
      into v_reactions
      from latest l;
  end if;

  return jsonb_build_object(
    'id', g.id,
    'status', g.status,
    'turn', g.current_turn,
    'position', v_pos,
    'turn_closed', v_turn_closed,
    'turn_deadline', g.turn_deadline,
    'next_round_at', case when g.turn_closed_at is not null
                          then g.turn_closed_at + make_interval(secs => g.reveal_seconds) end,
    'server_now', public._now(),
    'me_locked', v_me_locked,
    'players', v_players,
    'slot_counts', v_slot_counts,
    'timeline_years', v_years,
    'trivia', v_trivia,
    'my_calls', v_my_calls,
    'reactions', v_reactions
  );
end $$;

create function public.call_it(
  p_game        uuid,
  p_position    int,
  p_target_seat int,
  p_predict_ok  boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me               uuid := public._me();
  g                public.games;
  gp_me            public.game_players;
  caller_ans       public.answers;
  v_target         uuid;
  v_target_dropped boolean;
  target_ans       public.answers;
begin
  perform public._tick(p_game);
  select * into g from public.games where id = p_game for update;
  select * into gp_me from public.game_players where game_id = p_game and player_id = me;
  if g.id is null or gp_me.player_id is null then
    raise exception 'game_not_found';
  end if;
  if g.kind <> 'live' or p_predict_ok is null then
    raise exception 'bad_settings';
  end if;
  if gp_me.dropped or g.status <> 'playing' or g.turn_closed_at is not null then
    raise exception 'turn_closed';
  end if;
  if p_position is distinct from g.current_turn then
    raise exception 'bad_position';
  end if;

  select * into caller_ans
    from public.answers
   where game_id = p_game and player_id = me and position = p_position;
  if not coalesce(public._is_done(caller_ans, g), false) then
    raise exception 'not_locked';
  end if;

  with seats as (
    select gp.player_id, gp.dropped,
           row_number() over (order by gp.joined_at, gp.player_id)::int as seat
      from public.game_players gp
     where gp.game_id = p_game
  )
  select s.player_id, s.dropped
    into v_target, v_target_dropped
    from seats s
   where s.seat = p_target_seat;

  if v_target is null or v_target_dropped or v_target = me then
    raise exception 'bad_target';
  end if;

  select * into target_ans
    from public.answers
   where game_id = p_game and player_id = v_target and position = p_position;
  if coalesce(public._is_done(target_ans, g), false) then
    raise exception 'target_already_locked';
  end if;

  insert into public.game_calls (game_id, position, caller_id, target_id, predict_ok)
  values (p_game, p_position, me, v_target, p_predict_ok)
  on conflict (game_id, position, caller_id, target_id) do update
    set predict_ok = excluded.predict_ok
   where not public.game_calls.scored;

  update public.games set updated_at = public._now() where id = p_game;
  return jsonb_build_object('ok', true);
end $$;

create function public.send_reaction(
  p_game        uuid,
  p_emoji       text,
  p_target_seat int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me               uuid := public._me();
  g                public.games := public._tick(p_game);
  gp_me            public.game_players;
  v_to             uuid := null;
  v_target_dropped boolean;
begin
  select * into gp_me from public.game_players where game_id = p_game and player_id = me;
  if g.id is null or gp_me.player_id is null then
    raise exception 'game_not_found';
  end if;
  if g.kind not in ('live', 'async') then
    raise exception 'bad_settings';
  end if;
  if g.status <> 'playing' or gp_me.dropped then
    raise exception 'not_playing';
  end if;
  if p_emoji is null or not (p_emoji = any(array['🎨','👏','😮','😅','🔥'])) then
    raise exception 'bad_emoji';
  end if;
  if (select count(*)
        from public.game_reactions r
       where r.game_id = p_game and r.turn = g.current_turn and r.from_id = me) >= 10 then
    raise exception 'too_many_reactions';
  end if;

  if p_target_seat is not null then
    with seats as (
      select gp.player_id, gp.dropped,
             row_number() over (order by gp.joined_at, gp.player_id)::int as seat
        from public.game_players gp
       where gp.game_id = p_game
    )
    select s.player_id, s.dropped
      into v_to, v_target_dropped
      from seats s
     where s.seat = p_target_seat;
    if v_to is null or v_target_dropped then
      raise exception 'bad_target';
    end if;
  end if;

  insert into public.game_reactions (game_id, turn, from_id, to_id, emoji)
  values (p_game, g.current_turn, me, v_to, p_emoji);

  update public.games set updated_at = public._now() where id = p_game;
  return jsonb_build_object('ok', true);
end $$;

create function public.round_results(p_game uuid, p_turn int default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me          uuid := public._me();
  g           public.games := public._tick(p_game);
  v_turn      int;
  t0          int;
  t1          int;
  v_cards     jsonb;
  v_reactions jsonb;
begin
  if g.id is null or not public._is_member(p_game) then
    raise exception 'game_not_found';
  end if;
  if g.kind not in ('live', 'async') then
    raise exception 'bad_settings';
  end if;

  v_turn := coalesce(
    p_turn,
    case
      when g.status = 'finished' or g.turn_closed_at is not null then g.current_turn
      else greatest(0, g.current_turn - 1)
    end
  );

  if v_turn < 1
     or v_turn > g.current_turn
     or (v_turn = g.current_turn and g.turn_closed_at is null and g.status <> 'finished') then
    raise exception 'not_yet';
  end if;

  t0 := (v_turn - 1) * g.cards_per_turn + 1;
  t1 := v_turn * g.cards_per_turn;

  with seats as (
    select gp.player_id,
           gp.display_name,
           gp.dropped,
           row_number() over (order by gp.joined_at, gp.player_id)::int as seat
      from public.game_players gp
     where gp.game_id = p_game
  ),
  turn_cards as (
    select gc.position,
           c.title,
           c.artist,
           c.year,
           c.image_url,
           nullif(c.trivia, '') as trivia,
           public._years_before(p_game, gc.position) as ys
      from public.game_cards gc
      join public.cards c on c.id = gc.card_id
     where gc.game_id = p_game
       and gc.position between t0 and t1
     order by gc.position
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'position', tc.position,
           'title', tc.title,
           'artist', tc.artist,
           'year', tc.year,
           'image_url', tc.image_url,
           'trivia', tc.trivia,
           'correct_slot', (select count(*)::int from unnest(tc.ys) y where y < tc.year),
           'timeline_years', to_jsonb(tc.ys),
           'results', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'seat', s.seat,
                      'name', s.display_name,
                      'is_me', s.player_id = me,
                      'slot', a.slot,
                      'correct', coalesce(a.correct, false),
                      'timed_out', coalesce(a.timed_out, false),
                      'artist_choice', a.artist_choice,
                      'artist_correct', coalesce(a.artist_correct, false),
                      'movement_choice', a.movement_choice,
                      'movement_correct', coalesce(a.movement_correct, false),
                      'points', coalesce(a.points, 0),
                      'call_bonus', coalesce((
                        select sum(cl.awarded)::int
                          from public.game_calls cl
                         where cl.game_id = p_game
                           and cl.position = tc.position
                           and cl.caller_id = s.player_id
                      ), 0)
                    ) order by s.seat), '[]'::jsonb)
               from seats s
               left join public.answers a
                 on a.game_id = p_game and a.player_id = s.player_id and a.position = tc.position
              where not s.dropped or a.player_id is not null
           )
         ) order by tc.position), '[]'::jsonb)
    into v_cards
    from turn_cards tc;

  with seats as (
    select gp.player_id,
           gp.display_name,
           row_number() over (order by gp.joined_at, gp.player_id)::int as seat
      from public.game_players gp
     where gp.game_id = p_game
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'seat', sf.seat,
           'name', sf.display_name,
           'to_seat', st.seat,
           'emoji', r.emoji
         ) order by r.id), '[]'::jsonb)
    into v_reactions
    from public.game_reactions r
    join seats sf on sf.player_id = r.from_id
    left join seats st on st.player_id = r.to_id
   where r.game_id = p_game and r.turn = v_turn;

  return jsonb_build_object(
    'turn', v_turn,
    'cards', v_cards,
    'reactions', v_reactions
  );
end $$;

-- ─── 5. Tasks 33 & 44 helpers + achievement/badge extraction ─────────────────

create function public._require_friend_account() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me uuid := public._me();
  p  public.profiles;
begin
  select * into p from public.profiles where id = me;
  if p.id is null or p.is_guest or p.username is null then
    raise exception 'friend_needs_account';
  end if;
  return me;
end $$;

create function public._badges_for(p_player uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cur date := date_trunc('month', public._today())::date;
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'month', m,
             'title', (public._month_rule(m)).title,
             'title_de', (public._month_rule(m)).title_de,
             'rank', r.rk,
             'value', r.value
           ) order by m desc), '[]'::jsonb)
      from (select distinct g.run_month as m
              from public.games g
              join public.game_players gp on gp.game_id = g.id
             where g.kind = 'run' and gp.player_id = p_player and g.run_month < cur) months
      cross join lateral (
        select rk, value from public._run_ranked(months.m) x where x.player_id = p_player
      ) r
     where r.rk <= 3
  );
end $$;

create or replace function public.my_badges() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public._badges_for(public._me())
$$;

create function public._achievements_for(p_player uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with caller as (
    select p_player as me, public._today() as today
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

create or replace function public.my_achievements() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public._achievements_for(public._me())
$$;

-- ─── 6. Friendships RPCs ─────────────────────────────────────────────────────

create function public.send_friend_request(p_username text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._require_friend_account();
  v_name text := nullif(trim(p_username), '');
  target public.profiles;
  v_low  uuid;
  v_high uuid;
  f      public.friendships;
begin
  if v_name is null then
    raise exception 'user_not_found';
  end if;
  select * into target
    from public.profiles
   where lower(username) = lower(v_name)
     and not is_guest
     and username is not null;
  if target.id is null or target.id = me then
    raise exception 'user_not_found';
  end if;

  v_low  := least(me, target.id);
  v_high := greatest(me, target.id);

  select * into f
    from public.friendships
   where user_low = v_low and user_high = v_high
     for update;

  if f.user_low is not null then
    if f.status = 'blocked' then
      raise exception 'blocked';
    end if;
    if f.status = 'accepted' then
      return jsonb_build_object('status', 'accepted', 'username', target.username);
    end if;
    if f.requester_id = me then
      return jsonb_build_object('status', 'pending', 'username', target.username);
    end if;
    -- existing incoming request from target -> auto-accept
    update public.friendships
       set status = 'accepted', updated_at = public._now()
     where user_low = v_low and user_high = v_high;
    return jsonb_build_object('status', 'accepted', 'username', target.username);
  end if;

  if (select count(*) from public.friendships where requester_id = me and status = 'pending') >= 20 then
    raise exception 'too_many_requests';
  end if;

  insert into public.friendships (user_low, user_high, requester_id, status)
  values (v_low, v_high, me, 'pending');

  return jsonb_build_object('status', 'pending', 'username', target.username);
end $$;

create function public.respond_friend_request(p_username text, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._require_friend_account();
  v_name text := nullif(trim(p_username), '');
  target public.profiles;
  v_low  uuid;
  v_high uuid;
  f      public.friendships;
begin
  if v_name is null then
    raise exception 'friend_not_found';
  end if;
  select * into target
    from public.profiles
   where lower(username) = lower(v_name)
     and not is_guest
     and username is not null;
  if target.id is null or target.id = me then
    raise exception 'friend_not_found';
  end if;

  v_low  := least(me, target.id);
  v_high := greatest(me, target.id);

  select * into f
    from public.friendships
   where user_low = v_low and user_high = v_high
     for update;

  if f.user_low is null or f.status <> 'pending' or f.requester_id <> target.id then
    raise exception 'friend_not_found';
  end if;

  if coalesce(p_accept, false) then
    update public.friendships
       set status = 'accepted', updated_at = public._now()
     where user_low = v_low and user_high = v_high;
    return jsonb_build_object('status', 'accepted', 'username', target.username);
  end if;

  delete from public.friendships
   where user_low = v_low and user_high = v_high;
  return jsonb_build_object('status', 'declined', 'username', target.username);
end $$;

create function public.remove_friend(p_username text, p_block boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._require_friend_account();
  v_name text := nullif(trim(p_username), '');
  target public.profiles;
  v_low  uuid;
  v_high uuid;
  f      public.friendships;
begin
  if v_name is null then
    raise exception 'friend_not_found';
  end if;
  select * into target
    from public.profiles
   where lower(username) = lower(v_name)
     and not is_guest
     and username is not null;
  if target.id is null or target.id = me then
    raise exception 'friend_not_found';
  end if;

  v_low  := least(me, target.id);
  v_high := greatest(me, target.id);

  select * into f
    from public.friendships
   where user_low = v_low and user_high = v_high
     for update;

  if f.user_low is not null then
    if f.status = 'blocked' then
      if f.blocked_by is distinct from me then
        raise exception 'blocked';
      end if;
      if coalesce(p_block, false) then
        return jsonb_build_object('status', 'blocked', 'username', target.username);
      end if;
      delete from public.friendships
       where user_low = v_low and user_high = v_high;
      return jsonb_build_object('status', 'removed', 'username', target.username);
    end if;

    if coalesce(p_block, false) then
      update public.friendships
         set status = 'blocked', blocked_by = me, updated_at = public._now()
       where user_low = v_low and user_high = v_high;
      update public.game_invites
         set status = 'expired', responded_at = coalesce(responded_at, public._now())
       where status = 'pending'
         and ((from_id = me and to_id = target.id) or (from_id = target.id and to_id = me));
      return jsonb_build_object('status', 'blocked', 'username', target.username);
    end if;

    delete from public.friendships
     where user_low = v_low and user_high = v_high;
    update public.game_invites
       set status = 'expired', responded_at = coalesce(responded_at, public._now())
     where status = 'pending'
       and ((from_id = me and to_id = target.id) or (from_id = target.id and to_id = me));
    return jsonb_build_object('status', 'removed', 'username', target.username);
  end if;

  if coalesce(p_block, false) then
    insert into public.friendships (user_low, user_high, requester_id, blocked_by, status)
    values (v_low, v_high, me, me, 'blocked');
    update public.game_invites
       set status = 'expired', responded_at = coalesce(responded_at, public._now())
     where status = 'pending'
       and ((from_id = me and to_id = target.id) or (from_id = target.id and to_id = me));
    return jsonb_build_object('status', 'blocked', 'username', target.username);
  end if;

  raise exception 'friend_not_found';
end $$;

create function public.my_friends() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me         uuid := public._require_friend_account();
  v_friends  jsonb;
  v_incoming jsonb;
  v_outgoing jsonb;
begin
  with mine as (
    select f.status,
           f.requester_id,
           f.created_at,
           f.updated_at,
           p.id as other_id,
           p.username,
           p.display_name
      from public.friendships f
      join public.profiles p
        on p.id = case when f.user_low = me then f.user_high else f.user_low end
     where (f.user_low = me or f.user_high = me)
       and f.status in ('pending', 'accepted')
       and not p.is_guest
       and p.username is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'username', m.username,
           'display_name', m.display_name,
           'daily_streak', coalesce((select gs.streak from public._grace_streak(m.other_id) gs), 0),
           'since', m.updated_at
         ) order by lower(m.username)) filter (where m.status = 'accepted'), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object(
           'username', m.username,
           'display_name', m.display_name,
           'requested_at', m.created_at
         ) order by m.created_at desc) filter (where m.status = 'pending' and m.requester_id <> me), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object(
           'username', m.username,
           'display_name', m.display_name,
           'requested_at', m.created_at
         ) order by m.created_at desc) filter (where m.status = 'pending' and m.requester_id = me), '[]'::jsonb)
    into v_friends, v_incoming, v_outgoing
    from mine m;

  return jsonb_build_object(
    'friends', coalesce(v_friends, '[]'::jsonb),
    'incoming', coalesce(v_incoming, '[]'::jsonb),
    'outgoing', coalesce(v_outgoing, '[]'::jsonb)
  );
end $$;

-- ─── 7. Read-only Friend Profile & Friends Leaderboards ──────────────────────

create function public.friend_profile(p_username text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._require_friend_account();
  v_name text := nullif(trim(p_username), '');
  target public.profiles;
  v_stats jsonb;
begin
  if v_name is null then
    raise exception 'not_friends';
  end if;
  select * into target
    from public.profiles
   where lower(username) = lower(v_name)
     and not is_guest
     and username is not null;
  if target.id is null then
    raise exception 'not_friends';
  end if;
  if target.id <> me and not exists (
    select 1 from public.friendships f
     where f.user_low = least(me, target.id)
       and f.user_high = greatest(me, target.id)
       and f.status = 'accepted'
  ) then
    raise exception 'not_friends';
  end if;

  with mine as (
    select gp.*, g.kind, g.status,
           (select count(*) from public.game_players x where x.game_id = g.id) as n_players
      from public.game_players gp
      join public.games g on g.id = gp.game_id
     where gp.player_id = target.id and gp.answered > 0
  )
  select jsonb_build_object(
    'games_played', (select count(*)::int from mine where kind = 'daily' or status = 'finished'),
    'accuracy', (select round(sum(correct)::numeric / nullif(sum(answered), 0), 3) from mine),
    'wins', (select count(*)::int from mine where kind in ('live', 'async') and status = 'finished'
                                              and final_rank = 1 and n_players >= 2),
    'total_points', coalesce((select sum(score) from mine), 0),
    'best_streak', coalesce((select max(best_streak) from mine), 0),
    'artists_named', coalesce((select sum(artists_named) from mine), 0),
    'best_run', coalesce((select max(gp.score)::int
                            from public.game_players gp
                            join public.games g on g.id = gp.game_id
                           where gp.player_id = target.id
                             and g.kind = 'run'
                             and g.status = 'finished'), 0),
    'best_price', coalesce((select max(sg.score)::int
                              from public.solo_games sg
                             where sg.player_id = target.id
                               and sg.mode = 'price'), 0),
    'daily_streak', coalesce((select gs.streak from public._grace_streak(target.id) gs), 0)
  ) into v_stats;

  return jsonb_build_object(
    'username', target.username,
    'display_name', target.display_name,
    'since', target.created_at,
    'stats', v_stats,
    'badges', public._badges_for(target.id),
    'achievements', public._achievements_for(target.id)
  );
end $$;

create function public.friends_leaderboard(p_board text, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  me      uuid := public._require_friend_account();
  d       date;
  m       date;
  rule    public.monthly_challenges;
  gp      public.game_players;
  v_best  int;
  v_runs  bigint;
  v_rank  bigint;
  v_val   int;
  v_pts   bigint;
  v_entries jsonb;
  v_players bigint;
begin
  if p_board is null or p_board not in ('today', 'month', 'price', 'allTime') then
    raise exception 'bad_settings';
  end if;

  if p_board = 'today' then
    d := coalesce(p_date, public._today());
    select x.* into gp
      from public.game_players x
      join public.games g on g.id = x.game_id
     where g.challenge_date = d and x.player_id = me;

    with circle as (
      select me as id
      union
      select case when f.user_low = me then f.user_high else f.user_low end as id
        from public.friendships f
       where (f.user_low = me or f.user_high = me) and f.status = 'accepted'
    ),
    ranked as (
      select r.player_id, r.username, r.score, r.correct,
             rank() over (order by r.rk) as rk
        from public._daily_ranked(d) r
        join circle c on c.id = r.player_id
    )
    select coalesce((select jsonb_agg(jsonb_build_object(
             'rank', t.rk, 'username', t.username, 'score', t.score, 'correct', t.correct, 'is_me', t.player_id = me
           ) order by t.rk, t.username) from (select * from ranked order by rk, username limit 50) t), '[]'::jsonb),
           (select count(*) from ranked),
           (select rk from ranked where player_id = me)
      into v_entries, v_players, v_rank;

    return jsonb_build_object(
      'date', d,
      'challenge_no', public._challenge_no(d),
      'players', coalesce(v_players, 0),
      'entries', v_entries,
      'me', case when gp.player_id is null then null else jsonb_build_object(
              'score', gp.score, 'correct', gp.correct, 'answered', gp.answered,
              'rank', v_rank, 'ranked', v_rank is not null) end
    );
  end if;

  if p_board = 'month' then
    m := date_trunc('month', coalesce(p_date, public._today()))::date;
    rule := public._month_rule(m);
    select best, runs into v_best, v_runs from public._run_best(m) where player_id = me;

    with circle as (
      select me as id
      union
      select case when f.user_low = me then f.user_high else f.user_low end as id
        from public.friendships f
       where (f.user_low = me or f.user_high = me) and f.status = 'accepted'
    ),
    ranked as (
      select r.player_id, r.username, r.value,
             rank() over (order by r.rk) as rk
        from public._run_ranked(m) r
        join circle c on c.id = r.player_id
    )
    select coalesce((select jsonb_agg(jsonb_build_object(
             'rank', t.rk, 'username', t.username, 'value', t.value, 'is_me', t.player_id = me
           ) order by t.rk, t.username) from (select * from ranked order by rk, username limit 50) t), '[]'::jsonb),
           (select count(*) from ranked),
           (select rk from ranked where player_id = me),
           (select value from ranked where player_id = me)
      into v_entries, v_players, v_rank, v_val;

    return jsonb_build_object(
      'month', m,
      'title', rule.title,
      'description', rule.description,
      'metric', 'best_run',
      'title_de', rule.title_de,
      'description_de', rule.description_de,
      'days_left', greatest(0, ((m + interval '1 month')::date - public._today())),
      'players', coalesce(v_players, 0),
      'entries', v_entries,
      'me', case when v_best is null then null else jsonb_build_object(
              'rank', v_rank, 'value', coalesce(v_val, v_best), 'best', v_best, 'runs', v_runs,
              'ranked', v_rank is not null) end
    );
  end if;

  if p_board = 'price' then
    select best, runs into v_best, v_runs from public._price_best() where player_id = me;

    with circle as (
      select me as id
      union
      select case when f.user_low = me then f.user_high else f.user_low end as id
        from public.friendships f
       where (f.user_low = me or f.user_high = me) and f.status = 'accepted'
    ),
    ranked as (
      select r.player_id, r.username, r.value,
             rank() over (order by r.rk) as rk
        from public._price_ranked() r
        join circle c on c.id = r.player_id
    )
    select coalesce((select jsonb_agg(jsonb_build_object(
             'rank', t.rk, 'username', t.username, 'value', t.value, 'is_me', t.player_id = me
           ) order by t.rk, t.username) from (select * from ranked order by rk, username limit 50) t), '[]'::jsonb),
           (select count(*) from ranked),
           (select rk from ranked where player_id = me),
           (select value from ranked where player_id = me)
      into v_entries, v_players, v_rank, v_val;

    return jsonb_build_object(
      'metric', 'price_best',
      'players', coalesce(v_players, 0),
      'entries', v_entries,
      'me', case when v_best is null then null else jsonb_build_object(
              'rank', v_rank, 'value', coalesce(v_val, v_best), 'best', v_best, 'runs', v_runs,
              'ranked', v_rank is not null) end
    );
  end if;

  -- allTime
  with circle as (
    select me as id
    union
    select case when f.user_low = me then f.user_high else f.user_low end as id
      from public.friendships f
     where (f.user_low = me or f.user_high = me) and f.status = 'accepted'
  ),
  ranked as (
    select r.player_id, r.username, r.points,
           rank() over (order by r.rk) as rk
      from public._alltime_values() r
      join circle c on c.id = r.player_id
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
           'rank', t.rk, 'username', t.username, 'points', t.points, 'is_me', t.player_id = me
         ) order by t.rk, t.username) from (select * from ranked order by rk, username limit 50) t), '[]'::jsonb),
         (select rk from ranked where player_id = me),
         (select points from ranked where player_id = me)
    into v_entries, v_rank, v_pts;

  return jsonb_build_object(
    'entries', v_entries,
    'me', case when v_rank is null then null else jsonb_build_object('rank', v_rank, 'points', v_pts) end
  );
end $$;

-- ─── 8. Direct Game Invites & Score Challenges ───────────────────────────────

create function public.invite_friends_to_game(
  p_usernames      text[],
  p_kind           text default 'async',
  p_card_count     int default 12,
  p_cards_per_turn int default 3
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me            uuid := public._require_friend_account();
  caller        public.profiles;
  v_card_count  int;
  v_cpt         int;
  v_clean       text[];
  v_target_ids  uuid[] := '{}';
  v_invited     text[] := '{}';
  v_u           text;
  v_target      public.profiles;
  g             public.games;
begin
  select * into caller from public.profiles where id = me;

  if p_kind is null or p_kind not in ('live', 'async') then
    raise exception 'bad_settings';
  end if;
  v_card_count := coalesce(p_card_count, case p_kind when 'live' then 10 else 12 end);
  v_cpt := case p_kind when 'live' then 1 else coalesce(p_cards_per_turn, 3) end;
  if v_card_count not between 3 and 30 or v_cpt < 1 or v_card_count % v_cpt <> 0 then
    raise exception 'bad_settings';
  end if;

  if p_usernames is null or cardinality(p_usernames) = 0 then
    raise exception 'bad_settings';
  end if;
  if exists (select 1 from unnest(p_usernames) u where nullif(trim(u), '') is null) then
    raise exception 'bad_settings';
  end if;

  select coalesce(array_agg(s.u order by s.ord), '{}')
    into v_clean
    from (
      select lower(trim(t.u)) as lu,
             (array_agg(trim(t.u) order by t.ord))[1] as u,
             min(t.ord) as ord
        from unnest(p_usernames) with ordinality t(u, ord)
       group by lower(trim(t.u))
    ) s;

  if cardinality(v_clean) < 1 or cardinality(v_clean) > 7 then
    raise exception 'bad_settings';
  end if;

  -- Verify EVERY target is an accepted friend BEFORE creating the game
  foreach v_u in array v_clean loop
    select * into v_target
      from public.profiles
     where lower(username) = lower(v_u)
       and not is_guest
       and username is not null;
    if v_target.id is null or v_target.id = me then
      raise exception 'not_friends';
    end if;
    if not exists (
      select 1 from public.friendships f
       where f.user_low = least(me, v_target.id)
         and f.user_high = greatest(me, v_target.id)
         and f.status = 'accepted'
    ) then
      raise exception 'not_friends';
    end if;
    v_target_ids := v_target_ids || v_target.id;
    v_invited    := v_invited || v_target.username;
  end loop;

  if (select count(*) from public.games where host_id = me and status = 'lobby') >= 5
     or (select count(*) from public.games where host_id = me and created_at > public._now() - interval '1 hour') >= 30 then
    raise exception 'too_many_games';
  end if;

  insert into public.games (kind, code, host_id, card_count, cards_per_turn, turn_hours, max_players)
  values (p_kind, public._new_code(), me,
          v_card_count, v_cpt,
          case p_kind when 'async' then 24 end,
          case p_kind when 'live' then 20 else 8 end)
  returning * into g;

  insert into public.game_players (game_id, player_id, display_name)
  values (g.id, me, caller.display_name);

  insert into public.game_invites (game_id, from_id, to_id, challenge_kind)
  select g.id, me, tid, 'game'
    from unnest(v_target_ids) as tid;

  insert into public.push_outbox (player_id, kind, game_id, turn, title, body, url)
  select tid, 'invite', g.id, 0,
         'Game invite in CIRCArt',
         caller.username || ' invited you to a game',
         '?game=' || g.id
    from unnest(v_target_ids) as tid
   where exists (select 1 from public.push_subscriptions ps where ps.player_id = tid)
  on conflict do nothing;

  return jsonb_build_object(
    'game_id', g.id,
    'code', g.code,
    'invited', to_jsonb(v_invited)
  );
end $$;

create function public.send_score_challenge(p_username text, p_mode text, p_score int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._require_friend_account();
  caller public.profiles;
  v_name text := nullif(trim(p_username), '');
  target public.profiles;
  v_id   uuid;
begin
  select * into caller from public.profiles where id = me;
  if p_mode is null or p_mode not in ('daily_score', 'run_score', 'price_score') then
    raise exception 'bad_settings';
  end if;
  if p_score is null or p_score < 0 or p_score > 100000 then
    raise exception 'bad_settings';
  end if;
  if v_name is null then
    raise exception 'not_friends';
  end if;
  select * into target
    from public.profiles
   where lower(username) = lower(v_name)
     and not is_guest
     and username is not null;
  if target.id is null or target.id = me then
    raise exception 'not_friends';
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.user_low = least(me, target.id)
       and f.user_high = greatest(me, target.id)
       and f.status = 'accepted'
  ) then
    raise exception 'not_friends';
  end if;

  if (select count(*)
        from public.game_invites gi
       where gi.from_id = me
         and gi.challenge_kind <> 'game'
         and gi.created_at > public._now() - interval '1 hour') >= 30 then
    raise exception 'too_many_requests';
  end if;

  insert into public.game_invites (game_id, from_id, to_id, challenge_kind, target_score)
  values (null, me, target.id, p_mode, p_score)
  returning id into v_id;

  insert into public.push_outbox (player_id, kind, game_id, turn, title, body, url)
  select target.id, 'new_challenge', null, null,
         'New score challenge',
         caller.username || ' challenged you to beat ' || p_score || ' points!',
         '?friends=1'
   where exists (select 1 from public.push_subscriptions ps where ps.player_id = target.id);

  return jsonb_build_object('id', v_id, 'ok', true);
end $$;

create function public.my_game_invites() returns jsonb
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
       and (gi.challenge_kind <> 'game' or (g.id is not null and g.status = 'lobby'))
  );
end $$;

create function public.respond_game_invite(p_invite_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me             uuid := public._require_friend_account();
  gi             public.game_invites;
  g              public.games;
  v_name         text;
  v_accepted     boolean := coalesce(p_accept, false);
  v_auto_started boolean := false;
begin
  select * into gi
    from public.game_invites
   where id = p_invite_id
     and to_id = me
     and status = 'pending'
     for update;

  if gi.id is null then
    raise exception 'invite_not_found';
  end if;

  if not v_accepted then
    update public.game_invites
       set status = 'declined', responded_at = public._now()
     where id = gi.id;
    return jsonb_build_object(
      'accepted', false,
      'game_id', gi.game_id,
      'auto_started', false
    );
  end if;

  if gi.challenge_kind = 'game' then
    select * into g from public.games where id = gi.game_id for update;
    if g.id is null or g.status in ('cancelled', 'finished') then
      raise exception 'game_not_found';
    end if;

    if not exists (select 1 from public.game_players where game_id = g.id and player_id = me) then
      if g.status <> 'lobby' then
        raise exception 'game_started';
      end if;
      if (select count(*) from public.game_players where game_id = g.id) >= g.max_players then
        raise exception 'game_full';
      end if;
      select display_name into v_name from public.profiles where id = me;
      insert into public.game_players (game_id, player_id, display_name)
      values (g.id, me, v_name)
      on conflict do nothing;
      update public.games set updated_at = public._now() where id = g.id;
    end if;

    update public.game_invites
       set status = 'accepted', responded_at = public._now()
     where id = gi.id;

    if g.status = 'lobby'
       and g.kind = 'async'
       and not exists (select 1 from public.game_invites where game_id = g.id and status = 'pending')
       and (select count(*) from public.game_players where game_id = g.id) >= 2 then
      perform public._deal(
        g.id,
        public._recent_cards(array(select player_id from public.game_players where game_id = g.id), 30)
      );
      update public.games
         set status = 'playing', started_at = public._now(), updated_at = public._now()
       where id = g.id;
      perform public._open_turn(g.id, 1);
      v_auto_started := true;
    end if;
  else
    update public.game_invites
       set status = 'accepted', responded_at = public._now()
     where id = gi.id;
  end if;

  return jsonb_build_object(
    'accepted', true,
    'game_id', gi.game_id,
    'auto_started', v_auto_started
  );
end $$;

-- ─── 9. GDPR Export & Privacy Cleanup updates ────────────────────────────────

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
    'friendships', (select coalesce(jsonb_agg(jsonb_build_object(
                      'friend_username', p.username,
                      'status', f.status,
                      'direction', case when f.requester_id = me then 'outgoing' else 'incoming' end,
                      'created_at', f.created_at,
                      'updated_at', f.updated_at
                    ) order by f.created_at), '[]'::jsonb)
                      from public.friendships f
                      join public.profiles p
                        on p.id = case when f.user_low = me then f.user_high else f.user_low end
                     where (f.user_low = me or f.user_high = me)
                       and not (f.status = 'blocked' and f.blocked_by is distinct from me)),
    'game_invites', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', gi.id,
                       'direction', case when gi.from_id = me then 'sent' else 'received' end,
                       'other_username', p.username,
                       'challenge_kind', gi.challenge_kind,
                       'game_id', gi.game_id,
                       'target_score', gi.target_score,
                       'status', gi.status,
                       'created_at', gi.created_at,
                       'responded_at', gi.responded_at
                     ) order by gi.created_at), '[]'::jsonb)
                       from public.game_invites gi
                       join public.profiles p
                         on p.id = case when gi.from_id = me then gi.to_id else gi.from_id end
                      where gi.from_id = me or gi.to_id = me),

    'stored_on_this_device', 'The app also keeps settings (language, theme, onboarding seen, '
      || 'unsent solo games, your lasting gallery collection, a temporary guest-transfer ticket '
      || 'while signing in, and your sign-in session) in your browser''s local storage. '
      || 'They never leave your device except the session (which signs you in) and the temporary transfer ticket (used once to move your guest games).');
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
  t                 timestamptz := public._now();
  n_guests          int;
  n_accounts        int;
  n_push            int;
  n_outbox          int;
  n_lobby           int;
  n_orphan          int;
  n_fb_strip        int;
  n_fb_del          int;
  n_invites_expired int;
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

  update public.game_invites
     set status = 'expired', responded_at = coalesce(responded_at, t)
   where status = 'pending' and created_at < t - interval '7 days';
  get diagnostics n_invites_expired = row_count;

  return jsonb_build_object(
    'guests_deleted', n_guests,
    'accounts_deleted', n_accounts,
    'push_devices_removed', n_push,
    'push_messages_deleted', n_outbox,
    'stale_games_deleted', n_lobby,
    'empty_games_deleted', n_orphan,
    'feedback_stripped', n_fb_strip,
    'feedback_deleted', n_fb_del,
    'invites_expired', n_invites_expired
  );
end $$;

-- ─── 10. Explicit execute permissions ────────────────────────────────────────

revoke execute on function
  public._close_turn(uuid),
  public._push_batch_unchecked(),
  public.round_live(uuid),
  public.call_it(uuid, int, int, boolean),
  public.send_reaction(uuid, text, int),
  public.round_results(uuid, int),
  public._require_friend_account(),
  public._badges_for(uuid),
  public.my_badges(),
  public._achievements_for(uuid),
  public.my_achievements(),
  public.send_friend_request(text),
  public.respond_friend_request(text, boolean),
  public.remove_friend(text, boolean),
  public.my_friends(),
  public.friend_profile(text),
  public.friends_leaderboard(text, date),
  public.invite_friends_to_game(text[], text, int, int),
  public.send_score_challenge(text, text, int),
  public.my_game_invites(),
  public.respond_game_invite(uuid, boolean),
  public.export_my_data(),
  public.privacy_cleanup(interval, interval, interval, interval, interval)
  from public, anon, authenticated;

grant execute on function
  public.round_live(uuid),
  public.call_it(uuid, int, int, boolean),
  public.send_reaction(uuid, text, int),
  public.round_results(uuid, int),
  public.my_badges(),
  public.my_achievements(),
  public.send_friend_request(text),
  public.respond_friend_request(text, boolean),
  public.remove_friend(text, boolean),
  public.my_friends(),
  public.friend_profile(text),
  public.friends_leaderboard(text, date),
  public.invite_friends_to_game(text[], text, int, int),
  public.send_score_challenge(text, text, int),
  public.my_game_invites(),
  public.respond_game_invite(uuid, boolean),
  public.export_my_data()
  to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public._push_batch_unchecked() from service_role;
    grant usage on schema public to service_role;
    grant execute on function
      public.privacy_cleanup(interval, interval, interval, interval, interval)
      to service_role;
  end if;
end $$;
