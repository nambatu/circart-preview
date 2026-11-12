// 005: push notifications for async games.
// Usage: node push.test.mjs <migrations dir> <deck.sql>
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";

const [DIR, DECK] = process.argv.slice(2);
const db = new PGlite();
let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

await db.exec(`
  create role anon; create role authenticated;
  grant usage on schema public to anon, authenticated;
  create schema auth; grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text,
    is_anonymous boolean default false, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
for (const f of fs.readdirSync(DIR).filter(f => /^0\d\d_.*\.sql$/.test(f)).sort())
  await db.exec(fs.readFileSync(`${DIR}/${f}`, "utf8"));
await db.exec(fs.readFileSync(DECK, "utf8"));

let clock;
const setClock = async iso => { clock = new Date(iso).getTime(); await db.exec(`set circart.test_now = '${new Date(clock).toISOString()}'`); };
const advance = s => setClock(new Date(clock + s * 1000).toISOString());
const users = {};
const signUp = async (n, anon = false) =>
  users[n] = (await db.query(`insert into auth.users (is_anonymous) values ($1) returning id`, [anon])).rows[0].id;
async function as(who, sql, params = []) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${users[who]}'; set role authenticated;`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const call = async (who, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await as(who, `select public.${fn}(${ph}) r`, args))[0])[0];
};
const err = async f => { try { await f(); return ""; } catch (e) { return e.message; } };
async function rightSlot(game, pos) {
  const r = (await db.query(`select c.year, _years_before($1,$2) ys from game_cards gc join cards c on c.id=gc.card_id
                              where gc.game_id=$1 and gc.position=$2`, [game, pos])).rows[0];
  return { slot: r.ys.filter(y => y < r.year).length, n: r.ys.length };
}
// play n cards of today's daily; `wrong` = positions to get wrong; `secs` per answer
async function playDaily(who, { cards = 10, wrong = [], secs = 3 } = {}) {
  const g = await call(who, "play_daily");
  for (let k = 0; k < cards; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(secs);
    await call(who, "answer", g.id, c.position, wrong.includes(c.position) ? (rs.slot === 0 ? rs.n : 0) : rs.slot);
  }
  return g;
}

await signUp("ana"); await signUp("ben"); await signUp("cy");
await setClock("2026-11-02T10:00:00+01:00");
const out = async () => (await db.query(`select o.kind, o.turn, o.title, o.body, o.url, p.display_name n
   from push_outbox o join game_players p on p.player_id = o.player_id and p.game_id = o.game_id order by o.id`)).rows;

console.log("subscriptions");
await call("ana", "save_push_subscription", "https://fcm.googleapis.com/fcm/send/ana1", "k".repeat(80), "a".repeat(20), "Phone");
await call("ben", "save_push_subscription", "https://fcm.googleapis.com/fcm/send/ben1", "k".repeat(80), "a".repeat(20), null);
ok(await call("ana", "push_enabled") === true && await call("cy", "push_enabled") === false, "push_enabled per player");
ok((await err(() => call("ana", "save_push_subscription", "http://evil", "k", "a", null))).includes("bad_settings"), "only https endpoints");
ok((await err(() => call("ana", "save_push_subscription", "https://evil.example/x", "k", "a", null))).includes("bad_settings"), "022: only real push services");
ok((await err(() => call("ana", "save_push_subscription", "https://fcm.googleapis.com.evil.example/x", "k", "a", null))).includes("bad_settings"), "022: look-alike host refused");
await call("ana", "save_push_subscription", "https://web.push.apple.com/abc", "k", "a", null);
ok((await db.query(`select count(*)::int n from push_subscriptions where endpoint = 'https://web.push.apple.com/abc'`)).rows[0].n === 1, "022: Apple push host accepted");
await call("ana", "remove_push_subscription", "https://web.push.apple.com/abc");   // keep the later counts as they were
ok((await err(() => as("ana", "select * from push_subscriptions"))).includes("permission denied"), "subscriptions aren't readable from the app");
ok((await err(() => call("ana", "push_batch", "x"))).includes("permission denied"), "push_batch is server-only");
const SECRET = (await db.query(`select value from private.settings where key = 'push_cron_secret'`)).rows[0].value;
ok(SECRET && SECRET.length >= 60, "017: a long random cron secret exists");
ok((await err(() => db.query(`select push_batch('wrong')`))).includes("push_forbidden"), "017: wrong secret → push_forbidden");
ok((await err(() => db.query(`select push_batch(null)`))).includes("push_forbidden"), "017: no secret → push_forbidden");
await call("ben", "save_push_subscription", "https://fcm.googleapis.com/fcm/send/ana1", "k".repeat(80), "a".repeat(20), null);
ok((await db.query(`select player_id from push_subscriptions where endpoint='https://fcm.googleapis.com/fcm/send/ana1'`)).rows[0].player_id === users.ana,
   "someone else can't take over a saved device");
await call("ana", "save_push_subscription", "https://fcm.googleapis.com/fcm/send/ana1", "k".repeat(80), "a".repeat(20), null);

console.log("async game");
const g = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ben", "join_game", g.code, "Ben");
await call("cy", "join_game", g.code, "Cy");
await call("ana", "start_game", g.id);
let o = await out();
ok(o.length === 2 && o.every(x => x.kind === "turn" && x.turn === 1), "game starts: 'your turn' for Ana and Ben (Cy has no device)");
ok(o.find(x => x.n === "Ana").body.includes("Ben & Cy") && o[0].url === "?game=" + g.id, `text: "${o[0].body}"`);

async function playTurn(who) {
  for (let k = 0; k < 3; k++) {
    const c = await call(who, "next_card", g.id); if (c.wait) break;
    const rs = await rightSlot(g.id, c.position); await advance(3);
    await call(who, "answer", g.id, c.position, rs.slot);
  }
}
await playTurn("ana");
await advance(20 * 3600 + 1800);              // 3.5 h left
ok(await call("ana", "my_games") && (await db.query(`select queue_turn_reminders() n`)).rows[0].n === 0, "no reminder 3.5 h before the end");
await advance(3600);                          // 2.5 h left
const n = (await db.query(`select queue_turn_reminders() n`)).rows[0].n;
o = await out();
ok(n === 2 && o.filter(x => x.kind === "reminder").map(x => x.n).join() === "Ben", "2.5 h left: Ben and Cy haven't played; Ben gets a reminder (Cy has no device)");
await db.query(`select queue_turn_reminders()`);
ok((await out()).filter(x => x.kind === "reminder").length === 1, "never reminded twice");

await playTurn("ben"); await playTurn("cy");
await call("ana", "get_game", g.id);
o = await out();
ok(o.filter(x => x.kind === "turn" && x.turn === 2).length === 2, "turn 2 opens when everyone has played: 'your turn' again");
await playTurn("ana"); await playTurn("ben"); await playTurn("cy");
await call("ana", "get_game", g.id);
o = await out();
const fin = o.filter(x => x.kind === "finished");
ok(fin.length === 2 && fin.some(x => /You won|came #/.test(x.title)), `game over messages: ${fin.map(x => x.n + ": " + x.title).join(" · ")}`);

console.log("sending");
await db.exec(`insert into private.settings values ('vapid_public','PUB'),('vapid_private','PRIV'),('vapid_subject','https://x'),('site','https://s')`);
const b = (await db.query(`select push_batch($1) b`, [SECRET])).rows[0].b;
ok(b.vapid_private === "PRIV" && b.jobs.length === o.length, `batch: ${b.jobs.length} jobs with keys`);
await db.query(`select push_done($1::bigint[], $2::text[])`, [b.jobs.slice(0, 2).map(j => j.id), ["https://fcm.googleapis.com/fcm/send/ben1"]]);
ok((await db.query(`select push_batch($1) b`, [SECRET])).rows[0].b.jobs.length === 0, "a second, overlapping run gets nothing (messages are claimed)");
await db.query(`update push_outbox set claimed_at = null`);
const b2 = (await db.query(`select push_batch($1) b`, [SECRET])).rows[0].b;
ok(b2.jobs.length === b.jobs.length - 2 - b.jobs.slice(2).filter(j => j.endpoint.endsWith("ben1")).length, "done ids leave the queue, dead devices are removed");
await db.query(`update push_outbox set created_at = now() - interval '2 days', claimed_at = null`);
ok((await db.query(`select push_batch($1) b`, [SECRET])).rows[0].b.jobs.length === 0, "messages older than a day are dropped, not sent late");
await call("ana", "remove_push_subscription", "https://fcm.googleapis.com/fcm/send/ana1");
ok(await call("ana", "push_enabled") === false, "turning it off removes the device");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
