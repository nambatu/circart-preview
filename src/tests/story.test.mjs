// 019: story dailies — a themed daily with a chapter per card.
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


for (const n of ["ana", "ben"]) { await signUp(n); await call(n, "update_profile", null, n); }
await setClock("2026-11-06T10:00:00+01:00");

// a theme for tomorrow: 11 inactive cards (copies of deck cards), chapters, credits
const deck = (await db.query(`select * from cards where active order by year limit 40`)).rows;
const pick = [20, 3, 31, 9, 25, 14, 38, 1, 28, 6, 17].map(i => deck[i]);
for (const [i, c] of pick.entries())
  await db.query(`insert into cards (id, source_id, title, artist, year, movement, tier, image_url, trivia, active)
                  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
                 ["th" + i, "daily:test:" + i, c.title + " (theme)", c.artist, c.year, c.movement, c.tier, c.image_url, c.trivia]);
await db.exec(`insert into daily_themes (day, slug, title, title_de, intro, intro_de, outro, outro_de)
               values ('2026-11-07', 'test-walk', 'A walk', 'Ein Spaziergang', 'Intro EN', 'Intro DE', 'Outro EN', 'Outro DE')`);
for (let i = 0; i <= 10; i++)
  await db.query(`insert into daily_theme_cards (day, position, card_id, chapter, chapter_de, credit) values ('2026-11-07', $1, $2, $3, $4, $5)`,
                 [i, "th" + i, "Chapter " + i, "Kapitel " + i, i % 2 ? "Photo: X, CC BY-SA 4.0" : "Public domain"]);

// today has no theme: random as before, no story
const g0 = await call("ana", "play_daily", null);
ok(await call("ana", "daily_story", null) === null, "a day without a theme has no story");
const dealt0 = (await db.query(`select count(*)::int n from game_cards where game_id = $1 and card_id like 'th%'`, [g0.id])).rows[0].n;
ok(dealt0 === 0, "random dailies never deal theme cards");
ok(await call("ana", "daily_story", "2026-11-07") === null, "no peeking at tomorrow's story");

// tomorrow: the theme's cards in the theme's order
await setClock("2026-11-07T09:00:00+01:00");
const g = await call("ana", "play_daily", null);
const dealt = (await db.query(`select position, card_id from game_cards where game_id = $1 order by position`, [g.id])).rows;
ok(dealt.length === 11 && dealt.every(r => r.card_id === "th" + r.position), "the themed day deals the 11 theme cards in order");
let st = await call("ana", "daily_story", null);
ok(st && st.title === "A walk" && st.intro_de === "Intro DE" && st.chapters.length === 0 && st.outro === null,
   "before playing: title + intro, no chapters, no outro");
ok(st.start_credit === "Public domain", "the start card's photo credit comes along");

for (let k = 1; k <= 10; k++) {
  const c = await call("ana", "next_card", g.id);
  const rs = await rightSlot(g.id, c.position);
  await advance(4);
  await call("ana", "answer", g.id, c.position, rs.slot);
  if (k === 3) {
    st = await call("ana", "daily_story", null);
    ok(st.chapters.length === 3 && st.chapters[2].chapter === "Chapter 3" && st.chapters[0].credit.includes("CC BY-SA"),
       "after 3 cards: exactly 3 chapters (with credits)");
    const bst = await call("ben", "daily_story", null);
    ok(bst.chapters.length === 0, "Ben hasn't played: he sees no chapters");
  }
}
st = await call("ana", "daily_story", null);
ok(st.chapters.length === 10 && st.outro === "Outro EN" && st.outro_de === "Outro DE", "after the last card: all chapters and the outro");
ok(/permission denied/.test(await err(() => as("ana", "select * from daily_theme_cards"))), "the theme tables stay private");

// a theme added after the day was already dealt does not pretend to apply
await setClock("2026-11-08T09:00:00+01:00");
const g8 = await call("ben", "play_daily", null);
await db.exec(`insert into daily_themes (day, slug, title, intro) values ('2026-11-08', 'late', 'Late', 'Too late')`);
for (let i = 0; i <= 10; i++)
  await db.query(`insert into daily_theme_cards (day, position, card_id) values ('2026-11-08', $1, $2)`, [i, "th" + i]);
ok(await call("ben", "daily_story", null) === null, "a theme that came after the deal shows no story (cards don't match)");

// a short story: start card + 4 cards (Julian: "sometimes shortness is the sweetest")
await db.exec(`insert into daily_themes (day, slug, title, intro, outro) values ('2026-11-09', 'short', 'Short', 'Quick one', 'Done')`);
for (let i = 0; i <= 4; i++)
  await db.query(`insert into daily_theme_cards (day, position, card_id, chapter) values ('2026-11-09', $1, $2, $3)`, [i, "th" + (i + 3), "C" + i]);
await setClock("2026-11-09T09:00:00+01:00");
const gs = await call("ana", "play_daily", null);
ok(gs.card_count === 4 || (await call("ana", "get_game", gs.id)).card_count === 4, "a short story daily has 4 cards to place");
let sum = await call("ana", "daily_summary");
ok(sum.card_count === 4 && sum.status === "in_progress", `the home card knows it has 4 cards (${sum.card_count}, ${sum.status})`);
for (let k = 1; k <= 4; k++) {
  const c = await call("ana", "next_card", gs.id);
  const rs = await rightSlot(gs.id, c.position);
  await advance(4);
  const ra = await call("ana", "answer", gs.id, c.position, rs.slot);
  if (k === 1) ok(ra.artist_options && ra.artist_options.length === 4, "theme cards get the artist question too (4 names)");
}
sum = await call("ana", "daily_summary");
ok(sum.status === "done", "after 4 cards the short daily is done");
st = await call("ana", "daily_story", null);
ok(st.outro === "Done" && st.chapters.length === 4, "short story: 4 chapters and the ending");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
