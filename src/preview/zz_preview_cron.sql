-- Preview database only: run the turn closer every 5 minutes.
-- (Closes async turns after 24 h and ends each daily challenge at midnight.)
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
select cron.schedule('circart-close-turns', '*/5 * * * *', 'select public.close_expired_games()');
