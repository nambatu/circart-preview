-- CIRCArt 034 — rough player region from the device's time zone (Admin, 24 Nov).
--
-- For the usage dashboard: players by country or region, never by city and
-- never from the IP address. When someone plays online, the app sends the
-- device's time zone name (for example "Europe/Vienna"), and it is kept on the
-- player's profile. Only names Postgres knows are accepted. It is deleted with
-- the account (it lives on profiles) and is part of "Download my data".

alter table public.profiles add column if not exists time_zone text
  check (time_zone is null or char_length(time_zone) <= 64);

create function public.set_my_time_zone(p_tz text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := _me();
begin
  if p_tz is null or char_length(p_tz) > 64
     or not exists (select 1 from pg_timezone_names where name = p_tz) then
    return;                                    -- unknown name: ignore quietly
  end if;
  update profiles set time_zone = p_tz where id = me and time_zone is distinct from p_tz;
end $$;

revoke execute on function public.set_my_time_zone(text) from public, anon, authenticated;
grant execute on function public.set_my_time_zone(text) to authenticated;
