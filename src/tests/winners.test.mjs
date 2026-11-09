// 010: Monthly Run winners (last month's top 3) and profile badges.
// Usage: node winners.test.mjs <migrations dir> <deck.sql>
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

for (const n of ["ana", "ben", "cyd", "dee"]) { await signUp(n); await call(n, "update_profile", null, n); }
await signUp("gus", true);
await setClock("2026-11-10T19:00:00+01:00");

// November: dee > ben > ana > cy ; gus (guest) would be 1st but isn't ranked
const scores = {};
for (const [n, k] of [["dee", 15], ["ben", 12], ["ana", 8], ["cyd", 4], ["gus", 20]])
  scores[n] = (await playRun(n, { wrongAt: [k, k + 1, k + 2] })).me.score;
ok(scores.dee > scores.ben && scores.ben > scores.ana && scores.ana > scores.cyd, `November runs: ${JSON.stringify(scores)}`);

ok(await call("ana", "monthly_winners", "2026-11-01") === null, "no winners while the month is still on");
let w = await call("ana", "monthly_winners", null);
ok(w && w.month === "2026-10-01" && w.entries.length === 0, "last month (October) had no runs: empty podium");
let b = await call("ana", "my_badges");
ok(Array.isArray(b) && b.length === 0, "no badges yet");

await setClock("2026-12-02T10:00:00+01:00");
w = await call("ana", "monthly_winners", null);
ok(w.month === "2026-11-01" && w.title === "Masterpieces Marathon", `December shows November's winners (${w.title})`);
ok(w.entries.map(e => e.username).join() === "dee,ben,ana", `top 3: ${w.entries.map(e => e.rank + ". " + e.username + " " + e.value).join(", ")}`);
ok(w.entries[2].is_me && !w.entries[0].is_me && w.players === 4, "ana is marked, 4 ranked players, guest left out");
ok(w.entries[0].value === scores.dee, "value = best run score");

b = await call("ana", "my_badges");
ok(b.length === 1 && b[0].rank === 3 && b[0].month === "2026-11-01" && b[0].title === "Masterpieces Marathon", `ana's badge: ${JSON.stringify(b)}`);
ok(b[0].title_de === "Meisterwerk-Marathon" && w.title_de === "Meisterwerk-Marathon", "badge and winners carry the German title (016)");
const rsum = await call("ana", "run_summary");
ok(rsum.title_de === "Barock & Goldenes Zeitalter" && /Drama in jedem Rahmen/.test(rsum.description_de), "run card gets the German theme text");
const mlb = await call("ana", "monthly_leaderboard", null);
ok(mlb.title_de === "Barock & Goldenes Zeitalter", "Ranks → Month gets it too");
ok((await call("cyd", "my_badges")).length === 0, "4th place gets no badge");
ok((await call("gus", "my_badges")).length === 0, "guests get no badge");

// a December run doesn't make December's badge appear before the month is over
await playRun("cyd", { wrongAt: [30, 31, 32], secs: 2 });
ok((await call("cyd", "my_badges")).length === 0, "the running month never gives a badge");

await setClock("2027-01-05T10:00:00+01:00");
const cyB = await call("cyd", "my_badges");
ok(cyB.length === 1 && cyB[0].rank === 1 && cyB[0].title === "Baroque & Golden Age", "January: cy won December");
b = await call("ana", "my_badges");
ok(b.length === 1, "ana keeps her November badge");
ok(/permission denied/.test(await err(() => as("ana", "select public._run_ranked('2026-11-01')"))), "helpers stay private");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
