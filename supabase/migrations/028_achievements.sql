-- CIRCArt 028 — more badges. Computed from games already played, never stored,
-- so nobody can award themselves one. my_badges() (010, monthly podium) stays.
create function public.my_achievements() returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select gp.*, g.kind, g.status,
           (select count(*) from game_players x where x.game_id = g.id) as n_players,
           (select max(x.score) from game_players x where x.game_id = g.id and x.player_id <> gp.player_id) as best_other
      from game_players gp join games g on g.id = gp.game_id
     where gp.player_id = _me() and gp.answered > 0),
  b(key, tier) as (
    select 'daily_streak', t from unnest(array[7, 30, 100]) t
     where _longest_daily_streak(_me()) >= t
    union all
    select 'perfect_daily', least(count(*), 10)::int from mine
     where kind = 'daily' and answered >= 5 and correct = answered having count(*) > 0
    union all
    select 'signature_spotter', 100 where coalesce((select sum(artists_named) from mine), 0) >= 100
    union all
    select 'photo_finish', count(*)::int from mine
     where kind in ('live','async') and status = 'finished' and final_rank = 1
       and n_players >= 2 and score - best_other < 100 having count(*) > 0)
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'tier', tier) order by key, tier), '[]') from b
$$;

revoke execute on function public.my_achievements() from public, anon, authenticated;
grant execute on function public.my_achievements() to authenticated;
