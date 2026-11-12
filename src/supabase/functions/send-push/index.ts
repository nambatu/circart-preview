// CIRCArt — send queued push notifications (Supabase Edge Function "send-push").
//
// pg_cron calls this every minute while push_outbox has unsent messages
// (see preview/zz_preview_push.sql). It takes a batch from push_batch(),
// sends each message to every device of that player, and reports back with
// push_done(): handled message ids + devices the push service says are gone.
//
// Deployed with verify_jwt = false (pg_cron can't sign in). Instead the cron
// job sends the header x-cron-secret, and push_batch() checks it against the
// secret in private.settings (migration 017); a wrong or missing one → 401.
// VAPID keys live in the database (private.settings), never in the repo.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Job = { id: number; endpoint: string; p256dh: string; auth: string; title: string; body: string; url: string; tag: string };

// Only the real push services (same rule as _push_host_ok() in migration 022).
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)\//;

Deno.serve(async (req: Request) => {
  const secret = req.headers.get("x-cron-secret");
  if (!secret) return new Response("unauthorized", { status: 401 });
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  const { data: b, error } = await sb.rpc("push_batch", { p_secret: secret });
  if (error && /push_forbidden/.test(error.message)) return new Response("unauthorized", { status: 401 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const jobs: Job[] = b.jobs || [];
  if (!jobs.length) return Response.json({ jobs: 0 });
  if (!b.vapid_private) return Response.json({ error: "no VAPID keys in private.settings" }, { status: 500 });
  webpush.setVapidDetails(b.vapid_subject, b.vapid_public, b.vapid_private);

  const done = new Set<number>();
  const gone: string[] = [];
  const failed: string[] = [];
  await Promise.all(jobs.map(async (j) => {
    if (!PUSH_HOST.test(j.endpoint)) { done.add(j.id); return; }   // never call anything else
    const payload = JSON.stringify({ title: j.title, body: j.body, url: (b.site || "") + "/" + j.url, tag: j.tag });
    try {
      await webpush.sendNotification({ endpoint: j.endpoint, keys: { p256dh: j.p256dh, auth: j.auth } }, payload,
        { TTL: 12 * 3600, urgency: "high" });
      done.add(j.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode || 0;
      if (code === 404 || code === 410) gone.push(j.endpoint);
      if (code >= 400 && code < 500) done.add(j.id);       // won't get better by retrying
      else failed.push(code + " " + String((e as Error).message).slice(0, 120));
    }
  }));
  const r = await sb.rpc("push_done", { p_ids: [...done], p_gone: gone });
  return Response.json({ jobs: jobs.length, done: done.size, gone: gone.length, failed, error: r.error?.message });
});
