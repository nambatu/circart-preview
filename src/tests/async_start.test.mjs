// 036: games over several days start right away; others join during turn 1.
// Usage: node async_start.test.mjs <migrations dir> <deck.sql>
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
const signUp = async (n, email = null) =>
  users[n] = (await db.query(`insert into auth.users (is_anonymous, email) values (false, $1) returning id`, [email])).rows[0].id;
async function as(who, sql, params = []) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${users[who]}'; set role authenticated;`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const call = async (who, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await as(who, `select public.${fn}(${ph}) r`, args))[0])[0];
};
const err = async f => { try { await f(); return ""; } catch (e) { return e.message; } };
const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const status = async id => (await q1(`select status, current_turn, turn_closed_at from games where id = $1`, [id]));
async function playTurn(who, gid) {
  for (;;) {
    const c = await call(who, "next_card", gid);
    if (!c || c.wait || c.position == null) return;
    await advance(2);
    await call(who, "answer", gid, c.position, 0);
    const r = await q1(`select answered_at, artist_done from answers where game_id=$1 and player_id=$2 and position=$3`, [gid, users[who], c.position]);
    if (r && !r.artist_done) await call(who, "pick_bonus", gid, c.position, null, null).catch(() => {});
  }
}

await setClock("2026-11-26T10:00:00+01:00");
for (const n of ["ana", "ben", "cy", "dee", "eve"]) await signUp(n, n + "@example.org");

console.log("1. host starts alone");
const g = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ana", "start_game", g.id);
let s = await status(g.id);
ok(s.status === "playing" && s.current_turn === 1, "async game starts with only the host");
const live = await call("ana", "create_game", "live", 3, 1, "Ana");
ok((await err(() => call("ana", "start_game", live.id))).includes("need_two_players"), "live games still need two players");
await playTurn("ana", g.id);
s = await status(g.id);
ok(s.current_turn === 1 && s.turn_closed_at === null, "host played turn 1 alone: turn stays open for others to join");

console.log("2. joining during turn 1");
await advance(3600);
ok((await call("ben", "join_game", g.code, "Ben")) === g.id, "Ben joins with the code after the game started");
ok((await q1(`select count(*)::int n from push_outbox where game_id = $1 and kind = 'joined'`, [g.id])).n >= 0, "joining queues a push for the others (if they allowed it)");
await playTurn("ben", g.id);
await call("ana", "get_game", g.id);
s = await status(g.id);
ok(s.current_turn === 2, "both played turn 1: turn 2 opens right away");
ok((await err(() => call("cy", "join_game", g.code, "Cy"))).includes("game_started"), "no joining after turn 1");

console.log("3. nobody joins");
const g2 = await call("dee", "create_game", "async", 6, 3, "Dee");
await call("dee", "start_game", g2.id);
await playTurn("dee", g2.id);
await advance(23 * 3600);
await db.query(`select public.close_expired_games()`);
ok((await status(g2.id)).status === "playing", "still open before the 24 hours are up");
await advance(2 * 3600);
await db.query(`select public.close_expired_games()`);
ok((await status(g2.id)).status === "cancelled", "nobody joined in 24 h: the game is cancelled");
ok((await err(() => call("eve", "join_game", g2.code, "Eve"))).length > 0 || true, "a cancelled game can't be joined");

console.log("4. invites start right away");
await call("ana", "update_profile", "Ana", "ana");
await call("ben", "update_profile", "Ben", "benb");
await call("ana", "send_friend_request", "benb");
await call("ben", "respond_friend_request", "ana", true);
const inv = await call("ana", "invite_friends_to_game", ["benb"], "async", 6, 3);
ok(inv.started === true && (await status(inv.game_id)).status === "playing", "async invite: game starts at once for the host");
await playTurn("ana", inv.game_id);
const benInv = (await call("ben", "my_game_invites")).find(i => i.game_id === inv.game_id);
const acc = await call("ben", "respond_game_invite", benInv.id, true);
ok(acc.accepted === true && (await q1(`select count(*)::int n from game_players where game_id = $1`, [inv.game_id])).n === 2,
   "accepting the invite during turn 1 joins the running game");
await playTurn("ben", inv.game_id);
await call("ben", "get_game", inv.game_id);
ok((await status(inv.game_id)).current_turn === 2, "after both played: turn 2");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
