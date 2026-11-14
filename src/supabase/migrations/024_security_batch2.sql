-- 024: security batch 2 (review of 13 Nov).
-- Feedback guard, join codes, answer speed floor, solo-game size, guest usernames,
-- feedback deleted with the account, pick_artist closed, shorter lobby life.

-- ─── 1. feedback guard ───
create or replace function public.clean_player_text(p text) returns text
language sql immutable set search_path = public as $$
  select case when p is null then null else
    btrim(regexp_replace(
      regexp_replace(p,
        -- zero-width, bidi controls, word joiners, BOM, Unicode tag block, other format chars
        '[​-‏‪-‮⁠-⁤⁦-⁩﻿­᠎\U000E0000-\U000E007F\uFE00-\uFE0F\U000E0100-\U000E01EF]', '', 'g'),
      -- control characters except tab / newline
      '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', '', 'g'))
  end
$$;


create or replace function public.injection_scan(p text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  t      text := lower(normalize(coalesce(p, ''), NFKC));
  score  int := 0;
  flags  text[] := '{}';
  r      record;
begin
  for r in select * from (values
    -- weight 3: unmistakable attempts
    ('override',   3, '(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|your\s+|my\s+)?(previous|prior|above|earlier|preceding|system|original)?\s*(instructions?|prompts?|rules?|guidelines?|directions?|context)'),
    ('override_de',3, '(ignorier|vergiss|missacht|überschreib)\w*\s+(alle\s+|die\s+|deine\s+)?(vorherigen\s+|bisherigen\s+|obigen\s+)?(anweisungen|regeln|instruktionen|vorgaben|prompts?)'),
    ('role_marker',3, '(^|\n)\s*(system|assistant|developer|human|user)\s*:'),
    ('fake_tags',  3, '</?\s*(system|instructions?|assistant|tool|tool_use|function_calls?|invoke|parameter|antml[^>]*|im_start|im_end)\s*>|<\|im_(start|end)\|>|\[/?inst\]|\[system\]'),
    ('new_role',   3, '(you are now|from now on you|act as (an? )?(admin|developer|system|root|ai|assistant)|du bist (jetzt|ab jetzt)|tu so als)'),
    ('jailbreak',  3, '(jailbreak|do anything now|\mdan mode|developer mode|god mode)'),
    -- weight 2: actions an attacker wants a model to take
    ('shell',      2, '(rm\s+-rf|sudo\s|curl\s+-|wget\s+http|\|\s*(sh|bash)\b|chmod\s+\+x|base64\s+-d|eval\s*\()'),
    ('git',        2, '(git\s+(push|reset|commit|clone|remote)|force[- ]push|merge (this|the) (pr|pull request))'),
    ('db_destroy', 2, '(drop\s+(table|schema|database)|truncate\s+table|delete\s+from\s+\w+|lösche?\s+(alle|die)\s+(daten|tabellen|nutzer|accounts))'),
    ('secrets',    2, '(api[_ -]?key|service[_ -]?role|secret[_ -]?key|private[_ -]?key|access[_ -]?token|password|passwort|vapid|env(ironment)? var)'),
    ('tool_names', 2, '(mcp__|tool_use|function[_ ]call|execute_sql|apply_migration|deploy_edge_function|sendusermessage)'),
    ('ai_address', 2, '(dear (ai|claude|assistant|model|llm)|hey (claude|chatgpt|gpt|ai)\b|(claude|assistant|ai|model),?\s+(please\s+)?(ignore|run|execute|delete|send|push|reveal|print))'),
    ('reveal',     2, '(reveal|print|show|output|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions|rules|secrets?)'),
    -- weight 1: suspicious on their own, alarming together
    ('links',      1, '(https?://\S+.*){3,}'),
    ('encoded',    1, '[a-z0-9+/=]{80,}'),
    ('imperative', 1, '(you must|you have to|immediately|do not tell|don''t tell|without asking|ohne nachzufragen|sofort)')
  ) as x(flag, weight, pattern) loop
    if t ~ r.pattern then
      score := score + r.weight;
      flags := flags || r.flag;
    end if;
  end loop;
  if p is not null and p <> clean_player_text(p) then
    score := score + 2; flags := flags || 'hidden_chars'::text;
  end if;
  return jsonb_build_object('score', score, 'flags', to_jsonb(flags));
end $$;


create or replace function public._guard_feedback() returns trigger
language plpgsql security definer set search_path = public as $$
declare s jsonb;
begin
  s := injection_scan(coalesce(new.topic, '') || E'\n' || coalesce(new.message, ''));
  new.topic   := coalesce(nullif(clean_player_text(new.topic), ''), 'Other');
  new.message := coalesce(nullif(clean_player_text(new.message), ''), '(empty)');
  new.risk := (s->>'score')::int;
  new.risk_flags := array(select jsonb_array_elements_text(s->'flags'));
  if new.risk >= 2 and new.status in ('new', 'read') then new.status := 'quarantined'; end if;
  return new;
end $$;

-- re-check old rows with the stricter rules
update public.feedback set status = 'quarantined'
 where status in ('new','read') and (public.injection_scan(coalesce(topic,'') || E'\n' || coalesce(message,'')) ->> 'score')::int >= 2;
update public.feedback set card_source_id = null
 where card_source_id is not null and not exists (select 1 from public.cards c where c.source_id = feedback.card_source_id);

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
  if p_card_source_id is not null and not exists (select 1 from cards where source_id = p_card_source_id) then
    p_card_source_id := null;
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
-- ─── 2. join codes ───
create or replace function public._new_code() returns text
language plpgsql volatile set search_path = public as $$
declare c text; tries int := 0;
begin
  loop   -- 4 characters, no 0/O/1/I/L
    tries := tries + 1;
    if tries > 50 then raise exception 'try_again'; end if;
    c := (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
          from generate_series(1, 4));
    exit when not exists (select 1 from games where code = c and status in ('lobby','playing'));
  end loop;
  return c;
end $$;
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
   where (status = 'lobby' and created_at < t - interval '1 day')
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
-- ─── 3. answer(): nothing counts as faster than 2 seconds for the points ───
create or replace function public.answer(p_game uuid, p_position int, p_slot int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me       uuid := _me();
  g        games;
  gp       game_players;
  a        answers;
  c        cards;
  years    int[];
  n        int;
  elapsed  numeric;
  ok       boolean;
  v_streak int;
  pts      int := 0;
  late     boolean;
  opts     text[];
  mopts    text[];
begin
  select * into g from games where id = p_game for update;
  select * into gp from game_players where game_id = p_game and player_id = me for update;
  if g.id is null or gp.player_id is null then raise exception 'game_not_found'; end if;
  if g.status <> 'playing' or gp.dropped then raise exception 'not_playing'; end if;
  select * into a from answers where game_id = p_game and player_id = me and position = p_position for update;
  if a.player_id is null or a.shown_at is null then raise exception 'card_not_open'; end if;
  if a.answered_at is not null or a.timed_out then raise exception 'already_answered'; end if;

  elapsed := extract(epoch from _now() - a.shown_at);
  late := elapsed > g.answer_seconds + extract(epoch from _grace());
  select c2.* into c from game_cards gc join cards c2 on c2.id = gc.card_id
   where gc.game_id = p_game and gc.position = p_position;
  select artist_options, movement_options into opts, mopts from game_cards where game_id = p_game and position = p_position;

  if late then
    update answers set timed_out = true, artist_done = true
     where game_id = p_game and player_id = me and position = p_position;
    update game_players set streak = 0 where game_id = p_game and player_id = me;
  else
    years := _years_before(p_game, p_position);
    n := coalesce(array_length(years, 1), 0);
    if p_slot is null or p_slot < 0 or p_slot > n then raise exception 'bad_slot'; end if;
    ok := (p_slot = 0 or c.year >= years[p_slot]) and (p_slot = n or c.year <= years[p_slot + 1]);
    v_streak := case when ok then gp.streak + 1 else 0 end;
    if ok and g.kind = 'run' then
      pts := 1;                                   -- Monthly Run: one point per card placed right (020)
    elsif ok then
      pts := round(1000 - 500 * least(greatest(elapsed, 2) / g.answer_seconds, 1))::int
           + 50 * least(greatest(v_streak - 1, 0), 4);
    end if;
    update answers set answered_at = _now(), slot = p_slot, correct = ok,
                       ms = round(elapsed * 1000)::int, points = pts
     where game_id = p_game and player_id = me and position = p_position;
    update game_players set
      score = score + pts, correct = correct + ok::int, streak = v_streak,
      best_streak = greatest(best_streak, v_streak), total_ms = total_ms + round(elapsed * 1000)::bigint
     where game_id = p_game and player_id = me;
  end if;
  perform _recount(p_game, me);
  update games set updated_at = _now() where id = p_game;
  perform _tick(p_game);

  -- live keeps the result secret until the round closes for everyone
  return jsonb_strip_nulls(jsonb_build_object(
    'timed_out', late,
    'artist_options', case when late then null else to_jsonb(opts) end,
    'movement_options', case when late then null else to_jsonb(mopts) end,
    'correct', case when g.kind <> 'live' then (not late and ok) end,
    'points',  case when g.kind <> 'live' then pts end,
    'streak',  case when g.kind <> 'live' and not late then v_streak end));
end $$;
-- ─── 4. solo games: size limits ───
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
  if pg_column_size(p) > 60000 or char_length(coalesce(p->>'mode', '')) > 20 then raise exception 'bad_game'; end if;
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
-- ─── 5. guests can't reserve a username ───
create or replace function public.update_profile(
  p_display_name text default null, p_username text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := _me();
begin
  if p_display_name is not null and char_length(trim(p_display_name)) not between 1 and 24 then
    raise exception 'display_name_invalid';
  end if;
  if p_username is not null then
    if (select is_guest from profiles where id = me) then raise exception 'username_needs_account'; end if;
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
-- ─── 6. feedback goes with the account ───
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
  -- my feedback is deleted too (024)
  delete from feedback where player_id = me;
  -- the rest (profile, solo games, places in games, answers) goes with the account
  delete from auth.users where id = me;
end $$;

-- ─── 7. pick_artist is replaced by pick_bonus ───
revoke execute on function public.pick_artist(uuid, int, text) from public, anon, authenticated;

