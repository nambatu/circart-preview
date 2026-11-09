-- CIRCArt 012 — card packs, earned by playing.
--
-- A pack is a themed set of extra cards ("Baroque Masters", "German Artists").
-- Each pack has an unlock rule that is checked against what the player has
-- already done, so progress needs no extra bookkeeping:
--   {"type": "runs_finished",  "n": 3}   finished Monthly Runs
--   {"type": "daily_streak",   "n": 3}   longest daily-challenge streak
--   {"type": "dailies_played", "n": 5}   daily challenges played
--   {"type": "games_won",      "n": 1}   live/async games won (2+ players)
--   {"type": "solo_games",     "n": 5}   saved solo games
--   {"type": "free"}                     everyone has it
-- price_cents is reserved for selling packs later; nothing reads it yet.
--
-- Pack cards are stored in `cards` with pack_id set and active = false, so
-- the daily, runs and games with friends never deal them (fair for everyone);
-- they exist so saved solo games can reference them. The solo game gets them
-- from docs/packs/<id>.json and mixes in the packs this player has unlocked.

create table public.packs (
  id           text primary key,
  title        text not null,
  title_de     text,
  description  text not null,
  description_de text,
  unlock_rule  jsonb not null default '{"type": "free"}',
  unlock_text  text not null,                -- "Finish 3 Monthly Runs"
  unlock_text_de text,
  price_cents  int,                          -- later: buyable packs
  sort         int not null default 100,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table public.packs enable row level security;
revoke all on public.packs from anon, authenticated;

alter table public.cards add column pack_id text references public.packs(id);
create index cards_pack on public.cards (pack_id) where pack_id is not null;

-- when a player first had a pack (for the "New pack!" moment and the collection)
create table public.player_packs (
  player_id   uuid not null references public.profiles(id) on delete cascade,
  pack_id     text not null references public.packs(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  seen        boolean not null default false,
  primary key (player_id, pack_id)
);
alter table public.player_packs enable row level security;
revoke all on public.player_packs from anon, authenticated;

insert into public.packs (id, title, title_de, description, description_de, unlock_rule, unlock_text, unlock_text_de, sort) values
  ('baroque-masters', 'Baroque Masters', 'Meister des Barock',
   'Drama, candlelight and gold: 25 works from Rubens to Vermeer.',
   'Drama, Kerzenlicht und Gold: 25 Werke von Rubens bis Vermeer.',
   '{"type": "runs_finished", "n": 3}', 'Finish 3 Monthly Runs', 'Beende 3 Monats-Runs', 10),
  ('german-artists', 'German Artists', 'Deutsche Künstler',
   'From Dürer to the Blue Rider: 25 works by German-speaking artists.',
   'Von Dürer bis zum Blauen Reiter: 25 Werke deutschsprachiger Künstler.',
   '{"type": "daily_streak", "n": 3}', 'Play the daily challenge 3 days in a row', 'Spiel die Tages-Challenge 3 Tage in Folge', 20)
on conflict (id) do nothing;

-- how far a player is with one rule
create function public._pack_progress(p_player uuid, p_rule jsonb) returns int
language plpgsql stable security definer set search_path = public as $$
declare t text := p_rule->>'type';
begin
  return case t
    when 'free' then 0
    when 'runs_finished' then (select count(*) from games g join game_players gp on gp.game_id = g.id
                                where gp.player_id = p_player and g.kind = 'run' and g.status = 'finished' and gp.answered > 0)
    when 'daily_streak' then _longest_daily_streak(p_player)
    when 'dailies_played' then (select count(*) from games g join game_players gp on gp.game_id = g.id
                                 where gp.player_id = p_player and g.kind = 'daily' and gp.answered > 0)
    when 'games_won' then (select count(*) from game_players gp join games g on g.id = gp.game_id
                            where gp.player_id = p_player and g.kind in ('live', 'async') and g.status = 'finished'
                              and gp.final_rank = 1 and (select count(*) from game_players x where x.game_id = g.id) >= 2)
    when 'solo_games' then (select count(*) from solo_games where player_id = p_player)
    else 0 end;
end $$;

-- All packs with my progress. Newly reached packs are recorded here, and
-- reported once with "new": true (until mark_packs_seen).
create function public.my_packs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); p record; prog int; need int;
begin
  for p in select * from packs where active loop
    prog := _pack_progress(me, p.unlock_rule);
    need := coalesce((p.unlock_rule->>'n')::int, 0);
    if prog >= need then
      insert into player_packs (player_id, pack_id) values (me, p.id) on conflict do nothing;
    end if;
  end loop;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', k.id, 'title', k.title, 'title_de', k.title_de,
            'description', k.description, 'description_de', k.description_de,
            'unlock_text', k.unlock_text, 'unlock_text_de', k.unlock_text_de,
            'progress', least(_pack_progress(me, k.unlock_rule), coalesce((k.unlock_rule->>'n')::int, 0)),
            'needed', coalesce((k.unlock_rule->>'n')::int, 0),
            'unlocked', pp.player_id is not null,
            'new', pp.player_id is not null and not pp.seen,
            'cards', (select count(*) from cards c where c.pack_id = k.id)) order by k.sort, k.id), '[]')
          from packs k left join player_packs pp on pp.pack_id = k.id and pp.player_id = me
         where k.active);
end $$;

create function public.mark_packs_seen() returns void
language sql security definer set search_path = public as $$
  update player_packs set seen = true where player_id = _me() and not seen
$$;

-- "Download my data" (011) now includes unlocked packs
create or replace function public.export_my_data() returns jsonb
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
    'card_packs', (select coalesce(jsonb_agg(jsonb_build_object(
                      'pack', pp.pack_id, 'unlocked_at', pp.unlocked_at) order by pp.unlocked_at), '[]')
                     from player_packs pp where pp.player_id = me),

    'stored_on_this_device', 'The app also keeps settings (language, theme, onboarding seen, '
      || 'unsent solo games, sign-in session) in your browser''s local storage. '
      || 'They never leave your device except the session, which signs you in.');
end $$;

revoke execute on function public._pack_progress(uuid, jsonb), public.my_packs(), public.mark_packs_seen()
  from public, anon, authenticated;
grant execute on function public.my_packs(), public.mark_packs_seen() to authenticated;
