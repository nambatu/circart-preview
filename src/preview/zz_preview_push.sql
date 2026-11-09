-- Preview database only: push notifications.
--   · every minute: if messages are waiting, call the send-push Edge Function
--   · every 10 minutes: queue "closes in 3 h" reminders
-- The VAPID keys are put into private.settings by hand (never in this repo):
--   insert into private.settings values ('vapid_public', '…'), ('vapid_private', '…'),
--     ('vapid_subject', 'https://<site>'), ('site', 'https://<site>');
create extension if not exists pg_net with schema extensions;
select cron.schedule('circart-push', '* * * * *',
  $$ select net.http_post(url := 'https://rzptvdlejmdeaanhbbtd.supabase.co/functions/v1/send-push',
                          body := '{}'::jsonb, timeout_milliseconds := 20000)
      where public._push_pending() $$);
select cron.schedule('circart-push-reminders', '*/10 * * * *', 'select public.queue_turn_reminders()');
