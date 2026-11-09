// 008: live scores stay secret until the reveal; game names don't overwrite profile names.
// Usage: node privacy.test.mjs <migrations dir> <deck.sql>
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

await signUp("ana"); await signUp("ben");
await setClock("2026-11-05T18:00:00+01:00");
await call("ana", "update_profile", "Anastasia", null);

const g = await call("ana", "create_game", "live", 3, null, "Ana");
ok((await call("ana", "get_my_profile")).display_name === "Anastasia", "a name typed for one game doesn't replace your profile name");
await call("ben", "join_game", g.code, "Ben");
ok(/^Guest|^Ben$/.test((await call("ben", "get_my_profile")).display_name) && (await call("ben", "get_my_profile")).display_name === "Ben", "…but replaces a default guest name");
await call("ana", "start_game", g.id);
const c = await call("ana", "next_card", g.id); await call("ben", "next_card", g.id);
const rs = await rightSlot(g.id, c.position); await advance(2);
await call("ana", "answer", g.id, c.position, rs.slot);
await call("ana", "pick_bonus", g.id, c.position, null, null);
let st = await call("ben", "get_game", g.id);
ok(st.players.every(p => p.score === 0), "during the round Ben sees no scores move");
ok((await err(() => as("ben", "select score from game_players where game_id = $1", [g.id]))).includes("permission denied"), "scores can't be read from the table directly");
ok((await as("ben", "select display_name from game_players where game_id = $1", [g.id])).length === 2, "names still can");
ok((await call("ana", "get_game", g.id)).me.score === 0, "your own points also wait for the reveal");
await advance(1); await call("ben", "answer", g.id, c.position, rs.slot === 0 ? (await rightSlot(g.id, c.position)).n : 0);
await call("ben", "pick_bonus", g.id, c.position, null, null);
st = await call("ben", "get_game", g.id);
ok(st.phase === "reveal" && st.players[0].name === "Ana" && st.players[0].score > 0, "at the reveal: Ana's points show and she leads");
await advance(10);
st = await call("ben", "get_game", g.id);
ok(st.phase === "play" && st.players.find(p => p.name === "Ana").score > 0, "next round: the revealed scores stay");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
