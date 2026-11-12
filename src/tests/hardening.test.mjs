// 022: hardening (push hosts, join-code guessing, lobby and solo-game limits).
// Usage: node hardening.test.mjs <migrations dir> <deck.sql>
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

await signUp("ana"); await signUp("ben"); await signUp("cy"); await signUp("dee"); await signUp("host");

console.log("push host check");
const host = async u => (await db.query(`select public._push_host_ok($1) r`, [u])).rows[0].r;
ok(await host("https://fcm.googleapis.com/fcm/send/x") === true, "fcm accepted");
ok(await host("https://updates.push.services.mozilla.com/wpush/v2/x") === true, "mozilla accepted");
ok(await host("https://web.push.apple.com/x") === true, "apple accepted");
ok(await host("https://db5.notify.windows.com/?token=x") === true, "windows accepted");
ok(await host("https://evil.example/x") === false, "other host refused");
ok(await host("https://fcm.googleapis.com.evil.example/x") === false, "look-alike refused");
ok(await host("http://fcm.googleapis.com/x") === false, "plain http refused");
ok(await host(null) === false, "null refused");

console.log("join-code guessing");
const g = await call("ana", "create_game", "live", 10, null, "Ana");
ok(await call("ben", "join_game", "ZZZZ", "Ben") === null, "unknown code returns null");
ok((await db.query(`select count(*)::int n from join_failures where player_id = $1`, [users.ben])).rows[0].n === 1, "the failed try is recorded");
for (let i = 0; i < 6; i++) await call("ben", "join_game", "ZZZZ", "Ben");
ok(await call("ben", "join_game", g.code, "Ben") === g.id, "a correct code still works before the limit (7 failures)");
await call("cy", "join_game", "ZZZZ", "Cy");                                 // cy: 1 failure
for (let i = 0; i < 8; i++) await call("dee", "join_game", "ZZZZ", "Dee");   // dee: 8 failures, all answered
ok((await err(() => call("dee", "join_game", "ZZZZ", "Dee"))).includes("too_many_tries"), "the 9th try in 10 minutes is refused");
ok((await err(() => call("dee", "join_game", g.code, "Dee"))).includes("too_many_tries"), "even a right code waits");
ok(await call("cy", "join_game", g.code, "Cy") === g.id, "other players are not affected");
await db.query(`update join_failures set at = now() - interval '11 minutes' where player_id = $1`, [users.dee]);
ok(await call("dee", "join_game", "ZZZZ", "Dee") === null, "after ten minutes the tries come back");
await db.query(`update join_failures set at = now() - interval '2 days'`);
await db.query(`select privacy_cleanup()`);
ok((await db.query(`select count(*)::int n from join_failures`)).rows[0].n === 0, "privacy_cleanup removes old failures");

console.log("lobby limit");
for (let i = 0; i < 5; i++) await call("host", "create_game", "async", null, null, "Host");
ok((await err(() => call("host", "create_game", "async", null, null, "Host"))).includes("too_many_games"), "6th open lobby refused");

console.log("solo-game limit");
const cards = n => Array.from({ length: n }, (_, i) => ({ id: "x" + i, correct: true }));
ok((await err(() => call("ana", "submit_solo_game", { client_id: crypto.randomUUID(), score: 0, cards: cards(102) }))).includes("bad_game"), "102 cards refused");
ok(typeof (await call("ana", "submit_solo_game", { client_id: crypto.randomUUID(), score: 1, bonus_points: 0, best_streak: 1, cards: cards(3) })) === "object", "a normal solo game is saved");

console.log(failures ? `\nFAILED: ${failures}` : "\nall checks passed");
process.exit(failures ? 1 : 0);
