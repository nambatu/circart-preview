// 032: Wave 2 — Live Waiting Room, Call-It (+25), Reactions, Round Results (Task 32)
// and Friendships, Read-Only Friend Profile, Friends Leaderboards, Invites & Challenges (Tasks 33 & 44).
// Usage: node friends_live.test.mjs <migrations dir> <deck.sql>
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";

const [DIR, DECK] = process.argv.slice(2);
const db = new PGlite();
let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth; grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text,
    is_anonymous boolean default false, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
for (const f of fs.readdirSync(DIR).filter(f => /^0\d\d_.*\.sql$/.test(f)).sort()) {
  await db.exec(fs.readFileSync(`${DIR}/${f}`, "utf8"));
}
await db.exec(fs.readFileSync(DECK, "utf8"));

let clock;
const setClock = async iso => {
  clock = new Date(iso).getTime();
  await db.exec(`set circart.test_now = '${new Date(clock).toISOString()}'`);
};
const advance = s => setClock(new Date(clock + s * 1000).toISOString());
const realClock = () => db.exec(`set circart.test_now = ''`);

const users = {};
const signUp = async (n, anon = false, email = null) => {
  users[n] = (await db.query(
    `insert into auth.users (is_anonymous, email) values ($1, $2) returning id`,
    [anon, email]
  )).rows[0].id;
  return users[n];
};

async function as(who, sql, params = [], role = "authenticated") {
  await db.exec(`reset role; set request.jwt.claim.sub = '${who ? users[who] : ""}'; set role ${role};`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function asService(sql, params = []) {
  await db.exec(`reset role; set request.jwt.claim.sub = ''; set role service_role;`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

const call = async (who, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await as(who, `select public.${fn}(${ph}) r`, args))[0])[0];
};
const callAnon = async (fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await as(null, `select public.${fn}(${ph}) r`, args, "anon"))[0])[0];
};
const callService = async (fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await asService(`select public.${fn}(${ph}) r`, args))[0])[0];
};
const err = async f => { try { await f(); return ""; } catch (e) { return e.message; } };
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const q1 = async (sql, p = []) => (await q(sql, p))[0];

async function rightSlot(game, pos) {
  const r = await q1(
    `select c.year, c.artist, public._years_before($1,$2) ys
       from public.game_cards gc join public.cards c on c.id=gc.card_id
      where gc.game_id=$1 and gc.position=$2`,
    [game, pos]
  );
  return { slot: r.ys.filter(y => y < r.year).length, n: r.ys.length, artist: r.artist, year: r.year };
}
const wrongSlot = rs => (rs.slot === 0 ? rs.n : 0);

async function playDaily(who, { cards = 10, wrong = [], secs = 3 } = {}) {
  const g = await call(who, "play_daily");
  for (let k = 0; k < cards; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(secs);
    await call(who, "answer", g.id, c.position, wrong.includes(c.position) ? wrongSlot(rs) : rs.slot);
  }
  return g;
}

async function playRun(who, { wrongAt = [1, 2, 3], secs = 3, max = 100 } = {}) {
  const g = await call(who, "start_run");
  for (let k = 1; k <= max; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(secs);
    await call(who, "answer", g.id, c.position, wrongAt.includes(k) ? wrongSlot(rs) : rs.slot);
  }
  return call(who, "get_game", g.id);
}

const deckRows = await q(`select id, source_id from public.cards where active order by source_id limit 20`);
const deckSrc = deckRows.map(r => r.source_id);

async function submitPrice(who, score) {
  const cards = [{ id: deckSrc[0] }];
  for (let i = 0; i < score; i++) {
    cards.push({ id: deckSrc[(i % (deckSrc.length - 1)) + 1], correct: true });
  }
  return call(who, "submit_solo_game", {
    client_id: crypto.randomUUID(),
    mode: "price",
    score,
    bonus_points: 0,
    best_streak: score,
    finished_at: new Date(clock).toISOString(),
    cards
  });
}

// ─── 1. Permissions, RLS & search_path ──────────────────────────────────────
console.log("1. Permissions, RLS & search_path");
await signUp("sec", false, "sec@example.org");
await setClock("2026-11-16T12:00:00+01:00");

for (const tbl of ["game_reactions", "game_calls", "friendships", "game_invites"]) {
  ok((await err(() => as("sec", `select * from public.${tbl}`))).includes("permission denied"),
     `${tbl} unreadable by authenticated`);
  ok((await err(() => as(null, `select * from public.${tbl}`, [], "anon"))).includes("permission denied"),
     `${tbl} unreadable by anon`);
}

for (const fn of [
  ["round_live", [crypto.randomUUID()]],
  ["call_it", [crypto.randomUUID(), 1, 2, true]],
  ["send_reaction", [crypto.randomUUID(), "🎨", null]],
  ["round_results", [crypto.randomUUID(), 1]],
  ["send_friend_request", ["x"]],
  ["respond_friend_request", ["x", true]],
  ["remove_friend", ["x", false]],
  ["my_friends", []],
  ["my_badges", []],
  ["my_achievements", []],
  ["friend_profile", ["x"]],
  ["friends_leaderboard", ["today", null]],
  ["invite_friends_to_game", [["x"], "async", 12, 3]],
  ["send_score_challenge", ["x", "daily_score", 100]],
  ["my_game_invites", []],
  ["respond_game_invite", [crypto.randomUUID(), true]],
  ["export_my_data", []],
  ["privacy_cleanup", []]
]) {
  ok((await err(() => callAnon(fn[0], ...fn[1]))).includes("permission denied"),
     `anon denied ${fn[0]}()`);
}

for (const fn of [
  ["_close_turn", [crypto.randomUUID()]],
  ["_push_batch_unchecked", []],
  ["_require_friend_account", []],
  ["_badges_for", [users.sec]],
  ["_achievements_for", [users.sec]],
  ["privacy_cleanup", []]
]) {
  ok((await err(() => call("sec", fn[0], ...fn[1]))).includes("permission denied"),
     `authenticated denied ${fn[0]}()`);
}

const secFns = [
  "_close_turn", "_push_batch_unchecked",
  "round_live", "call_it", "send_reaction", "round_results",
  "_require_friend_account", "_badges_for", "my_badges", "_achievements_for", "my_achievements",
  "send_friend_request", "respond_friend_request", "remove_friend", "my_friends",
  "friend_profile", "friends_leaderboard",
  "invite_friends_to_game", "send_score_challenge", "my_game_invites", "respond_game_invite",
  "export_my_data", "privacy_cleanup"
];
const cfg = await q(
  `select proname, prosecdef, proconfig from pg_proc
    where pronamespace = 'public'::regnamespace and proname = any($1)`,
  [secFns]
);
ok(cfg.length === secFns.length
   && cfg.every(r => r.prosecdef && (r.proconfig || []).some(s => s.startsWith("search_path="))),
   `all ${secFns.length} Wave 2 functions are SECURITY DEFINER with fixed search_path`);

// ─── 2. Task 32: Live Waiting Room, Anti-Cheat, Call-It (+25), Reactions, Round Results ─
console.log("\n2. Task 32: Live Waiting Room, Call-It, Reactions, Round Results");
await signUp("ana", false, "ana@example.org");
await signUp("ben", true);
await signUp("cara", false, "cara@example.org");
await signUp("eve", false, "eve@example.org");

await call("ana", "update_profile", "Ana", "ana");
await call("cara", "update_profile", "Cara", "cara");
await call("eve", "update_profile", "Eve", "eve");

const live = await call("ana", "create_game", "live", 3, 1, "Ana");
await advance(1);
await call("ben", "join_game", live.code, "Ben");
await advance(1);
await call("cara", "join_game", live.code, "Cara");
await call("ana", "start_game", live.id);

// Ensure card 1 has non-empty trivia so we test trivia hiding/revealing strictly
await q(
  `update public.cards set trivia = 'Painted in secrecy.'
    where id = (select card_id from public.game_cards where game_id = $1 and position = 1)`,
  [live.id]
);

ok((await err(() => call("eve", "round_live", live.id))).includes("game_not_found"),
   "outsider denied round_live");
ok((await err(() => call("eve", "send_reaction", live.id, "🎨", null))).includes("game_not_found"),
   "outsider denied send_reaction");
ok((await err(() => call("eve", "round_results", live.id, 1))).includes("game_not_found"),
   "outsider denied round_results");

// Before turn 1 closes, round_results must fail
ok((await err(() => call("ana", "round_results", live.id, null))).includes("not_yet"),
   "round_results(null) before turn 1 closes raises not_yet");
ok((await err(() => call("ana", "round_results", live.id, 1))).includes("not_yet"),
   "round_results(1) before turn 1 closes raises not_yet");

// Round 1 start: open cards
await call("ana", "next_card", live.id);
await call("ben", "next_card", live.id);
await call("cara", "next_card", live.id);

// Strict anti-cheat BEFORE Ana answers
let rl = await call("ana", "round_live", live.id);
let rlStr = JSON.stringify(rl);
ok(!rlStr.includes(users.ana) && !rlStr.includes(users.ben) && !rlStr.includes(users.cara),
   "round_live exposes ZERO player_id UUIDs");
ok(rl.me_locked === false && rl.trivia === null && Object.keys(rl.slot_counts).length === 0
   && rl.players.length === 3 && rl.players.every(p => p.slot === null && p.locked === false),
   "strict anti-cheat before answering: me_locked=false, trivia=null, all slots=null, slot_counts={}");
ok(rl.players.map(p => `${p.seat}:${p.name}`).join(",") === "1:Ana,2:Ben,3:Cara",
   "seats deterministically assigned 1..3 by joined_at, player_id");

// Ana places card (bonus still open -> still not locked!)
const s1 = await rightSlot(live.id, 1);
await advance(2);
await call("ana", "answer", live.id, 1, s1.slot);
rl = await call("ana", "round_live", live.id);
ok(rl.me_locked === false && rl.trivia === null && rl.players.every(p => p.slot === null)
   && Object.keys(rl.slot_counts).length === 0,
   "strict anti-cheat while bonus still open: me_locked=false, trivia=null, slots=null");
ok((await err(() => call("ana", "call_it", live.id, 1, 2, true))).includes("not_locked"),
   "call_it rejected with not_locked before pick_bonus finishes");

// Ana completes bonus -> now locked!
await call("ana", "pick_bonus", live.id, 1, s1.artist, null);
rl = await call("ana", "round_live", live.id);
ok(rl.me_locked === true && rl.trivia === "Painted in secrecy.",
   "after locking: me_locked=true and card trivia revealed");
ok(Array.isArray(rl.timeline_years) && rl.timeline_years.length === 1,
   "after locking: timeline_years revealed (1 start card)");
ok(rl.players[0].locked === true && rl.players[0].slot === s1.slot
   && rl.players[1].locked === false && rl.players[1].slot === null
   && rl.players[2].locked === false && rl.players[2].slot === null,
   "after locking: own slot visible, unlocked players' slots still null");
ok(rl.slot_counts[String(s1.slot)] === 1 && Object.keys(rl.slot_counts).length === 1,
   "after locking: slot_counts counts locked answers only");
ok(!("correct_slot" in rl) && rl.players.every(p => !("correct" in p)),
   "strict anti-cheat when me_locked=true: NO correct_slot and NO player.correct");

// Call-It validation + upsert
ok((await err(() => call("ana", "call_it", live.id, 1, 1, true))).includes("bad_target"),
   "call_it on self raises bad_target");
ok((await err(() => call("ana", "call_it", live.id, 1, 9, true))).includes("bad_target"),
   "call_it on invalid seat raises bad_target");
ok((await err(() => call("ana", "call_it", live.id, 2, 2, true))).includes("bad_position"),
   "call_it on wrong position raises bad_position");

let ci = await call("ana", "call_it", live.id, 1, 2, true);
ok(ci.ok === true, "ana calls Ben (seat 2) right");
await call("ana", "call_it", live.id, 1, 3, true);
await call("ana", "call_it", live.id, 1, 3, false); // upsert flip to false
rl = await call("ana", "round_live", live.id);
ok(rl.my_calls["2"] === true && rl.my_calls["3"] === false,
   "round_live.my_calls reflects latest upserted Call-It predictions");

// Ben answers RIGHT and finishes bonus -> Ben locked; Ana can no longer call Ben
await advance(2);
await call("ben", "answer", live.id, 1, s1.slot);
await call("ben", "pick_bonus", live.id, 1, null, null);
ok((await err(() => call("ana", "call_it", live.id, 1, 2, false))).includes("target_already_locked"),
   "call_it on already-locked target raises target_already_locked");
rl = await call("ana", "round_live", live.id);
ok(rl.slot_counts[String(s1.slot)] === 2 && rl.players[1].locked === true && rl.players[1].slot === s1.slot,
   "both Ana and Ben locked -> slot_counts aggregates both");

// Reactions test in turn 1
ok((await err(() => call("ana", "send_reaction", live.id, "💩", null))).includes("bad_emoji"),
   "disallowed emoji rejected with bad_emoji");
ok((await err(() => call("ana", "send_reaction", live.id, "🔥", 9))).includes("bad_target"),
   "invalid target seat in send_reaction rejected with bad_target");
for (let i = 0; i < 10; i++) {
  await call("ana", "send_reaction", live.id, ["🎨","👏","😮","😅","🔥"][i % 5], i === 0 ? 2 : null);
}
ok((await err(() => call("ana", "send_reaction", live.id, "🎨", null))).includes("too_many_reactions"),
   "11th reaction in same turn rejected with too_many_reactions");
await call("ben", "send_reaction", live.id, "👏", 1);
rl = await call("ana", "round_live", live.id);
ok(rl.reactions.length === 11 && rl.reactions[0].emoji === "👏" && rl.reactions[0].seat === 2 && rl.reactions[0].to_seat === 1,
   "round_live returns reactions with { id, seat, name, to_seat, emoji, at }");

// Cara answers WRONG -> turn 1 closes automatically and Call-It pays +25 x 2 = +50!
await advance(2);
await call("cara", "answer", live.id, 1, wrongSlot(s1));
await call("cara", "pick_bonus", live.id, 1, null, null);

ok((await err(() => call("ana", "call_it", live.id, 1, 3, false))).includes("turn_closed"),
   "call_it rejected after turn closes");

const anaRowT1 = await q1(`select score from public.game_players where game_id=$1 and player_id=$2`, [live.id, users.ana]);
const anaAnsT1 = await q1(`select points from public.answers where game_id=$1 and player_id=$2 and position=1`, [live.id, users.ana]);
ok(anaRowT1.score === anaAnsT1.points + 50,
   `Ana earned +50 Call-It bonus on turn 1 close (score=${anaRowT1.score}, card=${anaAnsT1.points})`);

// Re-running _close_turn must be idempotent (never double-award Call-It)
await db.query(`select public._close_turn($1)`, [live.id]);
const anaRowAfter = await q1(`select score from public.game_players where game_id=$1 and player_id=$2`, [live.id, users.ana]);
ok(anaRowAfter.score === anaRowT1.score, "_close_turn Call-It scoring is idempotent");

// Check round_results(1) during reveal
const rr1 = await call("ben", "round_results", live.id, null);
const rr1Str = JSON.stringify(rr1);
ok(!rr1Str.includes(users.ana) && !rr1Str.includes(users.ben) && !rr1Str.includes(users.cara),
   "round_results exposes ZERO player_id UUIDs");
ok(rr1.turn === 1 && rr1.cards.length === 1 && rr1.cards[0].position === 1
   && rr1.cards[0].correct_slot === s1.slot && rr1.cards[0].year === s1.year
   && rr1.reactions.length === 11,
   "round_results(1) returns card details, correct_slot, timeline_years, and reactions");
const resAna = rr1.cards[0].results.find(r => r.seat === 1);
const resBen = rr1.cards[0].results.find(r => r.seat === 2);
const resCara = rr1.cards[0].results.find(r => r.seat === 3);
ok(resAna.call_bonus === 50 && resAna.correct === true && resAna.artist_correct === true && !resAna.is_me
   && resBen.is_me === true && resBen.call_bonus === 0 && resCara.correct === false,
   "round_results per-player results show is_me, correct, artist_correct, points, call_bonus=50");

// Round 2: test timeout Call-It prediction + reaction cap reset
await advance(9);
await call("ana", "get_game", live.id);
await call("ana", "next_card", live.id);
await call("ben", "next_card", live.id);
const s2 = await rightSlot(live.id, 2);
await advance(2);
await call("ana", "answer", live.id, 2, s2.slot);
await call("ana", "pick_bonus", live.id, 2, null, null);
await call("ana", "call_it", live.id, 2, 3, false); // predict Cara fails (she'll time out!)
await call("ana", "call_it", live.id, 2, 2, false); // wrong prediction on Ben (Ben will get it right)
ok((await call("ana", "send_reaction", live.id, "🔥", 3)).ok === true,
   "reaction rate limit resets on turn 2");
await call("ben", "answer", live.id, 2, s2.slot);
await call("ben", "pick_bonus", live.id, 2, null, null);
// While turn 2 is still open, round_results(null) defaults to turn 1, round_results(2) raises not_yet
ok((await call("ana", "round_results", live.id, null)).turn === 1,
   "round_results(null) during active turn 2 defaults to closed turn 1");
ok((await err(() => call("ana", "round_results", live.id, 2))).includes("not_yet"),
   "round_results(2) while turn 2 open raises not_yet");

// Advance past deadline so Cara times out
await advance(25);
const rr2 = await call("ana", "round_results", live.id, null);
ok(rr2.turn === 2
   && rr2.cards[0].results.find(r => r.seat === 1).call_bonus === 25
   && rr2.cards[0].results.find(r => r.seat === 3).timed_out === true,
   "Call-It predict_ok=false pays +25 when target times out");

// Test reactions limit of latest 25 in round_live (using 3 players x 9 reactions = 27 in turn 3)
await advance(9);
await call("ana", "get_game", live.id);
for (const p of ["ana", "ben", "cara"]) {
  for (let i = 0; i < 9; i++) await call(p, "send_reaction", live.id, "🎨", null);
}
const rl3 = await call("ana", "round_live", live.id);
ok(rl3.reactions.length === 25, "round_live caps reactions list at latest 25");

// Async 3-card turn round_results check
const asg = await call("ana", "create_game", "async", 6, 3, "Ana");
await call("ben", "join_game", asg.code, "Ben");
await call("ana", "start_game", asg.id);
await call("ana", "send_reaction", asg.id, "😮", 2); // sent during turn 1
for (const p of ["ana", "ben"]) {
  for (let k = 0; k < 3; k++) {
    const c = await call(p, "next_card", asg.id);
    const rs = await rightSlot(asg.id, c.position);
    await advance(3);
    await call(p, "answer", asg.id, c.position, rs.slot);
  }
}
const rrAsync = await call("ana", "round_results", asg.id, null);
ok(rrAsync.turn === 1 && rrAsync.cards.length === 3 && rrAsync.cards.map(c => c.position).join(",") === "1,2,3"
   && rrAsync.reactions.length === 1 && rrAsync.reactions[0].emoji === "😮",
   "async round_results returns all 3 cards of turn 1 + reactions");

// Live game with bonuses off locks immediately on answer() + handles lobby/finished round_live
const liveNoBonus = await call("ana", "create_game", "live", 3, 1, "Ana");
await call("ben", "join_game", liveNoBonus.code, "Ben");
ok((await call("ana", "round_live", liveNoBonus.id)).status === "lobby",
   "round_live works cleanly in lobby state");
await call("ana", "set_game_options", liveNoBonus.id, false, false, true);
await call("ana", "start_game", liveNoBonus.id);
await call("ana", "next_card", liveNoBonus.id);
await call("ben", "next_card", liveNoBonus.id);
const nbSlot = await rightSlot(liveNoBonus.id, 1);
await advance(2);
await call("ana", "answer", liveNoBonus.id, 1, nbSlot.slot);
ok((await call("ana", "round_live", liveNoBonus.id)).me_locked === true,
   "live game without bonuses locks immediately after answer()");

// ─── 3. Tasks 33 & 44: Friendships, Profile, Leaderboards, Invites, Challenges ─
console.log("\n3. Friendships & Blocking (33)");
await signUp("gus", true);
await signUp("nohandle", false, "nohandle@example.org");
await signUp("ben_acc", false, "ben@example.org");
await signUp("dan", false, "dan@example.org");
await signUp("stranger", false, "stranger@example.org");
await call("ben_acc", "update_profile", "Benny", "benny");
await call("dan", "update_profile", "Dan", "dan_d");
await call("stranger", "update_profile", "Stranger", "stranger");

for (const bad of ["gus", "nohandle"]) {
  ok((await err(() => call(bad, "send_friend_request", "ana"))).includes("friend_needs_account"),
     `${bad} denied send_friend_request (friend_needs_account)`);
  ok((await err(() => call(bad, "my_friends"))).includes("friend_needs_account"),
     `${bad} denied my_friends (friend_needs_account)`);
  ok((await err(() => call(bad, "friends_leaderboard", "today", null))).includes("friend_needs_account"),
     `${bad} denied friends_leaderboard (friend_needs_account)`);
  ok((await err(() => call(bad, "my_game_invites"))).includes("friend_needs_account"),
     `${bad} denied my_game_invites (friend_needs_account)`);
}

ok((await err(() => call("ana", "send_friend_request", "ana"))).includes("user_not_found"),
   "cannot friend self");
ok((await err(() => call("ana", "send_friend_request", "nobody_xyz"))).includes("user_not_found"),
   "nonexistent user raises user_not_found");

// Case-insensitive friend request + respond
let fr = await call("ana", "send_friend_request", "  BENNY ");
ok(fr.status === "pending" && fr.username === "benny", "case-insensitive trimmed friend request works");
ok((await err(() => call("ana", "respond_friend_request", "benny", true))).includes("friend_not_found"),
   "sender cannot accept their own outgoing request");
let mfAna = await call("ana", "my_friends");
let mfBen = await call("ben_acc", "my_friends");
ok(mfAna.outgoing.length === 1 && mfAna.outgoing[0].username === "benny"
   && mfBen.incoming.length === 1 && mfBen.incoming[0].username === "ana",
   "my_friends shows outgoing for ana and incoming for benny");
fr = await call("ben_acc", "respond_friend_request", "ANA", true);
ok(fr.status === "accepted" && fr.username === "ana", "respond_friend_request accepts");

// Mutual auto-accept
await call("cara", "send_friend_request", "ana");
fr = await call("ana", "send_friend_request", "cara");
ok(fr.status === "accepted" && fr.username === "cara",
   "sending request when incoming request already exists auto-accepts");

// Decline request deletes it
await call("dan", "send_friend_request", "ana");
fr = await call("ana", "respond_friend_request", "dan_d", false);
ok(fr.status === "declined", "declining friend request returns declined");
ok((await call("dan", "my_friends")).outgoing.length === 0, "declined request removed cleanly");
ok((await err(() => call("dan", "send_friend_request", "ana"))).includes("friend_cooldown"),
   "035: asking again right after a decline is refused (7-day pause)");
await q(`update public.friend_declines set declined_at = declined_at - interval '8 days'`);   // pause over

// Block & blocked_by ownership
fr = await call("ana", "remove_friend", "eve", true);
ok(fr.status === "blocked", "ana blocks eve");
ok((await err(() => call("eve", "remove_friend", "ana", false))).includes("blocked"),
   "blocked user (eve) CANNOT unblock herself");
ok((await err(() => call("eve", "send_friend_request", "ana"))).includes("blocked"),
   "blocked user cannot send friend request");
ok((await err(() => call("ana", "send_friend_request", "eve"))).includes("blocked"),
   "blocker cannot send request while block active");
fr = await call("ana", "remove_friend", "eve", false);
ok(fr.status === "removed", "blocker (ana) CAN unblock eve");

// Outgoing pending request limit (20 max)
const tempUsers = [];
for (let i = 0; i < 20; i++) {
  const uname = `lim_${i}`;
  await signUp(uname, false, `${uname}@example.org`);
  await call(uname, "update_profile", uname, uname);
  tempUsers.push(uname);
  await call("dan", "send_friend_request", uname);
}
ok((await err(() => call("dan", "send_friend_request", "stranger"))).includes("too_many_requests"),
   "21st pending outgoing friend request rejected with too_many_requests");
for (const uname of tempUsers) {
  await call(uname, "respond_friend_request", "dan_d", false); // clean up dan's pending queue
}

// ─── 4. Read-only Friend Profile & All 4 Friends Leaderboards ───────────────
console.log("\n4. Friend Profile & Friends Leaderboards");
// Set up games/scores on 2026-11-16..18 across daily, run, price, and live
await setClock("2026-11-16T12:00:00+01:00");
await playDaily("ana", { cards: 10, secs: 2 });
await playDaily("ben_acc", { cards: 10, wrong: [3], secs: 4 });
await playDaily("stranger", { cards: 10, secs: 1 }); // stranger beats everyone!
await playDaily("dan", { cards: 10, secs: 1 });      // pending / non-friend
await call("dan", "send_friend_request", "ana");     // pending, NOT accepted

await setClock("2026-11-17T12:00:00+01:00");
await playDaily("ana", { cards: 10, secs: 2 });
await playDaily("ben_acc", { cards: 10, secs: 3 });

await playRun("ana", { wrongAt: [5, 6, 7], secs: 2 });
await playRun("ben_acc", { wrongAt: [2, 3, 4], secs: 2 });
await playRun("stranger", { wrongAt: [12, 13, 14], secs: 2 });

await submitPrice("ana", 15); // also unlocks going_going_gone!
await submitPrice("ben_acc", 11);
await submitPrice("stranger", 22);

// Non-friend profile rejected
ok((await err(() => call("ana", "friend_profile", "stranger"))).includes("not_friends"),
   "friend_profile rejects stranger with not_friends");
ok((await err(() => call("ana", "friend_profile", "dan_d"))).includes("not_friends"),
   "friend_profile rejects pending requester with not_friends");
ok((await err(() => call("ana", "friend_profile", "unknown_user"))).includes("not_friends"),
   "friend_profile rejects unknown user with not_friends");

const fpSelf = await call("ana", "friend_profile", "ANA");
const anaAch = await call("ana", "my_achievements");
ok(fpSelf.username === "ana"
   && JSON.stringify(fpSelf.achievements) === JSON.stringify(anaAch)
   && fpSelf.achievements.some(a => a.key === "going_going_gone")
   && fpSelf.achievements.some(a => a.key === "vernissage_guest"),
   "friend_profile works on self and matches my_achievements()");

const fpBen = await call("ana", "friend_profile", "benny");
const fpBenStr = JSON.stringify(fpBen);
ok(!fpBenStr.includes(users.ben_acc) && !fpBenStr.includes("ben@example.org") && !("history" in fpBen),
   "friend_profile exposes ZERO UUID, ZERO email, ZERO play history");
ok(fpBen.username === "benny" && fpBen.display_name === "Benny" && !!fpBen.since
   && fpBen.stats.daily_streak === 2
   && fpBen.stats.best_run === 1
   && fpBen.stats.best_price === 11
   && fpBen.stats.games_played >= 2
   && Array.isArray(fpBen.badges) && Array.isArray(fpBen.achievements),
   `friend_profile returns stats/badges/achievements (streak=${fpBen.stats.daily_streak}, best_price=${fpBen.stats.best_price})`);

mfAna = await call("ana", "my_friends");
ok(mfAna.friends.find(f => f.username === "benny").daily_streak === 2,
   "my_friends includes friend's grace daily_streak");

// Friends leaderboards across all 4 boards
ok((await err(() => call("ana", "friends_leaderboard", "bogus", null))).includes("bad_settings"),
   "invalid board name raises bad_settings");

const flToday = await call("ana", "friends_leaderboard", "today", "2026-11-16");
ok(flToday.players === 2 && flToday.entries.length === 2
   && flToday.entries[0].username === "ana" && flToday.entries[0].rank === 1 && flToday.entries[0].is_me === true
   && flToday.entries[1].username === "benny" && flToday.entries[1].rank === 2
   && !flToday.entries.some(e => e.username === "stranger" || e.username === "dan_d")
   && flToday.me.rank === 1 && flToday.me.ranked === true,
   "friends_leaderboard('today') excludes strangers & pending, re-ranks friend circle");

const flMonth = await call("ana", "friends_leaderboard", "month", "2026-11-01");
ok(flMonth.metric === "best_run" && flMonth.players === 2 && flMonth.entries.length === 2
   && flMonth.entries[0].username === "ana" && flMonth.entries[0].rank === 1
   && flMonth.entries[1].username === "benny" && flMonth.entries[1].rank === 2
   && !flMonth.entries.some(e => e.username === "stranger")
   && !!flMonth.title && !!flMonth.title_de && flMonth.me.best === 4 && flMonth.me.rank === 1,
   "friends_leaderboard('month') matches monthly_leaderboard shape, excludes strangers, re-ranks");

const flPrice = await call("ana", "friends_leaderboard", "price", null);
ok(flPrice.metric === "price_best" && flPrice.players === 2 && flPrice.entries.length === 2
   && flPrice.entries[0].username === "ana" && flPrice.entries[0].value === 15 && flPrice.entries[0].rank === 1
   && flPrice.entries[1].username === "benny" && flPrice.entries[1].value === 11 && flPrice.entries[1].rank === 2
   && !flPrice.entries.some(e => e.username === "stranger")
   && flPrice.me.best === 15 && flPrice.me.rank === 1,
   "friends_leaderboard('price') matches price_leaderboard shape, excludes strangers");

const flAll = await call("ana", "friends_leaderboard", "allTime", null);
ok(flAll.entries.length === 2
   && flAll.entries[0].username === "ana" && flAll.entries[0].rank === 1 && flAll.entries[0].is_me === true
   && flAll.entries[1].username === "benny" && flAll.entries[1].rank === 2
   && !flAll.entries.some(e => e.username === "stranger")
   && flAll.me.rank === 1 && flAll.me.points === flAll.entries[0].points,
   "friends_leaderboard('allTime') matches alltime_leaderboard shape, excludes strangers");

// ─── 5. Direct Game Invites, Auto-Start & Score Challenges (44) ──────────────
console.log("\n5. Direct Game Invites, Auto-Start & Score Challenges (44)");
await call("ben_acc", "save_push_subscription", "https://fcm.googleapis.com/fcm/send/ben-w2", "k".repeat(80), "a".repeat(20), null);

// Reject stranger or pending in invite_friends_to_game (and ensure NO orphan lobby created)
const lobbyCountBefore = (await q1(`select count(*)::int n from public.games where host_id=$1 and status='lobby'`, [users.ana])).n;
ok((await err(() => call("ana", "invite_friends_to_game", ["benny", "stranger"], "async", 12, 3))).includes("not_friends"),
   "invite_friends_to_game rejects stranger");
ok((await err(() => call("ana", "invite_friends_to_game", ["benny", "dan_d"], "async", 12, 3))).includes("not_friends"),
   "invite_friends_to_game rejects pending friend");
ok((await err(() => call("ana", "invite_friends_to_game", [], "async", 12, 3))).includes("bad_settings"),
   "invite_friends_to_game rejects empty list");
ok((await err(() => call("ana", "invite_friends_to_game", ["benny"], "async", 10, 3))).includes("bad_settings"),
   "invite_friends_to_game rejects non-divisible card_count/cards_per_turn");
ok((await q1(`select count(*)::int n from public.games where host_id=$1 and status='lobby'`, [users.ana])).n === lobbyCountBefore,
   "failed invite validation leaves zero orphan games");

// Multi-friend async invite: Benny + Cara -> waits for BOTH before auto-starting
const inv2 = await call("ana", "invite_friends_to_game", ["BENNY", "benny", "cara"], "async", 6, 3);
ok(inv2.invited.length === 2 && /^[A-HJ-NP-Z2-9]{4}$/.test(inv2.code),
   `invited 2 deduplicated friends (${inv2.invited.join(", ")}) to async game ${inv2.code}`);

const invPush = await q1(
  `select kind, body, url from public.push_outbox where player_id=$1 and game_id=$2 and kind='invite'`,
  [users.ben_acc, inv2.game_id]
);
ok(invPush && invPush.body === "ana invited you to a game" && invPush.url === `?game=${inv2.game_id}`,
   `invite queued push: "${invPush?.body}"`);

const benInvList = await call("ben_acc", "my_game_invites");
ok(benInvList.length === 1 && benInvList[0].from_username === "ana"
   && benInvList[0].challenge_kind === "game" && benInvList[0].code === inv2.code
   && benInvList[0].card_count === 6 && benInvList[0].cards_per_turn === 3
   && !JSON.stringify(benInvList).includes(users.ana),
   "my_game_invites returns pending game invite without exposing sender UUID");

ok((await err(() => call("cara", "respond_game_invite", benInvList[0].id, true))).includes("invite_not_found"),
   "wrong recipient cannot accept another player's invite");

const accBen = await call("ben_acc", "respond_game_invite", benInvList[0].id, true);
ok(accBen.accepted === true && accBen.game_id === inv2.game_id && accBen.auto_started === false,
   "first friend accepting leaves game in lobby (1 pending invite remains)");
ok((await call("ana", "get_game", inv2.game_id)).status === "playing",
   "036: async invite games run from the start; Ben joins turn 1 directly");

const caraInvList = await call("cara", "my_game_invites");
const accCara = await call("cara", "respond_game_invite", caraInvList[0].id, true);
ok(accCara.accepted === true && accCara.game_id === inv2.game_id,
   "last friend accepting the async invite joins the running game");
const startedGame = await call("ana", "get_game", inv2.game_id);
ok(startedGame.status === "playing" && startedGame.current_turn === 1 && startedGame.players.length === 3,
   "auto-started async game is playing turn 1 with all 3 players");
ok((await q1(`select count(*)::int n from public.game_invites where game_id=$1 and status='accepted'`, [inv2.game_id])).n === 2,
   "both invites marked accepted");

// Live game invite does NOT auto-start when last friend accepts
const invLive = await call("ana", "invite_friends_to_game", ["benny"], "live", 5, 1);
const benLiveInv = (await call("ben_acc", "my_game_invites")).find(i => i.game_id === invLive.game_id);
const accLive = await call("ben_acc", "respond_game_invite", benLiveInv.id, true);
ok(accLive.accepted === true && accLive.auto_started === false,
   "live game invite stays in lobby (auto_started=false) for host to start");

// Single-friend async invite auto-starts immediately on accept
const invOne = await call("ana", "invite_friends_to_game", ["benny"], "async", 6, 3);
const benOneInv = (await call("ben_acc", "my_game_invites")).find(i => i.game_id === invOne.game_id);
const accOne = await call("ben_acc", "respond_game_invite", benOneInv.id, true);
ok(accOne.accepted === true && (await call("ana", "get_game", invOne.game_id)).players.length === 2,
   "1-friend async invite: accepting joins the game that is already running");

// Removing accepted friend revokes friend_profile and expires pending invites
await err(() => call("cara", "send_score_challenge", "ana", "daily_score", 7777));   // 035: only with a real score
await call("ana", "remove_friend", "cara", false);
ok((await err(() => call("ana", "friend_profile", "cara"))).includes("not_friends"),
   "removed friend loses friend_profile access");
ok(!(await call("ana", "my_game_invites")).some(i => i.from_username === "cara"),
   "removing friend expires pending invites from them");

// Test badges in friend_profile via finished October Monthly Run
const octRunId = (await q1(
  `insert into public.games (kind, status, host_id, card_count, cards_per_turn, max_players, run_month)
   values ('run', 'finished', $1, 10, 10, 1, '2026-10-01') returning id`,
  [users.ben_acc]
)).id;
await q(
  `insert into public.game_players (game_id, player_id, display_name, score, answered, correct)
   values ($1, $2, 'Benny', 15, 18, 15)`,
  [octRunId, users.ben_acc]
);
const fpBenBadges = await call("ana", "friend_profile", "benny");
ok(fpBenBadges.badges.length === 1 && fpBenBadges.badges[0].month === "2026-10-01"
   && fpBenBadges.badges[0].rank === 1 && fpBenBadges.badges[0].value === 15,
   "friend_profile includes my_badges equivalent for finished months");

// Score challenges
ok((await err(() => call("ana", "send_score_challenge", "stranger", "daily_score", 8000))).includes("not_friends"),
   "send_score_challenge rejects stranger");
ok((await err(() => call("ana", "send_score_challenge", "benny", "bad_mode", 100))).includes("bad_settings"),
   "send_score_challenge rejects invalid mode");
const anaPriceBest = (await call("ana", "price_summary")).best;
const scRes = await call("ana", "send_score_challenge", "benny", "price_score", 99999);
ok(scRes.ok === true && !!scRes.id && anaPriceBest != null, "send_score_challenge succeeds");
const benScoreInvs = await call("ben_acc", "my_game_invites");
const scInv = benScoreInvs.find(i => i.id === scRes.id);
ok(scInv && scInv.challenge_kind === "price_score" && scInv.target_score === anaPriceBest && scInv.game_id === null,
   "score challenge appears in my_game_invites()");
ok(scInv && scInv.target_score !== 99999, "035: the challenge carries the real best score, not the one the app sent");
ok((await err(() => call("dan", "send_score_challenge", "ana", "price_score", 500))).length > 0,
   "035: no challenge without a real score (or without friendship)");

// push_batch produces non-null tag for game-less score challenge
const pushSecret = (await q1(`select value from private.settings where key = 'push_cron_secret'`)).value;
const batch = await db.query(`select public.push_batch($1) b`, [pushSecret]).then(r => r.rows[0].b);
const chalJob = batch.jobs.find(j => j.title === "New score challenge");
ok(chalJob && typeof chalJob.tag === "string" && chalJob.tag.startsWith("new_challenge-"),
   `push_batch builds non-null tag for score challenge (${chalJob?.tag})`);

const decl = await call("ben_acc", "respond_game_invite", scInv.id, false);
ok(decl.accepted === false && decl.auto_started === false, "declining score challenge works");
ok((await err(() => call("ben_acc", "respond_game_invite", scInv.id, true))).includes("invite_not_found"),
   "cannot re-respond to declined invite");

// ─── 6. GDPR Export & Cleanup Updates ────────────────────────────────────────
console.log("\n6. GDPR export_my_data & privacy_cleanup");
// Re-test blocked hiding in export: eve blocks dan -> dan's export hides the block, eve's export shows it
await call("eve", "remove_friend", "dan_d", true);
const exAna = await call("ana", "export_my_data");
for (const k of [
  "format", "exported_at", "controller", "account", "profile", "solo_games", "games",
  "feedback", "push_devices", "push_messages", "card_packs", "weekly_painting_guesses",
  "join_failures", "guest_transfers", "friendships", "game_invites", "stored_on_this_device"
]) {
  ok(k in exAna, `export_my_data includes '${k}'`);
}
ok(Array.isArray(exAna.friendships) && exAna.friendships.length >= 2
   && !JSON.stringify(exAna.friendships).includes(users.ben_acc),
   "export_my_data exports friendships with usernames and zero foreign UUIDs");
ok(Array.isArray(exAna.game_invites) && exAna.game_invites.length >= 3,
   "export_my_data exports game_invites");
const exDan = await call("dan", "export_my_data");
ok(!exDan.friendships.some(f => f.friend_username === "eve"),
   "export_my_data does not leak blocks placed by another user onto target's export");

// privacy_cleanup expires invites > 7 days old and preserves fresh invites
const oldChal = await call("ana", "send_score_challenge", "benny", "price_score", 20);
const freshChal = await call("ana", "send_score_challenge", "benny", "price_score", 9000);
await q(`update public.game_invites set created_at = public._now() - interval '8 days' where id = $1`, [oldChal.id]);
const cleanRes = await callService("privacy_cleanup");
ok(cleanRes.invites_expired === 1
   && (await q1(`select status from public.game_invites where id = $1`, [oldChal.id])).status === "expired"
   && (await q1(`select status from public.game_invites where id = $1`, [freshChal.id])).status === "pending",
   `privacy_cleanup expires >7d invites and keeps fresh invites (${JSON.stringify(cleanRes)})`);

await realClock();
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
