-- Preview database only: "Send me a test notification" (Profile).
-- Queues one message for every device of the caller; the send-push job
-- delivers it within a minute. At most one test per minute.
create function public.preview_test_push() returns boolean
language plpgsql security definer set search_path = public as $$
declare me uuid := _me();
begin
  if not exists (select 1 from push_subscriptions where player_id = me) then return false; end if;
  if exists (select 1 from push_outbox where player_id = me and kind = 'test' and created_at > now() - interval '1 minute') then
    return true;
  end if;
  insert into push_outbox (player_id, kind, game_id, turn, title, body, url)
  values (me, 'test', null, extract(epoch from now())::int, 'CIRCArt test 🔔',
          'Notifications work on this device. Tap to open the app.', './');
  return true;
end $$;
revoke execute on function public.preview_test_push() from public, anon;
grant execute on function public.preview_test_push() to authenticated;
