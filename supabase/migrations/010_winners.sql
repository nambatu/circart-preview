-- CIRCArt 010 — Monthly Run winners: last month's top 3 and profile badges.
--
-- Once a month is over, the top 3 of its Monthly Run board are its winners.
-- monthly_winners(month): the podium of a finished month (default: last month),
--   for the "Last month's winners" strip on the Ranks tab.
-- my_badges(): every finished month where I made the top 3, for the profile.
-- Both read the same board as monthly_leaderboard (_run_ranked from 009), so
-- ties share a rank and guests / players without a username never appear.

create function public.monthly_winners(p_month date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   uuid := _me();
  cur  date := date_trunc('month', _today())::date;
  m    date := date_trunc('month', coalesce(p_month, cur - 1))::date;
  rule monthly_challenges;
begin
  if m >= cur then return null; end if;              -- not over yet: no winners
  rule := _month_rule(m);
  return jsonb_build_object(
    'month', m, 'title', rule.title,
    'players', (select count(*) from _run_ranked(m)),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'value', value, 'is_me', player_id = me) order by rk, username), '[]')
                from _run_ranked(m) where rk <= 3));
end $$;

create function public.my_badges() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := _me();
  cur date := date_trunc('month', _today())::date;
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'month', m, 'title', (_month_rule(m)).title, 'rank', r.rk, 'value', r.value) order by m desc), '[]')
            from (select distinct g.run_month m from games g join game_players gp on gp.game_id = g.id
                   where g.kind = 'run' and gp.player_id = me and g.run_month < cur) months
            cross join lateral (select rk, value from _run_ranked(months.m) x where x.player_id = me) r
           where r.rk <= 3);
end $$;

revoke execute on function public.monthly_winners(date), public.my_badges() from public, anon, authenticated;
grant execute on function public.monthly_winners(date), public.my_badges() to authenticated;
