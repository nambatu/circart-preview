// 009: the Monthly Run (unlimited tries, 3 lives, best run counts).
// Usage: node run.test.mjs <migrations dir> <deck.sql>
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

await signUp("ana"); await signUp("ben"); await signUp("gus", true);
await call("ana", "update_profile", null, "ana"); await call("ben", "update_profile", null, "benny");
await setClock("2026-11-10T19:00:00+01:00");

// play a run: `wrongAt` = card numbers (1-based) to get wrong; stops when the run ends
async function playRun(who, { wrongAt = [], secs = 3, max = 100, bonus = false } = {}) {
  const g = await call(who, "start_run");
  for (let k = 1; k <= max; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(secs);
    const r = await call(who, "answer", g.id, c.position, wrongAt.includes(k) ? (rs.slot === 0 ? rs.n : 0) : rs.slot);
    if (bonus) await call(who, "pick_bonus", g.id, c.position, null, null);
  }
  return call(who, "get_game", g.id);
}

let s = await call("ana", "run_summary");
ok(s.title === "Masterpieces Marathon" && s.best === null && s.runs === 0 && s.days_left === 21, `November theme: ${s.title}, ${s.days_left} days left`);
let st = await playRun("ana", { wrongAt: [3, 5, 8] });
ok(st.kind === "run" && st.status === "finished" && st.phase === "finished", "third mistake ends the run");
ok(st.me.answered === 8 && st.me.correct === 5, `8 cards played, 5 right (${st.me.answered}/${st.me.correct})`);
ok(st.players.length === 0, "a run has no player list");
const first = st.me.score;
const st2 = await playRun("ana", { wrongAt: [10, 11, 12] });
ok(st2.me.answered === 12 && st2.me.score > first, `again straight away: a longer run (${first} → ${st2.me.score})`);
await playRun("ana", { wrongAt: [1, 2, 3] });
s = await call("ana", "run_summary");
ok(s.runs === 3 && s.best === st2.me.score && s.rank === 1, "best run counts, not the last one");

console.log("timeouts, continuing, limits");
let g = await call("ben", "start_run");
let c = await call("ben", "next_card", g.id);
await advance(30);                                   // app closed: card times out
c = await call("ben", "next_card", g.id);
ok(c.position === 2, "a timed-out card costs a life and the run goes on");
const again = await call("ben", "start_run");
ok(again.id === g.id, "opening the run again continues the unfinished one");
await advance(30); await call("ben", "next_card", g.id); await advance(30);
const w = await call("ben", "next_card", g.id);
ok(w.wait === "finished", "three timeouts end the run");
st = await playRun("ben", { wrongAt: [20, 21, 22] , secs: 2});
ok(st.status === "finished", "ben's long run");
let lb = await call("ana", "monthly_leaderboard", null);
ok(lb.metric === "best_run" && lb.entries[0].username === "benny" && lb.entries[1].username === "ana", `board: ${lb.entries.map(e => e.username + " " + e.value).join(", ")}`);
s = await call("ana", "run_summary");
ok(s.rank === 2 && s.above && s.above.username === "benny", "ana sees who's just above her");
await playRun("gus", { wrongAt: [1, 2, 3] });
lb = await call("gus", "monthly_leaderboard", null);
ok(!lb.entries.some(e => e.is_me) && lb.me && lb.me.best >= 0 && lb.me.ranked === false, "guests play but aren't on the board");

console.log("themes");
await setClock("2026-12-03T19:00:00+01:00");
const dg = await call("ana", "start_run");
const yrs = (await db.query(`select c.year from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1`, [dg.id])).rows.map(r => r.year);
ok(yrs.every(y => y >= 1580 && y <= 1800) && yrs.length >= 30, `December run: ${yrs.length} cards, all 1580–1800`);
const daily = await call("ana", "play_daily");
const dy = (await db.query(`select c.year from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1`, [daily.id])).rows.map(r => r.year);
ok(dy.some(y => y < 1580 || y > 1800), "the daily ignores the theme (whole deck)");
const all = await call("ana", "alltime_leaderboard");
const anaPts = all.entries.find(e => e.username === "ana").points;
ok(anaPts === st2.me.score, `all time counts only ana's best November run (${anaPts})`);

// 020: one point per card, no bonus questions
{
  await signUp("rex"); await call("rex", "update_profile", null, "rex");
  const rg = await call("rex", "start_run");
  let pts = [], opts = 0;
  for (let k = 1; k <= 6; k++) {
    const c = await call("rex", "next_card", rg.id);
    const rs = await rightSlot(rg.id, c.position);
    await advance(3);
    const r = await call("rex", "answer", rg.id, c.position, k === 4 ? (rs.slot === 0 ? rs.n : 0) : rs.slot);
    pts.push(r.points); opts += (r.artist_options || []).length + (r.movement_options || []).length;
  }
  ok(pts.join() === "1,1,1,0,1,1", `runs: 1 point per right card, 0 for a wrong one (${pts.join()})`);
  ok(opts === 0, "runs ask no artist or style questions");
  ok((await call("rex", "get_game", rg.id)).me.score === 5, "run score = cards placed right");
}
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
