// Live and async games on an embedded Postgres with a simulated clock.
// Usage: node games.test.mjs <migrations dir> <deck.sql>
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
for (const f of fs.readdirSync(DIR).filter(f => /^00[12]_/.test(f)).sort()) await db.exec(fs.readFileSync(`${DIR}/${f}`, "utf8"));
await db.exec(fs.readFileSync(DECK, "utf8"));

// ── helpers ──────────────────────────────────────────────────────────────
let clock = new Date("2026-11-05T18:00:00Z").getTime();
const setClock = async ms => { clock = ms; await db.exec(`set circart.test_now = '${new Date(ms).toISOString()}'`); };
const advance = s => setClock(clock + s * 1000);
await setClock(clock);

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
// The test peeks at the answer as superuser so it can play "right" or "wrong" on purpose.
async function rightSlot(game, pos) {
  const r = (await db.query(`select c.year, c.artist, _years_before($1,$2) ys from game_cards gc join cards c on c.id=gc.card_id
                              where gc.game_id=$1 and gc.position=$2`, [game, pos])).rows[0];
  return { slot: r.ys.filter(y => y < r.year).length, n: r.ys.length, artist: r.artist };
}
const wrongSlot = (s) => s.slot === 0 ? s.n : 0;

await signUp("ana"); await signUp("ben", true); await signUp("cara", true); await signUp("eve");

// ═══ LIVE ════════════════════════════════════════════════════════════════
console.log("live: lobby");
const live = await call("ana", "create_game", "live", null, null, "Ana");
ok(/^[A-HJ-NP-Z2-9]{4}$/.test(live.code), `4-character code: ${live.code}`);
await call("ben", "join_game", live.code.toLowerCase(), "Ben");
await call("cara", "join_game", live.code, "Cara");
let st = await call("ana", "get_game", live.id);
ok(st.phase === "lobby" && st.players.length === 3 && st.is_host, "lobby shows 3 players, Ana is host");
ok((await as("ben", `select display_name from profiles where id = auth.uid()`))[0].display_name === "Ben", "guest's chosen name is kept");
ok((await err(() => call("eve", "get_game", live.id))).includes("game_not_found"), "outsiders can't see the game");
ok((await as("eve", `select count(*)::int n from games where id=$1`, [live.id]))[0].n === 0, "…nor read it directly");
ok((await err(() => call("ben", "start_game", live.id))).includes("not_host"), "only the host can start");
ok((await err(() => as("ana", `select * from game_cards`))).includes("permission denied"), "dealt cards unreadable");
ok((await err(() => as("ana", `select * from answers`))).includes("permission denied"), "answers unreadable");
await call("ana", "start_game", live.id);
ok((await err(() => call("eve", "join_game", live.code))).includes("game_started"), "can't join once started");
const dealt = (await db.query(`select position, artist_options from game_cards where game_id=$1 order by position`, [live.id])).rows;
ok(dealt.length === 11 && dealt.slice(1).every(d => d.artist_options.length === 4), "10 cards + start card, 4 artist names each");

console.log("\nlive: round 1");
const t0 = clock;
let c = await call("ana", "next_card", live.id);
ok(c.position === 1 && c.image_url && !("year" in c) && !("artist" in c), "card arrives as image only");
ok(!/\/\d{4}-/.test(c.image_url), "image link has no year");
await call("ben", "next_card", live.id); await call("cara", "next_card", live.id);
let s1 = await rightSlot(live.id, 1);
await advance(3);
let r = await call("ana", "answer", live.id, 1, s1.slot);
ok(!("correct" in r) && r.artist_options.length === 4, "live: result kept secret, artist options offered");
ok((await err(() => call("ana", "answer", live.id, 1, s1.slot))).includes("already_answered"), "can't answer twice");
ok((await err(() => call("ana", "reveal", live.id, 1))).includes("not_yet"), "no peeking before the round closes");
await call("ana", "pick_artist", live.id, 1, s1.artist);
await advance(7);
await call("ben", "answer", live.id, 1, wrongSlot(s1));
await call("ben", "pick_artist", live.id, 1, null);
st = await call("ana", "get_game", live.id);
ok(st.phase === "play" || st.phase === "waiting", "round still open while Cara thinks");
await setClock(t0 + 23000);                       // past 20 s + 2 s grace
st = await call("ana", "get_game", live.id);
ok(st.phase === "reveal", "round closes when time is up");
const sc = Object.fromEntries(st.players.map(p => [p.name, p.score]));
ok(sc.Ana === 925 + 200 && sc.Ben === 0 && sc.Cara === 0, `scores: fast+artist 1125, wrong 0, no answer 0 → ${JSON.stringify(sc)}`);
let rv = await call("ben", "reveal", live.id, 1);
ok(rv.card.year && rv.card.trivia !== undefined && rv.correct_slot === s1.slot, "reveal: year, trivia, correct gap");
ok(rv.distribution[String(s1.slot)] === 1 && Object.values(rv.distribution).reduce((a, b) => a + b, 0) === 2,
   "reveal shows where everyone placed it");
ok(st.timeline.length === 2, "card joins the shared timeline for everyone (right or wrong)");
ok((await call("cara", "get_game", live.id)).timeline.length === 2, "…including the player who missed it");

console.log("\nlive: rounds 2–10");
await advance(8);
st = await call("ana", "get_game", live.id);
ok(st.phase === "play" && st.current_turn === 2, "after the 8 s reveal the next round starts");
let streakSeen = false;
for (let pos = 2; pos <= 10; pos++) {
  if (pos > 2) { await advance(8); await call("ana", "get_game", live.id); }
  const rs = await rightSlot(live.id, pos);
  for (const p of ["ana", "ben", "cara"]) await call(p, "next_card", live.id);
  await advance(2);
  for (const p of ["ana", "ben", "cara"]) {
    await call(p, "answer", live.id, pos, p === "cara" ? wrongSlot(rs) : rs.slot);
    await call(p, "pick_artist", live.id, pos, null);
  }
  if (pos === 3) {
    const a3 = (await db.query(`select points from answers where game_id=$1 and position=3 and player_id=$2`, [live.id, users.ana])).rows[0];
    streakSeen = a3.points === 950 + 100;          // 3 in a row → +100
  }
  st = await call("ana", "get_game", live.id);
  if (pos === 2) ok(st.phase === "reveal", "round closes early once everyone has answered");
}
ok(streakSeen, "streak bonus: third correct in a row earns +100");
await advance(8);
st = await call("ana", "get_game", live.id);
ok(st.status === "finished" && st.phase === "finished", "game ends after 10 cards");
const ranks = Object.fromEntries(st.players.map(p => [p.name, p.rank]));
ok(ranks.Ana === 1 && ranks.Cara === 3, `podium: ${JSON.stringify(ranks)}`);
ok(st.timeline.length === 11, "full 11-card timeline to scroll through at the end");

// ═══ ASYNC ═══════════════════════════════════════════════════════════════
console.log("\nasync: 4 turns × 3 cards");
const as1 = await call("ana", "create_game", "async");
await call("ben", "join_game", as1.code); await call("cara", "join_game", as1.code);
await call("ana", "start_game", as1.id);
st = await call("ana", "get_game", as1.id);
ok(st.turns === 4 && st.cards_per_turn === 3, "12 cards as 4 turns of 3");
const deadline1 = new Date(st.turn_deadline).getTime();
ok(deadline1 - clock === 24 * 3600 * 1000, "24 hours for the turn");
let mg = await call("ben", "my_games");
ok(mg[0].id === as1.id && mg[0].my_turn === true && mg[0].others.length === 2, "home screen: 'your turn' for Ben");

async function playTurn(who, game, wrongPos = [], max = 3) {
  for (let k = 0; k < max; k++) {
    const card = await call(who, "next_card", game);
    if (card.wait) return card;
    const rs = await rightSlot(game, card.position);
    await advance(4);
    const res = await call(who, "answer", game, card.position, wrongPos.includes(card.position) ? wrongSlot(rs) : rs.slot);
    if (card.position === 1 && who === "ana") {
      ok(res.correct === true && res.points === 900, "async: own result right away (900 pts at 4 s)");
      const art = await call(who, "pick_artist", game, card.position, rs.artist);
      ok(art.artist_correct === true, "artist pick confirmed");
      const rv1 = await call(who, "reveal", game, card.position);
      ok(!rv1.distribution, "others' choices stay hidden until the turn closes");
    }
  }
  return call(who, "next_card", game).then(c => (c.wait ? c : { wait: "more" }));
}
let w = await playTurn("ana", as1.id);
ok(w.wait === "turn_done", "after 3 cards: wait for the others");
ok((await call("ana", "get_game", as1.id)).current_turn === 1, "turn stays open for the others");
await advance(3600);
await playTurn("ben", as1.id, [2]);
// Cara opens a card and closes the app
c = await call("cara", "next_card", as1.id);
await advance(60);
c = await call("cara", "next_card", as1.id);
ok(c.position === 2, "a card left open past 20 s counts as missed; the next one comes up");
await playTurn("cara", as1.id, [], 1);   // she already lost card 1 and is on card 2
await playTurn("cara", as1.id, [], 1);
st = await call("ana", "get_game", as1.id);
ok(st.current_turn === 2, "turn closes as soon as everyone has played — no waiting for the deadline");
rv = await call("ana", "reveal", as1.id, 1);
ok(Object.values(rv.distribution).reduce((a, b) => a + b, 0) === 2, "now everyone's choices are visible (Cara missed this one)");

console.log("\nasync: missed turns");
await playTurn("ana", as1.id); await playTurn("ben", as1.id);
await advance(25 * 3600);                           // Cara misses turn 2
ok((await db.query(`select close_expired_games() n`)).rows[0].n >= 1, "scheduled job closes the expired turn");
st = await call("ana", "get_game", as1.id);
ok(st.current_turn === 3, "turn 3 opened");
ok((await db.query(`select missed_turns from game_players where game_id=$1 and player_id=$2`, [as1.id, users.cara])).rows[0].missed_turns === 1,
   "Cara has one strike");
await playTurn("ana", as1.id); await playTurn("ben", as1.id);
await advance(25 * 3600);                           // misses turn 3 too
st = await call("cara", "get_game", as1.id);
ok(st.phase === "dropped", "two missed turns in a row: dropped");
ok(st.current_turn === 4, "game carries on without her");
await playTurn("ana", as1.id);
st = await call("ana", "get_game", as1.id);
ok(st.phase === "waiting", "waiting for Ben only (Cara no longer counts)");
await playTurn("ben", as1.id);
st = await call("ana", "get_game", as1.id);
ok(st.status === "finished", "game finishes after turn 4");
ok(st.timeline.length === 13, "13-card timeline at the end");

console.log("\nasync: cheating and edge cases");
const as2 = await call("ana", "create_game", "async");
await call("ben", "join_game", as2.code);
await call("ana", "start_game", as2.id);
c = await call("ana", "next_card", as2.id);
await advance(30);
r = await call("ana", "answer", as2.id, c.position, 0);
ok(r.timed_out === true, "answer after 30 s is refused (server clock, not the phone's)");
ok((await err(() => call("ana", "answer", as2.id, 2, 0))).includes("card_not_open"), "can't answer a card you weren't shown");
ok((await err(() => call("ana", "answer", as2.id, 4, 0))).includes("card_not_open"), "can't play ahead into the next turn");
c = await call("ana", "next_card", as2.id);
await advance(3);
await call("ana", "answer", as2.id, c.position, 0);
await advance(20);
ok((await err(() => call("ana", "pick_artist", as2.id, c.position, "x"))).includes("artist_closed"), "artist pick closes 15 s after placing");
await call("ben", "leave_game", as2.id);
st = await call("ana", "get_game", as2.id);
ok(st.status === "finished", "if only one player is left, the game ends");
ok((await err(() => call("ana", "create_game", "async", 10, 3))).includes("bad_settings"), "card count must split into whole turns");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
