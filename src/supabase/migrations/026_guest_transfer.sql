-- CIRCArt 026 — take a guest's games along when signing in to an existing account.
--
-- Julian (19 Nov): someone who played as a guest on a device and then signs in
-- to the account they already have should keep what they played there.
--
-- How it works:
--   1. Still signed in as the guest, the app calls start_guest_transfer() and
--      gets a one-time ticket (valid 15 minutes). The ticket proves that the
--      caller really was that guest; nobody can pull in someone else's guest.
--   2. The app signs in to the existing account (email code).
--   3. Now signed in to the account, it calls finish_guest_transfer(ticket).
--      The guest's things move to the account and the guest is deleted.
--
-- What moves: solo games, card packs, games with friends (live + async, unless
-- the account is in the same game already), notification devices, feedback.
-- What does NOT move (on purpose): the daily challenge and Monthly Run results.
-- Otherwise someone could play the daily as a guest and only take the result
-- along when it was good: a free second try on everything that is ranked.
-- Guests never appear on the rankings, so nothing visible is lost.

create table public.guest_transfers (
  token      text primary key,
  guest_id   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.guest_transfers enable row level security;
revoke all on public.guest_transfers from anon, authenticated;

create function public.start_guest_transfer() returns text
language plpgsql security definer set search_path = public, auth as $$
declare me uuid := _me(); tok text;
begin
  if not exists (select 1 from auth.users where id = me and coalesce(is_anonymous, false)) then
    raise exception 'not_a_guest';
  end if;
  delete from guest_transfers where guest_id = me or created_at < now() - interval '1 day';
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into guest_transfers (token, guest_id) values (tok, me);
  return tok;
end $$;

create function public.finish_guest_transfer(p_token text) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  me     uuid := _me();
  guest  uuid;
  n_solo int; n_games int; n_packs int;
begin
  if exists (select 1 from auth.users where id = me and coalesce(is_anonymous, false)) then
    raise exception 'not_signed_in';                       -- the target must be a real account
  end if;
  delete from guest_transfers
   where token = p_token and created_at > now() - interval '15 minutes'
  returning guest_id into guest;                           -- one-time: the ticket is used up
  if guest is null or guest = me
     or not exists (select 1 from auth.users where id = guest and coalesce(is_anonymous, false)) then
    return jsonb_build_object('moved', false);
  end if;

  -- solo games (a game already saved for the account wins)
  delete from solo_games g where g.player_id = guest
     and exists (select 1 from solo_games x where x.player_id = me and x.client_id = g.client_id);
  update solo_games set player_id = me where player_id = guest;
  get diagnostics n_solo = row_count;

  -- card packs
  insert into player_packs (player_id, pack_id, unlocked_at, seen)
  select me, pack_id, unlocked_at, seen from player_packs where player_id = guest
  on conflict (player_id, pack_id) do nothing;
  get diagnostics n_packs = row_count;

  -- games with friends, unless the account plays in the same game already
  create temp table _moving on commit drop as
    select gp.game_id from game_players gp join games g on g.id = gp.game_id
     where gp.player_id = guest and g.kind in ('live', 'async')
       and not exists (select 1 from game_players x where x.game_id = gp.game_id and x.player_id = me);
  update game_players set player_id = me where player_id = guest and game_id in (select game_id from _moving);
  get diagnostics n_games = row_count;
  update answers set player_id = me where player_id = guest and game_id in (select game_id from _moving);
  update games set host_id = me where host_id = guest and id in (select game_id from _moving);

  -- devices and feedback
  update push_subscriptions set player_id = me where player_id = guest;
  update feedback set player_id = me where player_id = guest;

  -- the rest (daily + run results, the guest profile) goes with the guest
  delete from auth.users where id = guest;

  return jsonb_build_object('moved', true, 'solo_games', n_solo, 'games', n_games, 'packs', n_packs);
end $$;

revoke execute on function public.start_guest_transfer(), public.finish_guest_transfer(text)
  from public, anon, authenticated;
grant execute on function public.start_guest_transfer(), public.finish_guest_transfer(text) to authenticated;
