// Daily + monthly challenges, leaderboards and stats, over several simulated days.
// Usage: node challenges.test.mjs <migrations dir> <deck.sql>
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

await signUp("ana"); await signUp("ben"); await signUp("dan"); await signUp("gus", true);
for (const [n, u] of [["ana", "ana"], ["ben", "benny"], ["dan", "dan_d"]]) await call(n, "update_profile", null, u);

console.log("daily challenge — day 1");
await setClock("2026-11-01T09:00:00+01:00");
const g1 = await playDaily("ana", { secs: 2 });
ok(g1.challenge_no === 1 && g1.kind === "daily", "challenge No. 1 created on first play");
await playDaily("ben", { wrong: [3, 7], secs: 5 });
await playDaily("dan", { wrong: [1, 2, 3, 4, 5, 6], secs: 8 });
await playDaily("gus", { secs: 1 });                    // a guest, very fast
const ids = async who => (await db.query(`select gc.card_id from answers a join game_cards gc
   on gc.game_id=a.game_id and gc.position=a.position where a.game_id=$1 and a.player_id=$2 order by a.position`, [g1.id, users[who]])).rows.map(r => r.card_id).join();
ok(await ids("ana") === await ids("ben") && await ids("ben") === await ids("gus"), "everyone got the same 10 cards");
let st = await call("ana", "play_daily");
ok(st.id === g1.id && st.phase === "done" && st.me.answered === 10, "one attempt: coming back shows 'done'");
ok(st.players.length === 0, "daily doesn't send the whole world's player list");
const c = await call("ana", "next_card", g1.id);
ok(c.wait === "turn_done", "no more cards today");
let lb = await call("ben", "daily_leaderboard", null);
ok(lb.entries.length === 3 && lb.entries[0].username === "ana" && lb.entries[2].username === "dan_d",
   `daily ranking: ${lb.entries.map(e => e.username + " " + e.score).join(", ")}`);
ok(!lb.entries.some(e => e.username === null), "guests aren't ranked…");
lb = await call("gus", "daily_leaderboard", null);
ok(lb.me.score > 0 && lb.me.ranked === false, "…but see their own score");
ok(lb.players === 4, "player count includes guests");
let sum = await call("ana", "daily_summary");
ok(sum.status === "done" && sum.me.rank === 1 && sum.streak === 1, "home card: done, rank 1, streak 1");

console.log("\nday 2");
await setClock("2026-11-02T00:30:00+01:00");
ok((await db.query(`select close_expired_games() n`)).rows[0].n >= 1, "yesterday's daily is closed after midnight");
ok((await db.query(`select status from games where id=$1`, [g1.id])).rows[0].status === "finished", "day 1 finished");
sum = await call("ben", "daily_summary");
ok(sum.challenge_no === 2 && sum.status === "not_started", "No. 2 is ready, Ben hasn't played");
ok(sum.yesterdays_hardest && sum.yesterdays_hardest.percent_right <= 50 && sum.yesterdays_hardest.title,
   `yesterday's hardest card: "${sum.yesterdays_hardest?.title}" (${sum.yesterdays_hardest?.percent_right}% right)`);
ok(sum.streak === 1, "streak survives until you've had a chance to play today");
const g2 = await playDaily("ana", { secs: 4 });
await playDaily("ben", { secs: 2, wrong: [5] });
const overlap = (await db.query(`select count(*)::int n from game_cards a join game_cards b on a.card_id=b.card_id
   where a.game_id=$1 and b.game_id=$2`, [g1.id, g2.id])).rows[0].n;
ok(overlap === 0, "no card repeats from yesterday's challenge");
ok((await call("ana", "daily_summary")).streak === 2, "Ana's streak: 2 days");

console.log("\nstreaks over a gap");
await setClock("2026-11-04T10:00:00+01:00");          // nobody played on the 3rd
ok((await call("ana", "daily_summary")).streak === 0, "missing a whole day resets the streak");
await playDaily("ana");
ok((await call("ana", "my_stats")).longest_daily_streak === 2, "longest streak remembered (2)");

console.log("\nmonthly challenge (since 009: best Monthly Run, see run.test.mjs)");
let mb = await call("ana", "monthly_leaderboard", null);
ok(mb.metric === "best_run" && mb.title === "Masterpieces Marathon", `November: "${mb.title}"`);
ok(mb.days_left === 27, `days left in November: ${mb.days_left}`);
ok(mb.entries.length === 0, "daily scores no longer decide the monthly board");
await setClock("2026-12-03T12:00:00+01:00");
const g3 = await playDaily("dan", { cards: 4 });
const yrs = (await db.query(`select min(c.year) lo, max(c.year) hi, count(*)::int n from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1`, [g3.id])).rows[0];
ok(yrs.n === 11, `December daily: 11 cards from the whole deck (${yrs.lo}–${yrs.hi})`);
mb = await call("dan", "monthly_leaderboard", null);
ok(mb.title === "Baroque & Golden Age", "December shows its own theme");
ok((await err(() => as("dan", `select * from monthly_challenges`))).includes("permission denied"), "players can't edit the rules");

console.log("\nall time + stats");
const live = await call("ana", "create_game", "live", 3);
await call("ben", "join_game", live.code);
await call("ana", "start_game", live.id);
for (let pos = 1; pos <= 3; pos++) {
  const rs = await rightSlot(live.id, pos);
  for (const p of ["ana", "ben"]) await call(p, "next_card", live.id);
  await advance(2);
  await call("ana", "answer", live.id, pos, rs.slot);
  await call("ben", "answer", live.id, pos, rs.slot === 0 ? rs.n : 0);
  for (const p of ["ana", "ben"]) await call(p, "pick_artist", live.id, pos, null);
  await advance(9); await call("ana", "get_game", live.id);
}
const at = await call("ben", "alltime_leaderboard");
ok(at.entries[0].username === "ana" && at.me.rank >= 2, `all-time points: ${at.entries.map(e => e.username + " " + e.points).join(", ")}`);
const ms = await call("ana", "my_stats");
ok(ms.wins === 1 && ms.games_played === 4 && ms.cards_placed === 33 && ms.best_streak >= 10,
   `Ana's stats: ${JSON.stringify({ wins: ms.wins, games: ms.games_played, cards: ms.cards_placed, streak: ms.best_streak, acc: ms.accuracy })}`);
ok(ms.solo && ms.solo.games === 0, "solo stats included");
ok((await err(() => as("ana", `select _ensure_daily('2027-01-01')`))).includes("permission denied"), "internal helpers can't be called from the app");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
