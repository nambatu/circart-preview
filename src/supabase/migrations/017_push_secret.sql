-- CIRCArt 017 — the send-push Edge Function only works for our own cron job.
--
-- send-push runs without JWT checks (pg_cron can't sign in). Until now anyone
-- who knew its URL could make it flush the queue. Now:
--   · a random secret is created once in private.settings ('push_cron_secret');
--     it never leaves the database except in the cron job's request header
--   · the cron job sends it as the header x-cron-secret
--   · the function passes the header on to push_batch(p_secret), which refuses
--     with 'push_forbidden' when it doesn't match (the function answers 401)
-- No secret is stored in any repo or dashboard.

insert into private.settings (key, value)
values ('push_cron_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

alter function public.push_batch() rename to _push_batch_unchecked;
revoke execute on function public._push_batch_unchecked() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function public._push_batch_unchecked() from service_role;
  end if;
end $$;

create function public.push_batch(p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_secret is null or p_secret is distinct from (select value from private.settings where key = 'push_cron_secret') then
    raise exception 'push_forbidden';
  end if;
  return _push_batch_unchecked();
end $$;

revoke execute on function public.push_batch(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.push_batch(text) to service_role;
  end if;
end $$;
