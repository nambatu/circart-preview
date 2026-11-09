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

const mapped = (await db.query(`select count(*) filter (where _movement_group(movement) is not null)::int m, count(*)::int n from cards where active`)).rows[0];
ok(mapped.m / mapped.n > 0.85, `${mapped.m} of ${mapped.n} cards have a movement question`);
const opt = (await db.query(`select _movement_options('Baroque') o`)).rows[0].o;
ok(opt.length === 4 && opt.includes("Baroque") && new Set(opt).size === 4, `Baroque options: ${opt.join(", ")}`);
ok((await db.query(`select _movement_options('Webcomic') o`)).rows[0].o.length === 0, "unmapped label: no question");

const g = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ben", "join_game", g.code, "Ben");
await call("ana", "set_game_options", g.id, null, null, true);   // 018: async starts without a timer; this test needs the 20 s window
await call("ana", "start_game", g.id);
let c = await call("ana", "next_card", g.id);
let rs = await rightSlot(g.id, c.position); await advance(2);
let r = await call("ana", "answer", g.id, c.position, rs.slot);
const right = await grp(c.position);
const tl = (await call("ana", "get_game", g.id)).timeline;
ok(!tl.some(x => x.position === c.position), "while the bonus is open, the card isn't in your timeline (no artist peeking)");
if (right) {
  ok(r.movement_options.length === 4 && r.movement_options.includes(right), "answer returns 4 movements incl. the right one");
  const before = (await call("ana", "get_game", g.id)).me.score;
  const res = await call("ana", "pick_bonus", g.id, c.position, await realArtist(g.id, c.position), right);
  ok(res.artist_correct && res.movement_correct && res.movement === right, "both right");
  ok((await call("ana", "get_game", g.id)).me.score === before + 300, "+200 artist +100 movement");
  ok((await err(() => call("ana", "pick_artist", g.id, c.position, null))).includes("artist_closed"), "can't answer the bonus twice (old pick_artist)");
  ok((await err(() => call("ana", "pick_bonus", g.id, c.position, null, right))).includes("artist_closed"), "…or pick_bonus again");
  const rev = await call("ana", "reveal", g.id, c.position);
  ok((await call("ana", "get_game", g.id)).timeline.some(x => x.position === c.position), "after the bonus it joins your timeline");
  ok(rev.card.movement_group === right && rev.mine.movement_choice === right && rev.mine.movement_correct, "reveal shows the movement result");
} else ok(true, "(first card has no movement group; skipped)");
c = await call("ana", "next_card", g.id); rs = await rightSlot(g.id, c.position); await advance(2);
r = await call("ana", "answer", g.id, c.position, rs.slot);
ok((await err(() => call("ana", "pick_bonus", g.id, c.position, null, "Not a movement"))).includes("bad_choice"), "only offered movements count");
await advance(25);
ok((await err(() => call("ana", "pick_bonus", g.id, c.position, null, null))).includes("artist_closed"), "window closes after 20 s");

console.log("switches");
const g2 = await call("ana", "create_game", "live", 3, null, "Ana");
await call("ben", "join_game", g2.code, "Ben");
const o = await call("ana", "set_game_options", g2.id, false, false);
ok(o.artist_bonus === false && o.movement_bonus === false, "host turns both off");
await call("ana", "start_game", g2.id);
const c2 = await call("ana", "next_card", g2.id); await call("ben", "next_card", g2.id);
await advance(2);
const r2 = await call("ana", "answer", g2.id, c2.position, 0);
ok(r2.artist_options.length === 0 && r2.movement_options.length === 0, "raw game: no bonus questions");
await call("ben", "answer", g2.id, c2.position, 0);
ok((await call("ana", "get_game", g2.id)).phase === "reveal", "round closes as soon as both placed");

const g3 = await call("ana", "create_game", "live", 3, null, "Ana");
await call("ben", "join_game", g3.code, "Ben");
await call("ana", "set_game_options", g3.id, null, false);
await call("ana", "start_game", g3.id);
const c3 = await call("ana", "next_card", g3.id); await call("ben", "next_card", g3.id);
await advance(2);
const r3 = await call("ana", "answer", g3.id, c3.position, 0);
ok(r3.artist_options.length === 4 && r3.movement_options.length === 0, "artist only");
await call("ben", "answer", g3.id, c3.position, 0);
ok((await call("ana", "get_game", g3.id)).phase === "waiting", "live waits for the artist picks (or the clock)");
await call("ana", "pick_bonus", g3.id, c3.position, null, null); await call("ben", "pick_bonus", g3.id, c3.position, null, null);
ok((await call("ana", "get_game", g3.id)).phase === "reveal", "…and closes once both have picked/skipped");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
