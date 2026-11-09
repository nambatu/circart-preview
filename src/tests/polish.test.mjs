// 004: share results (my_results) and rematches.
// Usage: node polish.test.mjs <migrations dir> <deck.sql>
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
await setClock("2026-11-01T09:00:00+01:00");

console.log("my_results");
const d = await playDaily("ana", { cards: 10, wrong: [2, 5] });
let r = await call("ana", "my_results", d.id);
ok(r.length === 10 && r.filter(x => x.correct).length === 8 && !r[1].correct, "daily: 10 results, the two wrong ones marked");
ok((await err(() => call("ben", "my_results", d.id))).includes("game_not_found"), "only your own games");

const live = await call("ana", "create_game", "live", 3, null, "Ana");
await call("ben", "join_game", live.code, "Ben");
await call("ana", "start_game", live.id);
let c = await call("ana", "next_card", live.id);
await advance(2); await call("ana", "answer", live.id, c.position, 0);
r = await call("ana", "my_results", live.id);
ok(Array.isArray(r) && r.length === 0, "live: nothing before the game is over");
await db.query(`update games set status='finished', finished_at=now() where id=$1`, [live.id]);
r = await call("ana", "my_results", live.id);
ok(r.length === 1, "live: own results once finished");

console.log("rematch");
ok((await call("ben", "rematch_info", live.id)) === null, "no rematch yet");
ok((await err(() => call("cy", "rematch", live.id))).includes("game_not_found"), "outsiders can't start a rematch");
const re = await call("ben", "rematch", live.id);
ok(/^[A-Z2-9]{4}$/.test(re.code) && re.id !== live.id, `Ben starts the rematch (${re.code})`);
let info = await call("ana", "rematch_info", live.id);
ok(info.id === re.id && info.host === "Ben" && info.joined === false && info.players === 1, "Ana sees Ben's rematch lobby");
const re2 = await call("ana", "rematch", live.id);
ok(re2.id === re.id, "Ana's 'Play again' joins the same lobby");
info = await call("ana", "rematch_info", live.id);
ok(info.joined && info.players === 2, "two players in the rematch");
const g2 = await call("ben", "get_game", re.id);
ok(g2.kind === "live" && g2.card_count === 3 && g2.is_host && g2.phase === "lobby", "same settings, Ben hosts");
ok((await call("ana", "rematch", live.id)).id === re.id, "asking twice is harmless");
const asy = await call("ana", "create_game", "async", null, null, "Ana");
ok((await err(() => call("ana", "rematch", asy.id))).includes("bad_settings"), "only finished games");
ok((await err(() => call("ana", "rematch", d.id))).includes("bad_settings"), "not for the daily");

const asy2 = await call("cy", "create_game", "async", null, null, "Cy");
const j = await call("ben", "join_game", asy2.code, null);
const gg = await call("ben", "get_game", j);
ok(j === asy2.id && gg.code === asy2.code, `join after a rematch joins the right game (${gg.code} vs ${asy2.code})`);
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
