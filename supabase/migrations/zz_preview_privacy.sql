-- Preview database only: daily privacy clean-up (011, storage limitation).
select cron.schedule('circart-privacy-cleanup', '17 3 * * *', 'select public.privacy_cleanup()');
