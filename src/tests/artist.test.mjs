// 006: the artist bonus can be switched off.
// Usage: node artist.test.mjs <migrations dir> <deck.sql>
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
await setClock("2026-11-03T18:00:00+01:00");

const g = await call("ana", "create_game", "live", 3, null, "Ana");
await call("ben", "join_game", g.code, "Ben");
ok((await err(() => call("ben", "set_game_options", g.id, false, null))).includes("not_host"), "only the host can change it");
ok((await call("ana", "game_options", g.id)).artist_bonus === true, "on by default");
await call("ana", "set_game_options", g.id, false, false);
ok((await call("ben", "game_options", g.id)).artist_bonus === false, "Ben sees it is off");
await call("ana", "start_game", g.id);
ok((await err(() => call("ana", "set_game_options", g.id, true, null))).includes("game_started"), "fixed once the game starts");
const ca = await call("ana", "next_card", g.id); await call("ben", "next_card", g.id);
await advance(2);
const ra = await call("ana", "answer", g.id, ca.position, 0);
ok(Array.isArray(ra.artist_options) && ra.artist_options.length === 0, "no artist question after placing");
await advance(1);
await call("ben", "answer", g.id, ca.position, 0);
const st = await call("ana", "get_game", g.id);
ok(st.phase === "reveal", "the round closes as soon as both have placed (nobody waits for an artist pick)");
ok((await err(() => call("ana", "pick_artist", g.id, ca.position, "Rembrandt"))).length > 0, "picking an artist isn't possible");

const g2 = await call("ana", "create_game", "live", 3, null, "Ana");
await call("ben", "join_game", g2.code, "Ben");
await call("ana", "start_game", g2.id);
const c2 = await call("ana", "next_card", g2.id);
await advance(2);
ok((await call("ana", "answer", g2.id, c2.position, 0)).artist_options.length === 4, "a normal game still asks for the artist");

await db.query(`update games set status='finished' where id=$1`, [g.id]);
const re = await call("ben", "rematch", g.id);
ok((await call("ben", "game_options", re.id)).artist_bonus === false, "a rematch keeps the setting");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
