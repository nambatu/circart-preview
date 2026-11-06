-- Preview database only: the push cron job signs its call to send-push with
-- the secret from private.settings (see migration 017).
select cron.schedule('circart-push', '* * * * *',
  $$ select net.http_post(url := 'https://rzptvdlejmdeaanhbbtd.supabase.co/functions/v1/send-push',
                          body := '{}'::jsonb,
                          headers := jsonb_build_object('Content-Type', 'application/json',
                                       'x-cron-secret', (select value from private.settings where key = 'push_cron_secret')),
                          timeout_milliseconds := 20000)
      where public._push_pending() $$);
