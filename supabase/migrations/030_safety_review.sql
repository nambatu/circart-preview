-- CIRCArt 030 — safety review hardening (RLS, lock contention, anti-spoiler,
-- prompt-injection guards, constant-time push secret, transfer idempotency,
-- GDPR export/retention, and game/solo validation).

-- ─── 1. Shared Daily RLS, non-identifying column grants & lock contention ────

revoke select on public.game_players from authenticated;
grant select (game_id, display_name, joined_at, dropped) on public.game_players to authenticated;

revoke select on public.games from authenticated;
grant select (
  id, kind, code, status, card_count, cards_per_turn, answer_seconds,
  turn_hours, reveal_seconds, max_players, challenge_date, current_turn,
  turn_started_at, turn_deadline, turn_closed_at, created_at, started_at,
  finished_at, updated_at, rematch_id, artist_bonus, movement_bonus,
  run_month, timed
) on public.games to authenticated;

alter function public._is_member(uuid) set search_path = public, pg_temp;

drop policy "members see their game" on public.games;
create policy "members see their game" on public.games
  for select to authenticated
  using (kind in ('live', 'async') and public._is_member(id));

drop policy "members see the players" on public.game_players;
create policy "members see the players" on public.game_players
  for select to authenticated
  using (
    public._is_member(game_id)
    and exists (select 1 from public.games g where g.id = game_id and g.kind in ('live', 'async'))
  );

-- _tick() from 009: skip row locking on active daily/run games before deadline
create or replace function public._tick(p_game uuid) returns public.games
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  g      public.games;
  turns  int;
  active int;
  done   int;
  t0     int;
  t1     int;
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

  -- async needs at least two players still in it
  if g.kind = 'async' and (select count(*) from public.game_players where game_id = g.id and not dropped) < 2 then
    if g.turn_closed_at is null then perform public._close_turn(g.id); end if;
    perform public._finish(g.id);
    select * into g from public.games where id = p_game;
    return g;
  end if;

  if g.turn_closed_at is null then
    t0 := (g.current_turn - 1) * g.cards_per_turn + 1;
    t1 := g.current_turn * g.cards_per_turn;
    select count(*) into active from public.game_players where game_id = g.id and not dropped;
    select count(*) into done
      from public.answers a join public.game_players gp on gp.game_id = a.game_id and gp.player_id = a.player_id
     where a.game_id = g.id and not gp.dropped and a.position between t0 and t1 and public._is_done(a, g);
    if public._now() <= g.turn_deadline and done < active * g.cards_per_turn then
      return g;                                       -- still playing this turn
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

-- answer() from 024: only touch games.updated_at for live/async multiplayer
create or replace function public.answer(p_game uuid, p_position int, p_slot int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me       uuid := public._me();
  g        public.games;
  gp       public.game_players;
  a        public.answers;
  c        public.cards;
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
  select * into g from public.games where id = p_game for update;
  select * into gp from public.game_players where game_id = p_game and player_id = me for update;
  if g.id is null or gp.player_id is null then raise exception 'game_not_found'; end if;
  if g.status <> 'playing' or gp.dropped then raise exception 'not_playing'; end if;
  select * into a from public.answers where game_id = p_game and player_id = me and position = p_position for update;
  if a.player_id is null or a.shown_at is null then raise exception 'card_not_open'; end if;
  if a.answered_at is not null or a.timed_out then raise exception 'already_answered'; end if;

  elapsed := extract(epoch from public._now() - a.shown_at);
  late := elapsed > g.answer_seconds + extract(epoch from public._grace());
  select c2.* into c from public.game_cards gc join public.cards c2 on c2.id = gc.card_id
   where gc.game_id = p_game and gc.position = p_position;
  select artist_options, movement_options into opts, mopts
    from public.game_cards where game_id = p_game and position = p_position;

  if late then
    update public.answers set timed_out = true, artist_done = true
     where game_id = p_game and player_id = me and position = p_position;
    update public.game_players set streak = 0 where game_id = p_game and player_id = me;
  else
    years := public._years_before(p_game, p_position);
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
    update public.answers set answered_at = public._now(), slot = p_slot, correct = ok,
                       ms = round(elapsed * 1000)::int, points = pts
     where game_id = p_game and player_id = me and position = p_position;
    update public.game_players set
      score = score + pts, correct = correct + ok::int, streak = v_streak,
      best_streak = greatest(best_streak, v_streak), total_ms = total_ms + round(elapsed * 1000)::bigint
     where game_id = p_game and player_id = me;
  end if;
  perform public._recount(p_game, me);
  if g.kind in ('live', 'async') then
    update public.games set updated_at = public._now() where id = p_game;
  end if;
  perform public._tick(p_game);

  -- live keeps the result secret until the round closes for everyone
  return jsonb_strip_nulls(jsonb_build_object(
    'timed_out', late,
    'artist_options', case when late then null else to_jsonb(opts) end,
    'movement_options', case when late then null else to_jsonb(mopts) end,
    'correct', case when g.kind <> 'live' then (not late and ok) end,
    'points',  case when g.kind <> 'live' then pts end,
    'streak',  case when g.kind <> 'live' and not late then v_streak end));
end $$;

-- pick_bonus() from 021: only touch games.updated_at for live/async multiplayer
create or replace function public.pick_bonus(p_game uuid, p_position int, p_artist text, p_movement text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me     uuid := public._me();
  g      public.games;
  a      public.answers;
  gc     public.game_cards;
  v_real text;
  v_mov  text;
  a_ok   boolean := false;
  m_ok   boolean := false;
begin
  select * into g from public.games where id = p_game for update;
  select * into a from public.answers where game_id = p_game and player_id = me and position = p_position for update;
  if g.id is null or a.player_id is null or a.answered_at is null then raise exception 'not_answered'; end if;
  if a.artist_done then raise exception 'artist_closed'; end if;
  if (g.kind = 'live' and (g.turn_closed_at is not null or public._turn_of(g, p_position) <> g.current_turn))
     or (g.kind = 'daily' and g.timed and public._now() > a.shown_at + make_interval(secs => g.answer_seconds) + public._grace())
     or (g.kind not in ('live', 'daily') and g.timed and public._now() > a.answered_at + interval '20 seconds') then
    update public.answers set artist_done = true where game_id = p_game and player_id = me and position = p_position;
    raise exception 'artist_closed';
  end if;

  select * into gc from public.game_cards where game_id = p_game and position = p_position;
  select c.artist, public._movement_group(c.movement) into v_real, v_mov from public.cards c where c.id = gc.card_id;
  if p_artist is not null and not (p_artist = any(gc.artist_options)) then raise exception 'bad_choice'; end if;
  if p_movement is not null and not (p_movement = any(gc.movement_options)) then raise exception 'bad_choice'; end if;
  a_ok := p_artist is not null and p_artist = v_real;
  m_ok := p_movement is not null and p_movement = v_mov;

  update public.answers set artist_choice = p_artist, artist_correct = a_ok,
                     movement_choice = p_movement, movement_correct = m_ok, artist_done = true,
                     points = points + case when a_ok then 200 else 0 end + case when m_ok then 100 else 0 end
   where game_id = p_game and player_id = me and position = p_position;
  update public.game_players set score = score + case when a_ok then 200 else 0 end + case when m_ok then 100 else 0 end,
                          artists_named = artists_named + a_ok::int, movements_named = movements_named + m_ok::int
   where game_id = p_game and player_id = me;
  if g.kind in ('live', 'async') then
    update public.games set updated_at = public._now() where id = p_game;
  end if;
  perform public._tick(p_game);
  return case when g.kind = 'live' then '{}'::jsonb
              else jsonb_build_object('artist_correct', a_ok, 'artist', case when p_artist is not null then v_real end,
                                      'movement_correct', m_ok, 'movement', case when p_movement is not null then v_mov end) end;
end $$;

-- ─── 2. Anti-spoiler daily_story() and my_collection() ──────────────────────

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
    'start_credit', (select credit from public.daily_theme_cards where day = d and position = 0),
    'chapters', (select coalesce(jsonb_agg(jsonb_build_object(
                   'position', tc.position, 'chapter', tc.chapter, 'chapter_de', tc.chapter_de, 'credit', tc.credit)
                   order by tc.position), '[]')
                 from public.daily_theme_cards tc
                where tc.day = d and tc.position > 0
                  and exists (select 1 from public.answers a where a.game_id = gid and a.player_id = me
                                and a.position = tc.position
                                and (a.timed_out or (a.answered_at is not null and a.artist_done)))));
end $$;

create or replace function public.my_collection() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := public._me(); seen text[]; won text[];
begin
  select coalesce(array_agg(distinct cd.source_id), '{}') into seen from (
    select gc.card_id id
      from public.solo_game_cards gc join public.solo_games g on g.id = gc.game_id
     where g.player_id = me
    union
    select c.card_id
      from public.answers a
      join public.game_cards c on c.game_id = a.game_id and c.position = a.position
      join public.games g on g.id = a.game_id
     where a.player_id = me
       and (a.timed_out or (a.answered_at is not null and a.artist_done))
       and (g.kind <> 'live' or g.status = 'finished'
            or public._turn_of(g, c.position) < g.current_turn or g.turn_closed_at is not null)
    union
    select c.card_id
      from public.game_cards c
      join public.game_players p on p.game_id = c.game_id
      join public.games g on g.id = c.game_id
     where p.player_id = me and c.position = 0 and g.status in ('playing', 'finished')
  ) s join public.cards cd on cd.id = s.id;

  select coalesce(array_agg(distinct cd.source_id), '{}') into won from (
    select gc.card_id id
      from public.solo_game_cards gc join public.solo_games g on g.id = gc.game_id
     where g.player_id = me and gc.correct
    union
    select c.card_id
      from public.answers a
      join public.game_cards c on c.game_id = a.game_id and c.position = a.position
      join public.games g on g.id = a.game_id
     where a.player_id = me and a.correct
       and (a.timed_out or (a.answered_at is not null and a.artist_done))
       and (g.kind <> 'live' or g.status = 'finished'
            or public._turn_of(g, c.position) < g.current_turn or g.turn_closed_at is not null)
  ) w join public.cards cd on cd.id = w.id;

  return jsonb_build_object('seen', to_jsonb(seen), 'correct', to_jsonb(won));
end $$;

alter function public.my_achievements() set search_path = public, pg_temp;

-- ─── 3. Prompt injection & display name guards ──────────────────────────────

create or replace function public.injection_scan(p text) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  cleaned text := public.clean_player_text(p);
  t       text := lower(normalize(coalesce(cleaned, ''), NFKC));
  score   int := 0;
  flags   text[] := '{}';
  r       record;
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
  if p is not null and p <> cleaned then
    score := score + 2; flags := flags || 'hidden_chars'::text;
  end if;
  return jsonb_build_object('score', score, 'flags', to_jsonb(flags));
end $$;

create or replace function public._guard_feedback() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s jsonb;
  k text;
  v text;
begin
  s := public.injection_scan(concat_ws(E'\n',
    new.topic, new.message,
    case when jsonb_typeof(new.context) = 'object' then new.context->>'page' end,
    case when jsonb_typeof(new.context) = 'object' then new.context->>'ua' end,
    case when jsonb_typeof(new.context) = 'object' then new.context->>'app' end));
  new.topic   := coalesce(nullif(public.clean_player_text(new.topic), ''), 'Other');
  new.message := coalesce(nullif(public.clean_player_text(new.message), ''), '(empty)');
  if jsonb_typeof(new.context) = 'object' then
    foreach k in array array['page', 'ua', 'app'] loop
      if new.context ? k then
        v := case when jsonb_typeof(new.context->k) = 'string'
                  then nullif(public.clean_player_text(new.context->>k), '') end;
        if v is null then
          new.context := new.context - k;
        else
          new.context := jsonb_set(new.context, array[k], to_jsonb(v));
        end if;
      end if;
    end loop;
  end if;
  new.risk := (s->>'score')::int;
  new.risk_flags := array(select jsonb_array_elements_text(s->'flags'));
  if new.risk >= 2 and new.status in ('new', 'read') then new.status := 'quarantined'; end if;
  return new;
end $$;

drop trigger if exists feedback_guard on public.feedback;
create trigger feedback_guard before insert or update of topic, message, context on public.feedback
  for each row execute function public._guard_feedback();

-- re-scan existing open feedback rows (incl. context) with the updated guard
update public.feedback set context = context
 where status in ('new', 'read') or context ?| array['page', 'ua', 'app'];

create or replace function public.feedback_inbox(p_statuses text[] default '{new,quarantined}', p_limit int default 50)
returns table (id bigint, created_at timestamptz, status text, topic text, preview text,
               card_source_id text, risk int, risk_flags text[], from_account boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id, f.created_at, f.status,
         case when f.status = 'quarantined' or f.risk >= 2
              then '[flagged]'
              else left(f.topic, 40) end,
         case when f.status = 'quarantined' or f.risk >= 2
              then '[flagged: ' || array_to_string(f.risk_flags, ', ') || '] '
                   || left(regexp_replace(f.message, '[<>`{}\[\]|$\\]', ' ', 'g'), 60) || '…'
              else left(f.message, 600) end,
         f.card_source_id, f.risk, f.risk_flags, f.player_id is not null
    from public.feedback f
   where f.status = any(p_statuses)
   order by f.created_at
   limit greatest(1, least(p_limit, 200))
$$;

create or replace function public._guard_display_name() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.display_name is not null then
    new.display_name := public.clean_player_text(new.display_name);
    if new.display_name = '' or (public.injection_scan(new.display_name)->>'score')::int >= 2 then
      raise exception 'display_name_invalid';
    end if;
  end if;
  return new;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  given text := public.clean_player_text(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'));
  word  text := nullif(split_part(trim(given), ' ', 1), '');
  name  text;
begin
  if word is null or (public.injection_scan(word)->>'score')::int >= 2 then
    name := 'Guest ' || lpad((floor(random() * 10000))::int::text, 4, '0');
  else
    name := left(word, 24);
  end if;
  insert into public.profiles (id, display_name, is_guest)
  values (new.id, name, coalesce(new.is_anonymous, false));
  return new;
end $$;

-- ─── 4. Push, Guest transfer, GDPR, Solo & Game integrity ───────────────────

alter function public._push_batch_unchecked() set search_path = public, pg_temp;

create or replace function public.push_batch(p_secret text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  expected text;
  d_given  bytea;
  d_expect bytea;
  diff     int := 0;
  i        int;
begin
  select value into expected from private.settings where key = 'push_cron_secret';
  if p_secret is null or expected is null or expected = '' then
    raise exception 'push_forbidden';
  end if;
  d_given  := sha256(convert_to(p_secret, 'utf8'));
  d_expect := sha256(convert_to(expected, 'utf8'));
  for i in 0..31 loop
    diff := diff | (get_byte(d_given, i) # get_byte(d_expect, i));
  end loop;
  if diff <> 0 then
    raise exception 'push_forbidden';
  end if;
  return public._push_batch_unchecked();
end $$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me();
begin
  if p_endpoint is null or p_p256dh is null or p_auth is null
     or p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or length(p_p256dh) > 200 or length(p_auth) > 100
     or p_endpoint ~ '[[:space:]\x00-\x1f\x7f]'
     or not public._push_host_ok(p_endpoint) then
    raise exception 'bad_settings';
  end if;
  insert into public.push_subscriptions (endpoint, player_id, p256dh, auth, user_agent)
  values (p_endpoint, me, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
                                       user_agent = excluded.user_agent
   where public.push_subscriptions.player_id = me;
  if (select count(*) from public.push_subscriptions where player_id = me) > 10 then
    delete from public.push_subscriptions where endpoint in (
      select endpoint from public.push_subscriptions where player_id = me order by created_at desc offset 10);
  end if;
end $$;

alter function public.start_guest_transfer() set search_path = public, auth, pg_temp;

create or replace function public.finish_guest_transfer(p_token text) returns jsonb
language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare
  me     uuid := public._me();
  guest  uuid;
  n_solo int; n_games int; n_packs int;
begin
  if exists (select 1 from auth.users where id = me and coalesce(is_anonymous, false)) then
    raise exception 'not_signed_in';
  end if;
  delete from public.guest_transfers
   where token = p_token and created_at > now() - interval '15 minutes'
  returning guest_id into guest;
  if guest is null or guest = me
     or not exists (select 1 from auth.users where id = guest and coalesce(is_anonymous, false)) then
    return jsonb_build_object('moved', false);
  end if;

  -- solo games (a game already saved for the account wins)
  delete from public.solo_games g where g.player_id = guest
     and exists (select 1 from public.solo_games x where x.player_id = me and x.client_id = g.client_id);
  update public.solo_games set player_id = me where player_id = guest;
  get diagnostics n_solo = row_count;

  -- card packs
  insert into public.player_packs (player_id, pack_id, unlocked_at, seen)
  select me, pack_id, unlocked_at, seen from public.player_packs where player_id = guest
  on conflict (player_id, pack_id) do nothing;
  get diagnostics n_packs = row_count;

  -- games with friends, unless the account plays in the same game already
  create temp table if not exists _moving (game_id uuid) on commit drop;
  truncate _moving;
  insert into _moving (game_id)
  select gp.game_id from public.game_players gp join public.games g on g.id = gp.game_id
   where gp.player_id = guest and g.kind in ('live', 'async')
     and not exists (select 1 from public.game_players x where x.game_id = gp.game_id and x.player_id = me);
  update public.game_players set player_id = me where player_id = guest and game_id in (select game_id from _moving);
  get diagnostics n_games = row_count;
  update public.answers set player_id = me where player_id = guest and game_id in (select game_id from _moving);
  update public.games set host_id = me where host_id = guest and id in (select game_id from _moving);

  -- any unmoved lobby hosted by the guest loses its host once the guest is deleted
  update public.games set status = 'cancelled', updated_at = public._now()
   where host_id = guest and status = 'lobby';

  -- devices (keep newest 10 for the account) and feedback
  update public.push_subscriptions set player_id = me where player_id = guest;
  if (select count(*) from public.push_subscriptions where player_id = me) > 10 then
    delete from public.push_subscriptions where endpoint in (
      select endpoint from public.push_subscriptions where player_id = me order by created_at desc offset 10);
  end if;
  update public.feedback set player_id = me where player_id = guest;

  delete from auth.users where id = guest;

  return jsonb_build_object('moved', true, 'solo_games', n_solo, 'games', n_games, 'packs', n_packs);
end $$;

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
    'join_failures', (select coalesce(jsonb_agg(jsonb_build_object('at', jf.at) order by jf.at), '[]')
                        from public.join_failures jf where jf.player_id = me),
    'guest_transfers', (select coalesce(jsonb_agg(jsonb_build_object('created_at', gt.created_at) order by gt.created_at), '[]')
                          from public.guest_transfers gt where gt.guest_id = me),

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
  t   timestamptz := public._now();
  n_guests int; n_push int; n_outbox int; n_lobby int; n_orphan int; n_fb_strip int; n_fb_del int;
begin
  with idle as (
    select p.id from public.profiles p
     where p.is_guest and coalesce(public._last_active(p.id), p.created_at) < t - p_guest_idle)
  delete from auth.users u using idle where u.id = idle.id and coalesce(u.is_anonymous, true);
  get diagnostics n_guests = row_count;

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

  return jsonb_build_object('guests_deleted', n_guests, 'push_devices_removed', n_push,
    'push_messages_deleted', n_outbox, 'stale_games_deleted', n_lobby, 'empty_games_deleted', n_orphan,
    'feedback_stripped', n_fb_strip, 'feedback_deleted', n_fb_del);
end $$;

create or replace function public.leave_game(p_game uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := public._me(); g public.games;
begin
  select * into g from public.games where id = p_game for update;
  if g.id is null or not exists (select 1 from public.game_players where game_id = g.id and player_id = me) then
    raise exception 'game_not_found';
  end if;
  if g.kind not in ('live', 'async') then
    raise exception 'bad_settings';
  end if;
  if g.status = 'lobby' then
    delete from public.game_players where game_id = g.id and player_id = me;
    if g.host_id = me then
      update public.games set host_id = (select player_id from public.game_players where game_id = g.id order by joined_at limit 1)
       where id = g.id;
      update public.games set status = 'cancelled' where id = g.id and host_id is null;
    end if;
  else
    update public.game_players set dropped = true where game_id = g.id and player_id = me;
  end if;
  update public.games set updated_at = public._now() where id = g.id;
  perform public._tick(g.id);
end $$;

create or replace function public.create_game(
  p_kind text, p_card_count int default null, p_cards_per_turn int default null,
  p_display_name text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me    uuid := public._me();
  name  text := public._set_display_name(p_display_name);
  n     int;
  g     public.games;
begin
  if p_kind not in ('live', 'async') then raise exception 'bad_settings'; end if;
  n := coalesce(p_card_count, case p_kind when 'live' then 10 else 12 end);
  if n not between 3 and 30 then raise exception 'bad_settings'; end if;
  if (select count(*) from public.games where host_id = me and status = 'lobby') >= 5
     or (select count(*) from public.games where host_id = me and created_at > public._now() - interval '1 hour') >= 30 then
    raise exception 'too_many_games';
  end if;
  insert into public.games (kind, code, host_id, card_count, cards_per_turn, turn_hours, max_players)
  values (p_kind, public._new_code(), me,
          n,
          case p_kind when 'live' then 1 else coalesce(p_cards_per_turn, 3) end,
          case p_kind when 'async' then 24 end,
          case p_kind when 'live' then 20 else 8 end)
  returning * into g;
  insert into public.game_players (game_id, player_id, display_name) values (g.id, me, name);
  return jsonb_build_object('id', g.id, 'code', g.code);
exception when check_violation then
  raise exception 'bad_settings';
end $$;

create or replace function public.submit_solo_game(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me        uuid := public._me();
  gid       uuid;
  cards     jsonb := coalesce(p->'cards', '[]');
  n_rounds  int;
  n_correct int;
  unknown   int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'bad_game'; end if;
  if jsonb_typeof(cards) <> 'array' or jsonb_array_length(cards) < 2 then raise exception 'bad_game'; end if;
  if (select count(*) from public.solo_games where player_id = me and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'too_many_games';
  end if;
  if jsonb_array_length(cards) > 101 then raise exception 'bad_game'; end if;
  if pg_column_size(p) > 60000
     or coalesce(p->>'mode', 'classic') !~ '^[a-z0-9_-]{1,20}$'
     or p->>'score' is null then
    raise exception 'bad_game';
  end if;
  n_rounds  := jsonb_array_length(cards) - 1;
  n_correct := (select count(*) from jsonb_array_elements(cards) with ordinality c(v, i)
                where i > 1 and (v->>'correct')::boolean);

  if (p->>'score')::int < 0
     or coalesce((p->>'bonus_points')::int, 0) < 0
     or coalesce((p->>'bonus_points')::int, 0) > n_rounds * 4
     or coalesce((p->>'best_streak')::int, 0) not between 0 and n_rounds
     or (p->>'score')::int > n_correct + coalesce((p->>'bonus_points')::int, 0)
     or (p->>'score')::int > n_rounds * 5 then
    raise exception 'bad_game';
  end if;

  insert into public.solo_games (player_id, client_id, mode, rounds, score, placements_correct,
                          bonus_points, best_streak, started_at, finished_at)
  values (me, (p->>'client_id')::uuid, coalesce(p->>'mode', 'classic'), n_rounds,
          (p->>'score')::int, n_correct, coalesce((p->>'bonus_points')::int, 0),
          coalesce((p->>'best_streak')::int, 0),
          (p->>'started_at')::timestamptz, coalesce((p->>'finished_at')::timestamptz, now()))
  on conflict (player_id, client_id) do nothing
  returning id into gid;

  if gid is null then
    select id into gid from public.solo_games where player_id = me and client_id = (p->>'client_id')::uuid;
    return jsonb_build_object('id', gid, 'duplicate', true);
  end if;

  insert into public.solo_game_cards (game_id, position, card_id, correct, artist_bonus, title_bonus, year_bonus)
  select gid, (i - 1)::int, k.id,
         case when i = 1 then null else coalesce((v->>'correct')::boolean, false) end,
         coalesce((v->>'artist')::boolean, false),
         coalesce((v->>'title')::boolean, false),
         coalesce((v->>'year')::boolean, false)
  from jsonb_array_elements(cards) with ordinality c(v, i)
  join public.cards k on k.source_id = v->>'id';

  unknown := jsonb_array_length(cards) - (select count(*) from public.solo_game_cards where game_id = gid);
  return jsonb_build_object('id', gid, 'duplicate', false, 'unknown_cards', unknown);
end $$;

-- ─── 5. Explicit execute permissions on every added/replaced function ───────

revoke execute on function
  public._tick(uuid),
  public.answer(uuid, int, int),
  public.pick_bonus(uuid, int, text, text),
  public.daily_story(date),
  public.my_collection(),
  public.injection_scan(text),
  public._guard_feedback(),
  public.feedback_inbox(text[], int),
  public._guard_display_name(),
  public.handle_new_user(),
  public.push_batch(text),
  public.save_push_subscription(text, text, text, text),
  public.finish_guest_transfer(text),
  public.export_my_data(),
  public.privacy_cleanup(interval, interval, interval, interval, interval),
  public.leave_game(uuid),
  public.create_game(text, int, int, text),
  public.submit_solo_game(jsonb)
  from public, anon, authenticated;

grant execute on function
  public.answer(uuid, int, int),
  public.pick_bonus(uuid, int, text, text),
  public.daily_story(date),
  public.my_collection(),
  public.save_push_subscription(text, text, text, text),
  public.finish_guest_transfer(text),
  public.export_my_data(),
  public.leave_game(uuid),
  public.create_game(text, int, int, text),
  public.submit_solo_game(jsonb)
  to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      public.push_batch(text),
      public.privacy_cleanup(interval, interval, interval, interval, interval)
      to service_role;
  end if;
end $$;
