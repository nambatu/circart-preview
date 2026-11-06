-- CIRCArt 016 — German texts for the monthly themes.
--
-- monthly_challenges gets title_de / description_de. The four functions that
-- show a month's theme (Monthly Run card, Ranks → Month, last month's
-- winners, profile badges) now also return title_de (+ description_de), and
-- the app picks them when the language is German. Same functions as in
-- 009 / 010, only the extra fields are new.

alter table public.monthly_challenges add column title_de text, add column description_de text;

update public.monthly_challenges set title_de = d.t, description_de = d.txt
  from (values
    ('2026-11-01'::date, 'Meisterwerk-Marathon', 'Die ganze Kunstgeschichte in einem langen Marathon. Teil dir die Kräfte gut ein!'),
    ('2026-12-01'::date, 'Barock & Goldenes Zeitalter', 'Von Caravaggio bis Canaletto, von 1580 bis 1800. Hier steckt Drama in jedem Rahmen.'),
    ('2027-01-01'::date, 'Der moderne Bruch', 'Vom Impressionismus bis zum Surrealismus. In diesen Jahren hat die Kunst jede Regel gebrochen.'),
    ('2027-02-01'::date, 'Renaissance', 'Von Giotto bis zur späten Renaissance. Damals haben die Maler die Perspektive entdeckt.'),
    ('2027-03-01'::date, 'Nach 1945', 'Von Pollock bis Banksy. Nach 1945 malt die Kunst gern über den Rand hinaus.')
  ) as d(m, t, txt)
 where month = d.m and title_de is null;

create or replace function public.monthly_leaderboard(p_month date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  m      date := date_trunc('month', coalesce(p_month, _today()))::date;
  rule   monthly_challenges := _month_rule(m);
  v_rank bigint; v_val int; v_best int; v_runs bigint;
begin
  select rk, value into v_rank, v_val from _run_ranked(m) where player_id = me;
  select best, runs into v_best, v_runs from _run_best(m) where player_id = me;
  return jsonb_build_object(
    'month', m, 'title', rule.title, 'description', rule.description, 'metric', 'best_run',
    'title_de', rule.title_de, 'description_de', rule.description_de,
    'days_left', greatest(0, ((m + interval '1 month')::date - _today())),
    'players', (select count(*) from _run_ranked(m)),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'value', value, 'is_me', player_id = me) order by rk, username), '[]')
                from (select * from _run_ranked(m) order by rk limit 50) t),
    'me', case when v_best is null then null else jsonb_build_object(
            'rank', v_rank, 'value', coalesce(v_val, v_best), 'best', v_best, 'runs', v_runs,
            'ranked', v_rank is not null) end);
end $$;

create or replace function public.run_summary() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     uuid := _me();
  m      date := date_trunc('month', _today())::date;
  rule   monthly_challenges := _month_rule(_today());
  v_rank bigint; v_val int; v_best int; v_runs bigint;
  a_user text; a_val int;
  act    uuid;
begin
  select rk, value into v_rank, v_val from _run_ranked(m) where player_id = me;
  select best, runs into v_best, v_runs from _run_best(m) where player_id = me;
  if v_rank is not null then
    select username, value into a_user, a_val from _run_ranked(m) where value > v_val order by value, username limit 1;
  end if;
  select g.id into act from games g join game_players gp on gp.game_id = g.id and gp.player_id = me
   where g.kind = 'run' and g.status = 'playing' and g.run_month = m and g.turn_deadline > _now()
   order by g.created_at desc limit 1;
  return jsonb_build_object(
    'month', m, 'title', rule.title, 'description', rule.description,
    'title_de', rule.title_de, 'description_de', rule.description_de,
    'days_left', greatest(0, ((m + interval '1 month')::date - _today())),
    'players', (select count(*) from _run_ranked(m)),
    'best', v_best, 'runs', coalesce(v_runs, 0), 'rank', v_rank,
    'above', case when a_user is null then null else jsonb_build_object('username', a_user, 'value', a_val) end,
    'active', act, 'server_now', _now());
end $$;

create or replace function public.monthly_winners(p_month date default null) returns jsonb
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
    'month', m, 'title', rule.title, 'title_de', rule.title_de,
    'players', (select count(*) from _run_ranked(m)),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'username', username,
                  'value', value, 'is_me', player_id = me) order by rk, username), '[]')
                from _run_ranked(m) where rk <= 3));
end $$;

create or replace function public.my_badges() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := _me();
  cur date := date_trunc('month', _today())::date;
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'month', m, 'title', (_month_rule(m)).title, 'title_de', (_month_rule(m)).title_de, 'rank', r.rk, 'value', r.value) order by m desc), '[]')
            from (select distinct g.run_month m from games g join game_players gp on gp.game_id = g.id
                   where g.kind = 'run' and gp.player_id = me and g.run_month < cur) months
            cross join lateral (select rk, value from _run_ranked(months.m) x where x.player_id = me) r
           where r.rk <= 3);
end $$;
