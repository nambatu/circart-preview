// 012: card packs earned by playing.
// Usage: node packs.test.mjs <migrations dir> <deck.sql>
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

async function playRun(who, { wrongAt = [], secs = 3, max = 100 } = {}) {
  const g = await call(who, "start_run");
  for (let k = 1; k <= max; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(secs);
    await call(who, "answer", g.id, c.position, wrongAt.includes(k) ? (rs.slot === 0 ? rs.n : 0) : rs.slot);
  }
  return call(who, "get_game", g.id);
}
await signUp("ana"); await signUp("ben");
await setClock("2026-11-10T19:00:00+01:00");
// two pack cards, stored the way the build loads them: inactive, with pack_id
await db.exec(`insert into cards (id, source_id, title, artist, year, tier, pack_id, active) values
  ('pk1aaaaaaa', 'pack:baroque-masters:1', 'Test Baroque', 'Rubens', 1615, 1, 'baroque-masters', false),
  ('pk2aaaaaaa', 'pack:german-artists:1', 'Test German', 'Dürer', 1500, 1, 'german-artists', false)`);

let p = await call("ana", "my_packs");
const bm = () => p.find(x => x.id === "baroque-masters"), ga = () => p.find(x => x.id === "german-artists");
ok(p.length === 4 && p.every(x => !x.unlocked) && bm().progress === 0 && bm().needed === 3 && bm().cards === 1, "four packs, all locked, 0 of 3 runs");
for (let i = 0; i < 2; i++) await playRun("ana", { wrongAt: [1, 2, 3] });
p = await call("ana", "my_packs");
ok(bm().progress === 2 && !bm().unlocked, "2 of 3 runs");
await playRun("ana", { wrongAt: [1, 2, 3] });
p = await call("ana", "my_packs");
ok(bm().unlocked && bm().new, "third run: Baroque Masters unlocked, marked new");
await call("ana", "mark_packs_seen");
p = await call("ana", "my_packs");
ok(bm().unlocked && !bm().new, "after seeing it: no longer new");
ok(!(await call("ben", "my_packs")).find(x => x.id === "baroque-masters").unlocked, "ben hasn't unlocked it");

// daily streak pack: 3 days in a row
for (const d of ["2026-11-10", "2026-11-11", "2026-11-12"]) {
  await setClock(d + "T09:00:00+01:00");
  const g = await call("ben", "play_daily");
  const c = await call("ben", "next_card", g.id); const rs = await rightSlot(g.id, c.position); await advance(2);
  await call("ben", "answer", g.id, c.position, rs.slot);
  const dc = (await db.query(`select count(*)::int n from game_cards gc join cards k on k.id = gc.card_id where gc.game_id=$1 and k.pack_id is not null`, [g.id])).rows[0].n;
  if (d === "2026-11-10") ok(dc === 0, "the daily never deals pack cards");
}
p = await call("ben", "my_packs");
ok(ga().unlocked && ga().progress === 3, "3-day daily streak: German Artists unlocked");
const imp = p.find(x => x.id === "impressionists"), ren = p.find(x => x.id === "renaissance");
ok(imp && !imp.unlocked && imp.progress === 3 && imp.needed === 5, "3 dailies played: Impressionists at 3 of 5");
ok(ren && !ren.unlocked && ren.needed === 5, "Renaissance Masters needs 5 solo games");
ok(/permission denied/.test(await err(() => as("ben", "select * from player_packs"))), "unlock records aren't writable from the app");

// a solo game with a pack card saves fine
const saved = await call("ana", "submit_solo_game", { client_id: "00000000-0000-4000-8000-000000000001", score: 2, cards: [{ id: "pack:baroque-masters:1" }, { id: "pack:baroque-masters:1", correct: true }] });
ok(saved.unknown_cards === 0, "solo games with pack cards are saved");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
