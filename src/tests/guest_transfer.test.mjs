// 026: guest transfer (a guest's games move into an existing account).
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

const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const cards = n => Array.from({ length: n }, (_, i) => ({ id: "x" + i, correct: true }));
await signUp("acct"); await signUp("guest", true); await signUp("other", true); await signUp("friend");

console.log("tickets");
ok((await err(() => call("acct", "start_guest_transfer"))).includes("not_a_guest"), "a real account can't make a ticket");
const tok = await call("guest", "start_guest_transfer");
ok(typeof tok === "string" && tok.length >= 32, "a guest gets a long random ticket");
ok((await err(() => call("other", "finish_guest_transfer", tok))).includes("not_signed_in"), "another guest can't hand it in");

console.log("what the guest played");
const soloId = crypto.randomUUID();
await call("guest", "submit_solo_game", { client_id: soloId, score: 1, bonus_points: 0, best_streak: 1, cards: cards(3) });
await call("guest", "submit_solo_game", { client_id: crypto.randomUUID(), score: 1, bonus_points: 0, best_streak: 1, cards: cards(3) });
await call("acct", "submit_solo_game", { client_id: soloId, score: 1, bonus_points: 0, best_streak: 1, cards: cards(3) });  // same game saved twice
await db.query(`insert into player_packs (player_id, pack_id) select $1, id from packs limit 1`, [users.guest]);
const fg = await call("guest", "create_game", "async", null, null, "Guesty");
await call("friend", "join_game", fg.code, "Friend");
await call("guest", "start_game", fg.id);
await call("guest", "next_card", fg.id);
const daily = await call("guest", "play_daily", "Guesty");
await call("guest", "next_card", daily.id);

console.log("hand in");
const r = await call("acct", "finish_guest_transfer", tok);
ok(r.moved === true, "the account hands in the ticket");
ok((await q1(`select count(*)::int n from auth.users where id = $1`, [users.guest])).n === 0, "the guest is deleted");
ok((await q1(`select count(*)::int n from solo_games where player_id = $1`, [users.acct])).n === 2, "solo games moved, the double one only once");
ok((await q1(`select count(*)::int n from player_packs where player_id = $1`, [users.acct])).n === 1, "card pack moved");
ok((await q1(`select host_id = $2 h, (select count(*)::int from game_players where game_id = $1 and player_id = $2) n from games where id = $1`, [fg.id, users.acct])).h === true, "the friend game is now hosted by the account");
ok((await q1(`select count(*)::int n from answers where game_id = $1 and player_id = $2`, [fg.id, users.acct])).n === 1, "its answers moved too");
ok((await q1(`select count(*)::int n from game_players where game_id = $1 and player_id = $2`, [daily.id, users.acct])).n === 0, "the daily result did NOT move (no second try)");
ok((await call("acct", "finish_guest_transfer", tok)).moved === false, "a ticket works only once");

console.log("old tickets");
await signUp("g2", true);
const tok2 = await call("g2", "start_guest_transfer");
await db.query(`update guest_transfers set created_at = now() - interval '16 minutes' where token = $1`, [tok2]);
ok((await call("acct", "finish_guest_transfer", tok2)).moved === false, "a ticket older than 15 minutes is refused");
ok((await q1(`select count(*)::int n from auth.users where id = $1`, [users.g2])).n === 1, "and that guest stays untouched");
ok((await err(() => as("acct", `select * from guest_transfers`))).includes("permission denied"), "tickets can't be read directly");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
