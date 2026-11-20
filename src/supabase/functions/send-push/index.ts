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

const CRON_SECRET_RE = /^[0-9a-f]{32,128}$/i;
const CONCURRENCY = 15;

type JobStatus = "done" | "gone" | "failed";

Deno.serve(async (req: Request) => {
  try {
    const secret = req.headers.get("x-cron-secret");
    if (!secret || !CRON_SECRET_RE.test(secret)) return new Response("unauthorized", { status: 401 });
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
    const { data: b, error } = await sb.rpc("push_batch", { p_secret: secret });
    if (error && /push_forbidden/.test(error.message)) return new Response("unauthorized", { status: 401 });
    if (error) {
      console.error("push_batch error:", error.message);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
    const jobs: Job[] = b.jobs || [];
    if (!jobs.length) return Response.json({ jobs: 0 });
    if (!b.vapid_private) {
      console.error("missing VAPID private key");
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
    webpush.setVapidDetails(b.vapid_subject, b.vapid_public, b.vapid_private);

    const statusById = new Map<number, JobStatus>();
    const gone = new Set<string>();
    let failedCount = 0;
    let nextIdx = 0;
    const deadline = Date.now() + 25_000;

    const recordStatus = (id: number, status: JobStatus) => {
      const cur = statusById.get(id);
      if (cur === "done" || (cur === "gone" && status === "failed")) return;
      statusById.set(id, status);
    };

    const withTimeout = <T>(pr: Promise<T>, ms: number): Promise<T> => {
      let timer: number | undefined;
      return Promise.race([
        pr.finally(() => { if (timer !== undefined) clearTimeout(timer); }),
        new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); }),
      ]);
    };

    const worker = async () => {
      while (nextIdx < jobs.length && Date.now() < deadline) {
        const j = jobs[nextIdx++];
        if (!PUSH_HOST.test(j.endpoint)) {
          recordStatus(j.id, "done");   // never call anything else
          continue;
        }
        const payload = JSON.stringify({
          title: j.title,
          body: j.body,
          url: (b.site || "") + "/" + j.url,
          tag: j.tag,
        });
        try {
          const remaining = Math.max(1, Math.min(10_000, deadline - Date.now()));
          await withTimeout(
            webpush.sendNotification(
              { endpoint: j.endpoint, keys: { p256dh: j.p256dh, auth: j.auth } },
              payload,
              { TTL: 12 * 3600, urgency: "high" },
            ),
            remaining,
          );
          recordStatus(j.id, "done");
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode || 0;
          if (code === 404 || code === 410) {
            gone.add(j.endpoint);
            recordStatus(j.id, "gone");
          } else if (code >= 400 && code < 500) {
            recordStatus(j.id, "done");   // won't get better by retrying
          } else {
            failedCount++;
            recordStatus(j.id, "failed");
            console.error("push send failed", { id: j.id, code });
          }
        }
      }
    };

    const pool = Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()),
    );
    let overallTimer: number | undefined;
    await Promise.race([
      pool.finally(() => { if (overallTimer !== undefined) clearTimeout(overallTimer); }),
      new Promise<void>((res) => { overallTimer = setTimeout(res, 25_000); }),
    ]);

    const doneIds: number[] = [];
    for (const [id, st] of statusById) {
      if (st === "done" || st === "gone") doneIds.push(id);
    }
    const r = await sb.rpc("push_done", { p_ids: doneIds, p_gone: [...gone] });
    if (r.error) {
      console.error("push_done error:", r.error.message);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
    return Response.json({ jobs: jobs.length, done: doneIds.length, gone: gone.size, failed: failedCount });
  } catch (err) {
    console.error("send-push error:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
});
