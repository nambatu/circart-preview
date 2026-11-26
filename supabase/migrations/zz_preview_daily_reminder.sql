-- Preview database only: the daily reminder (035) — every 15 minutes, queue one
-- "today's daily is waiting" push for players whose chosen hour has come.
select cron.schedule('circart-daily-reminder', '*/15 * * * *', 'select public.queue_daily_reminders()');
