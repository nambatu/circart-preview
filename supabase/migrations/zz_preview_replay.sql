-- Preview database only: the daily challenge can be replayed for testing.
-- preview_reset_daily() removes your attempt at today's daily (answers and
-- your place on today's board), so play_daily() starts you from card 1 again.
create function public.preview_reset_daily() returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := _me(); gid uuid;
begin
  select id into gid from games where challenge_date = _today();
  if gid is null then return; end if;
  delete from answers where game_id = gid and player_id = me;
  delete from game_players where game_id = gid and player_id = me;
end $$;
revoke execute on function public.preview_reset_daily() from public, anon;
grant execute on function public.preview_reset_daily() to authenticated;
