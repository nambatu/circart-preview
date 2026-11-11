// 007: the movement bonus question.
// Usage: node movement.test.mjs <migrations dir> <deck.sql>
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
await setClock("2026-11-04T18:00:00+01:00");

const grp = async pos => (await db.query(`select _movement_group(c.movement) g from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [g.id, pos])).rows[0].g;
const realArtist = async (gid, pos) => (await db.query(`select c.artist from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [gid, pos])).rows[0].artist;


// ─── 018: timer on/off for games with friends ───────────────────────────
for (const n of ["ana", "ben"]) { if (!users[n]) await signUp(n); }
await setClock("2026-11-12T19:00:00+01:00");

// async: no timer by default
const a1 = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ben", "join_game", a1.code, "Ben");
let o1 = await call("ana", "game_options", a1.id);
ok(o1.timer === false, "a game over a few days starts without a timer");
await call("ana", "start_game", a1.id);
let c1 = await call("ana", "next_card", a1.id);
ok(c1.seconds === 86400, `no timer: ${c1.seconds} s per card (only the turn's own 24 h count)`);
let s1 = await rightSlot(a1.id, c1.position);
await advance(95);                                   // think for a minute and a half
let r1 = await call("ana", "answer", a1.id, c1.position, s1.slot);
ok(r1.correct && !r1.timed_out && r1.points >= 999, `answer after 95 s still counts, full points (${r1.points})`);
await advance(120);                                  // look at the painting for two more minutes
const ra = await realArtist(a1.id, c1.position);
const b1 = await call("ana", "pick_bonus", a1.id, c1.position, ra, null);
ok(b1.artist_correct === true && b1.artist === ra, "the artist question is still open 2 minutes later, right answer comes back");

// the host can switch the timer on; then 20 s and the bonus window apply
const a2 = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ben", "join_game", a2.code, "Ben");
const o2 = await call("ana", "set_game_options", a2.id, null, null, true);
ok(o2.timer === true, "host switches the timer on");
ok(/not_host/.test(await err(() => call("ben", "set_game_options", a2.id, null, null, false))), "only the host can");
await call("ana", "start_game", a2.id);
let c2 = await call("ana", "next_card", a2.id);
ok(c2.seconds === 20, "timer on: 20 s per card");
let s2 = await rightSlot(a2.id, c2.position);
await advance(30);
let r2 = await call("ana", "answer", a2.id, c2.position, s2.slot);
ok(r2.timed_out === true, "timer on: too slow after 30 s");

// live: timer on by default, can be switched off (10 minutes as a safety net)
const l1 = await call("ana", "create_game", "live", 3, null, "Ana");
await call("ben", "join_game", l1.code, "Ben");
ok((await call("ana", "game_options", l1.id)).timer === true, "live games start with the timer on");
await call("ana", "set_game_options", l1.id, null, null, false);
await call("ana", "start_game", l1.id);
let c3 = await call("ana", "next_card", l1.id);
ok(c3.seconds === 600, "live without timer: 10 minutes per round (safety net)");
let s3 = await rightSlot(l1.id, c3.position);
await advance(60);
await call("ana", "answer", l1.id, c3.position, s3.slot);
const st3 = await call("ana", "get_game", l1.id);
ok(st3.status === "playing" && st3.phase !== "reveal", "after 60 s the round still waits for Ben");

// 020: the host picks the seconds
const a4 = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ben", "join_game", a4.code, "Ben");
const o4 = await call("ana", "set_game_options", a4.id, null, null, null, 45);
ok(o4.timer === true && o4.seconds === 45, "host sets 45 seconds (timer switches on)");
ok(/bad_seconds/.test(await err(() => call("ana", "set_game_options", a4.id, null, null, null, 2))), "2 seconds is too short");
ok(/bad_seconds/.test(await err(() => call("ana", "set_game_options", a4.id, null, null, null, 900))), "15 minutes is too long");
const o4b = await call("ana", "set_game_options", a4.id, null, null, false);
ok(o4b.timer === false && o4b.seconds === null, "switching the timer off");
await call("ana", "set_game_options", a4.id, null, null, true);
ok((await call("ana", "game_options", a4.id)).seconds === 20, "switching it on again starts at 20 s");
await call("ana", "set_game_options", a4.id, null, null, null, 10);
await call("ana", "start_game", a4.id);
const c4 = await call("ana", "next_card", a4.id);
ok(c4.seconds === 10, "10 seconds per card in the game");

// rematch keeps the setting
const a3 = await call("ana", "create_game", "async", 3, 3, "Ana");
await call("ana", "set_game_options", a3.id, null, null, true);
await db.exec(`update games set status = 'finished', finished_at = now() where id = '${a3.id}'`);
const rm = await call("ana", "rematch", a3.id);
const rmo = await call("ana", "game_options", rm.id);
ok(rmo.timer === true, "a rematch keeps the timer setting");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
// 021: daily = 45 s per card, placing and questions together
console.log("daily 45 s");
await setClock("2026-11-20T10:00:00+01:00");
const dg = await call("ana", "play_daily");
const d1 = await call("ana", "next_card", dg.id);
ok(d1.seconds === 45, "daily: 45 seconds per card");
await advance(3);
const dr1 = await call("ana", "answer", dg.id, d1.position, (await rightSlot(dg.id, d1.position)).slot);
if (dr1.artist_options && dr1.artist_options.length) {
  await advance(35);                                  // 38 s after the card was shown: still open
  await call("ana", "pick_bonus", dg.id, d1.position, null, null);
  ok(true, "daily: question still open at 38 s");
}
const d2 = await call("ana", "next_card", dg.id);
await advance(3);
const dr2 = await call("ana", "answer", dg.id, d2.position, (await rightSlot(dg.id, d2.position)).slot);
if (dr2.artist_options && dr2.artist_options.length) {
  await advance(46);                                  // 49 s after shown: closed
  ok((await err(() => call("ana", "pick_bonus", dg.id, d2.position, null, null))).includes("artist_closed"), "daily: question closes after 45 s in total");
}

process.exit(failures ? 1 : 0);
