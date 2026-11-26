// 035: notification switches per kind, daily reminder, export additions.
// Usage: node notifications.test.mjs <migrations dir> <deck.sql>
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

const setClock = iso => db.exec(`set circart.test_now = '${new Date(iso).toISOString()}'`);
const users = {};
const signUp = async n =>
  users[n] = (await db.query(`insert into auth.users (is_anonymous) values (false) returning id`)).rows[0].id;
async function as(who, sql, params = []) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${users[who]}'; set role authenticated;`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const call = async (who, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await as(who, `select public.${fn}(${ph}) r`, args))[0])[0];
};
const err = async f => { try { await f(); return ""; } catch (e) { return e.message; } };
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const outbox = async (n, kind) => (await q(`select * from push_outbox where player_id = $1 and kind = $2`, [users[n], kind]));
const sub = n => call(n, "save_push_subscription", `https://fcm.googleapis.com/fcm/send/${n}`, "k".repeat(80), "a".repeat(20), null);

for (const n of ["ana", "ben", "cy", "dee"]) { await signUp(n); await sub(n); }

console.log("1. switches");
let s = await call("ana", "my_push_settings");
ok(s.turns === true && s.invites === true && s.daily_hour === null, "defaults: turns + invites on, no daily reminder");
ok((await err(() => call("ana", "set_push_settings", true, true, 24, "de"))).includes("bad_settings"), "hour must be 0–23");
await call("ana", "set_push_settings", false, true, 7, "de");
s = await call("ana", "my_push_settings");
ok(s.turns === false && s.daily_hour === 7 && s.lang === "de", "settings saved");
const ins = (n, kind) => q(`insert into push_outbox (player_id, kind, game_id, turn, title, body, url) values ($1, $2, null, 1, 'x', 'y', '?')`, [users[n], kind]);
await ins("ana", "turn"); await ins("ben", "turn");
ok((await outbox("ana", "turn")).length === 0 && (await outbox("ben", "turn")).length === 1,
   "turn push dropped for a player who switched turns off, kept for others");
await call("ben", "set_push_settings", true, false, null, "en");
await ins("ben", "new_challenge");
ok((await outbox("ben", "new_challenge")).length === 0, "invite/challenge push dropped when invites are off");

console.log("2. daily reminder");
// ana: 7:00 in Vienna; cy: 7:00 in New York; dee: no reminder
await call("cy", "set_push_settings", true, true, 7, "en");
await call("cy", "set_my_time_zone", "America/New_York");
await setClock("2026-11-26T07:05:00+01:00");          // 7:05 Vienna, 1:05 New York
let n = await call("ana", "queue_daily_reminders").catch(() => null);
ok(n === null, "players can't run the reminder job themselves");
n = (await q(`select public.queue_daily_reminders() n`))[0].n;
const a1 = await outbox("ana", "daily");
ok(n === 1 && a1.length === 1 && a1[0].title.startsWith("Die Daily"), "ana gets one German reminder at 7:00 Vienna time");
ok((await outbox("cy", "daily")).length === 0 && (await outbox("dee", "daily")).length === 0, "not cy (still night in New York), not dee (off)");
await setClock("2026-11-26T07:20:00+01:00");
await q(`select public.queue_daily_reminders()`);
ok((await outbox("ana", "daily")).length === 1, "never twice on the same day");
await setClock("2026-11-26T13:05:00+01:00");          // 7:05 in New York
await q(`select public.queue_daily_reminders()`);
ok((await outbox("cy", "daily")).length === 1 && (await outbox("cy", "daily"))[0].title.startsWith("Today"),
   "cy gets an English reminder at 7:00 in their own time zone");
// played today → no reminder
await setClock("2026-11-27T06:00:00+01:00");
const g = await call("ana", "play_daily");
const c = await call("ana", "next_card", g.id);
await call("ana", "answer", g.id, c.position, 0);
await setClock("2026-11-27T07:05:00+01:00");
await q(`select public.queue_daily_reminders()`);
ok((await outbox("ana", "daily")).length === 1, "no reminder once today's daily is played");
await call("ana", "set_push_settings", false, true, null, "de");
await setClock("2026-11-28T07:05:00+01:00");
await q(`select public.queue_daily_reminders()`);
ok((await outbox("ana", "daily")).length === 1, "switching the reminder off stops it");

console.log("3. export");
const ex = await call("ana", "export_my_data");
ok(Array.isArray(ex.game_reactions) && Array.isArray(ex.game_calls) && ex.profile && "push_daily_hour" in ex.profile,
   "export has reactions, calls and the notification settings");
const anonRights = await q(`select has_function_privilege('anon', 'public.set_push_settings(boolean,boolean,int,text)', 'execute') a,
                                   has_function_privilege('authenticated', 'public._export_my_data_034()', 'execute') b`);
ok(!anonRights[0].a && !anonRights[0].b, "rights: no anon access, old export only reachable through the new one");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
