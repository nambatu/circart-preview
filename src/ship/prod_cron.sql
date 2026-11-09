-- CIRCArt PRODUCTION database: scheduled jobs.
-- Run once in the production project's SQL editor, AFTER migrations 001–007
-- and after the send-push Edge Function is deployed.
-- (Production equivalent of preview/zz_preview_cron.sql + zz_preview_push.sql;
--  do not run those preview files here.)
--
-- Before running: replace PROJECT-REF below with the production project's
-- reference (Project Settings → General, the xxxx in https://xxxx.supabase.co).
-- Running it again is safe: a job with the same name is updated, not doubled.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
create extension if not exists pg_net with schema extensions;

-- every 5 minutes: close async turns after 24 h, end each daily challenge at midnight
select cron.schedule('circart-close-turns', '*/5 * * * *', 'select public.close_expired_games()');

-- every minute: if notifications are waiting, ask the send-push Edge Function to send them
-- signed with the secret from migration 017 (private.settings 'push_cron_secret')
select cron.schedule('circart-push', '* * * * *',
  $$ select net.http_post(url := 'https://PROJECT-REF.supabase.co/functions/v1/send-push',
                          body := '{}'::jsonb,
                          headers := jsonb_build_object('Content-Type', 'application/json',
                                       'x-cron-secret', (select value from private.settings where key = 'push_cron_secret')),
                          timeout_milliseconds := 20000)
      where public._push_pending() $$);

-- every 10 minutes: queue "closes in 3 h" reminders
select cron.schedule('circart-push-reminders', '*/10 * * * *', 'select public.queue_turn_reminders()');

-- check:  select jobname, schedule, active from cron.job order by jobname;

-- daily privacy clean-up (011)
select cron.schedule('circart-privacy-cleanup', '17 3 * * *', 'select public.privacy_cleanup()');
