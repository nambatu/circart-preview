// 031: Wave 1 features — Price Mode, Grace Streak + Painting of the Week,
// Compact Play History, 24-month Account Expiry + Export/Transfer, All Remaining Badges.
// Usage: node wave1.test.mjs <migrations dir> <deck.sql>
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
    `select c.year, _years_before($1,$2) ys from game_cards gc join cards c on c.id=gc.card_id
      where gc.game_id=$1 and gc.position=$2`,
    [game, pos]
  );
  return { slot: r.ys.filter(y => y < r.year).length, n: r.ys.length };
}

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

async function playRun(who, { wrongAt = [1, 2, 3], secs = 3, max = 100 } = {}) {
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

const deckRows = await q(`select id, source_id from cards where active order by source_id limit 20`);
const deckSrc = deckRows.map(r => r.source_id);
const deckIds = deckRows.map(r => r.id);

async function submitSolo(who, { mode = "classic", rounds = 5, correct = 5, bonus = 0, streak = 5, finishedAt } = {}) {
  const cards = [{ id: deckSrc[0] }];
  for (let i = 0; i < rounds; i++) {
    cards.push({ id: deckSrc[(i % (deckSrc.length - 1)) + 1], correct: i < correct });
  }
  return call(who, "submit_solo_game", {
    client_id: crypto.randomUUID(),
    mode,
    score: correct + bonus,
    bonus_points: bonus,
    best_streak: Math.min(streak, rounds),
    finished_at: finishedAt || new Date(clock).toISOString(),
    cards
  });
}

// ─── 1. Permissions, RLS & search_path ──────────────────────────────────────
console.log("1. Permissions, RLS & search_path");
await signUp("sec", false, "sec@example.org");
await setClock("2026-11-16T12:00:00+01:00");

ok((await err(() => as("sec", "select * from public.weekly_paintings"))).includes("permission denied"),
   "weekly_paintings unreadable by authenticated");
ok((await err(() => as("sec", "select * from public.weekly_painting_guesses"))).includes("permission denied"),
   "weekly_painting_guesses unreadable by authenticated");
ok((await err(() => as(null, "select * from public.weekly_paintings", [], "anon"))).includes("permission denied"),
   "weekly_paintings unreadable by anon");

for (const fn of [
  ["price_summary", []],
  ["price_leaderboard", []],
  ["my_streak", []],
  ["my_painting", [null]],
  ["guess_painting", ["Test"]],
  ["my_restorations", []],
  ["my_history", [null, 10, 0]],
  ["export_my_data", []],
  ["my_achievements", []],
  ["inactive_accounts_to_warn", ["23 months"]],
  ["mark_expiry_warned", [[]]],
  ["privacy_cleanup", []],
  ["mark_bug_reporter", [1, true]]
]) {
  ok((await err(() => callAnon(fn[0], ...fn[1]))).includes("permission denied"),
     `anon denied ${fn[0]}()`);
}

for (const fn of [
  ["_grace_streak", [users.sec]],
  ["_price_best", []],
  ["_price_ranked", []],
  ["inactive_accounts_to_warn", ["23 months"]],
  ["mark_expiry_warned", [[]]],
  ["privacy_cleanup", []],
  ["mark_bug_reporter", [1, true]]
]) {
  ok((await err(() => call("sec", fn[0], ...fn[1]))).includes("permission denied"),
     `authenticated denied ${fn[0]}()`);
}

const secFns = [
  "_price_best", "_price_ranked", "price_summary", "price_leaderboard",
  "_grace_streak", "my_streak", "_painting_artist_options", "my_painting",
  "guess_painting", "my_restorations", "my_history",
  "_clear_expiry_warn", "_clear_expiry_warn_on_seen",
  "inactive_accounts_to_warn", "mark_expiry_warned", "privacy_cleanup",
  "finish_guest_transfer", "export_my_data", "mark_bug_reporter", "my_achievements"
];
const cfg = await q(
  `select proname, prosecdef, proconfig from pg_proc
    where pronamespace = 'public'::regnamespace and proname = any($1)`,
  [secFns]
);
ok(cfg.length === secFns.length && cfg.every(r => r.prosecdef && (r.proconfig || []).some(s => s.startsWith("search_path="))),
   `all ${secFns.length} Wave 1 functions are SECURITY DEFINER with fixed search_path`);

// ─── 2. Price Mode (46) ─────────────────────────────────────────────────────
console.log("\n2. Price Mode (46)");
await signUp("p_ana", false, "pana@example.org");
await signUp("p_ben", false, "pben@example.org");
await signUp("p_cy", false, "pcy@example.org");
await signUp("p_zero", false, "pzero@example.org");
await signUp("p_nohandle", false, "pno@example.org");
await signUp("p_gus", true);
await call("p_ana", "update_profile", null, "p_ana");
await call("p_ben", "update_profile", null, "p_benny");
await call("p_cy", "update_profile", null, "p_cy");
await call("p_zero", "update_profile", null, "p_zero");

let ps = await call("p_ana", "price_summary");
ok(ps.best === null && ps.runs === 0 && ps.rank === null && ps.players === 0 && ps.above === null && !!ps.server_now,
   "empty price_summary shape correct");
let plb = await call("p_ana", "price_leaderboard");
ok(plb.metric === "price_best" && plb.players === 0 && plb.entries.length === 0 && plb.me === null,
   "empty price_leaderboard shape correct");

await submitSolo("p_ana", { mode: "classic", rounds: 10, correct: 10, streak: 10 });
await submitSolo("p_ana", { mode: "price", rounds: 12, correct: 10, streak: 10 });
await submitSolo("p_ben", { mode: "price", rounds: 20, correct: 18, streak: 18 });
await submitSolo("p_ben", { mode: "price", rounds: 15, correct: 12, streak: 12 });
await submitSolo("p_cy", { mode: "price", rounds: 20, correct: 18, streak: 18 });
await submitSolo("p_zero", { mode: "price", rounds: 5, correct: 0, streak: 0 });
await submitSolo("p_nohandle", { mode: "price", rounds: 20, correct: 20, streak: 20 });
await submitSolo("p_gus", { mode: "price", rounds: 25, correct: 25, streak: 25 });

ps = await call("p_ana", "price_summary");
ok(ps.best === 10 && ps.runs === 1 && ps.rank === 3 && ps.players === 3
   && ps.above && ps.above.username === "p_benny" && ps.above.value === 18,
   `ana price_summary: best=10, rank=3/3, above=p_benny(18)`);

const psBen = await call("p_ben", "price_summary");
ok(psBen.best === 18 && psBen.runs === 2 && psBen.rank === 1 && psBen.above === null,
   "ben price_summary: best across 2 runs, rank 1 tie, above=null");

plb = await call("p_ana", "price_leaderboard");
ok(plb.metric === "price_best" && plb.players === 3 && plb.entries.length === 3
   && plb.entries[0].rank === 1 && plb.entries[1].rank === 1 && plb.entries[2].rank === 3 && plb.entries[2].is_me
   && plb.me.rank === 3 && plb.me.value === 10 && plb.me.best === 10 && plb.me.runs === 1 && plb.me.ranked === true,
   "price_leaderboard ranks non-guest username accounts with best > 0, ties share rank 1");

const plbGus = await call("p_gus", "price_leaderboard");
ok(!plbGus.entries.some(e => e.is_me) && plbGus.me && plbGus.me.rank === null && plbGus.me.best === 25 && plbGus.me.ranked === false,
   "guest excluded from price_leaderboard entries, sees own me");

const plbZero = await call("p_zero", "price_leaderboard");
ok(plbZero.me && plbZero.me.best === 0 && plbZero.me.rank === null && plbZero.me.ranked === false,
   "score 0 not ranked on price_leaderboard");

const plbNoH = await call("p_nohandle", "price_leaderboard");
ok(plbNoH.me && plbNoH.me.best === 20 && plbNoH.me.rank === null && plbNoH.me.ranked === false,
   "account without username not ranked on price_leaderboard");

// ─── 3. Grace Daily Streak (45) ─────────────────────────────────────────────
console.log("\n3. Grace Daily Streak (45)");
await signUp("st_a", false, "sta@example.org");
let ms = await call("st_a", "my_streak");
ok(ms.streak === 0 && ms.longest === 0 && ms.free_day_used === false && ms.played_today === false && ms.week_days.length === 7,
   "fresh player my_streak is zeroed with 7 week_days");

// Partial daily (5/10) on Sun 11-01 does NOT count for grace streak
await setClock("2026-11-01T10:00:00+01:00"); // Sun
await playDaily("st_a", { cards: 5 });
ms = await call("st_a", "my_streak");
ok(ms.streak === 0 && ms.played_today === false, "partial daily (< card_count) does not count for grace streak");

// Complete Mon..Wed (2026-11-02..04)
for (const d of ["2026-11-02", "2026-11-03", "2026-11-04"]) {
  await setClock(`${d}T10:00:00+01:00`);
  await playDaily("st_a", { cards: 10, wrong: d === "2026-11-02" ? [1] : [] });
}
ms = await call("st_a", "my_streak");
ok(ms.streak === 3 && ms.longest === 3 && ms.free_day_used === false && ms.played_today === true,
   "Mon-Wed played: streak=3, free_day_used=false");
ok(ms.week_days[0].played === true && ms.week_days[0].perfect === false
   && ms.week_days[1].played === true && ms.week_days[1].perfect === true,
   "week_days differentiates played vs perfect");

// Skip Thu 11-05; check Fri 11-06 BEFORE playing Fri
await setClock("2026-11-06T09:00:00+01:00");
ms = await call("st_a", "my_streak");
ok(ms.streak === 3 && ms.free_day_used === true && ms.played_today === false,
   "after missing Thu, on Fri before playing: streak survives (3), free_day_used=true, played_today=false");
ok((await call("st_a", "daily_summary")).streak === 0,
   "classic _daily_streak (daily_summary) stays strict (0 after missing Thu)");

// Play Fri..Sun (11-06..08)
for (const d of ["2026-11-06", "2026-11-07", "2026-11-08"]) {
  await setClock(`${d}T10:00:00+01:00`);
  await playDaily("st_a", { cards: 10 });
}
ms = await call("st_a", "my_streak");
ok(ms.streak === 6 && ms.longest === 6 && ms.free_day_used === true && ms.played_today === true,
   "Sun 11-08: streak=6 (missed Thu counted 0 but kept chain alive)");

// New ISO week Mon 11-09 BEFORE playing Mon
await setClock("2026-11-09T09:00:00+01:00");
ms = await call("st_a", "my_streak");
ok(ms.streak === 6 && ms.free_day_used === false && ms.played_today === false,
   "new ISO week Mon before playing: free_day_used=false, missing today has not consumed free day");

// Skip Mon 11-09, play Tue 11-10 -> streak=7, free_day_used=true
await setClock("2026-11-10T10:00:00+01:00");
await playDaily("st_a", { cards: 10 });
ms = await call("st_a", "my_streak");
ok(ms.streak === 7 && ms.longest === 7 && ms.free_day_used === true && ms.played_today === true,
   "skipped Mon, played Tue: streak=7, free_day_used=true");

// Skip Wed 11-11 (2nd miss in week 11-09); on Thu 11-12 before playing:
// the 7-day chain breaks at Mon (dropping back to Tue=1 with Wed using free day)
await setClock("2026-11-12T09:00:00+01:00");
ms = await call("st_a", "my_streak");
ok(ms.streak === 1 && ms.longest === 7 && ms.free_day_used === true && ms.played_today === false,
   "2nd miss in same ISO week breaks earlier chain across Mon (drops 7->1, Wed consumes free day)");

// Also skip Thu 11-12; on Fri 11-13 before playing -> 2 misses after Tue breaks completely to 0!
await setClock("2026-11-13T09:00:00+01:00");
ms = await call("st_a", "my_streak");
ok(ms.streak === 0 && ms.longest === 7 && ms.free_day_used === false && ms.played_today === false,
   "skipping Wed and Thu breaks grace streak completely (streak=0, longest=7, free_day_used=false)");

// Play Fri 11-13 -> new streak=1, free_day_used=false
await playDaily("st_a", { cards: 10 });
ms = await call("st_a", "my_streak");
ok(ms.streak === 1 && ms.longest === 7 && ms.free_day_used === false && ms.played_today === true,
   "restarting after break on Fri: streak=1, free_day_used=false");

// Test sliding window when Tue+Thu played despite Mon+Wed missed -> streak=2, free_day_used=true
await signUp("st_c", false, "stc@example.org");
for (const d of ["2026-11-08", "2026-11-10", "2026-11-12"]) {
  await setClock(`${d}T10:00:00+01:00`);
  await playDaily("st_c", { cards: 10 });
}
ms = await call("st_c", "my_streak");
ok(ms.streak === 2 && ms.free_day_used === true,
   `Tue + (skip Wed) + Thu keeps streak=2 with free_day_used=true (got ${ms.streak})`);

// Test tricky longest across 2 misses in same week: Mon, [skip Tue], Wed, [skip Thu], Fri, Sat, Sun -> longest = 4
await signUp("st_b", false, "stb@example.org");
for (const d of ["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-07", "2026-11-08"]) {
  await setClock(`${d}T10:00:00+01:00`);
  await playDaily("st_b", { cards: 10 });
}
ms = await call("st_b", "my_streak");
ok(ms.longest === 4 && ms.streak === 4,
   `intra-week sliding window longest: Wed + (skip Thu) + Fri..Sun = 4 (got ${ms.longest})`);

// Test across month boundary (Nov 30 Mon -> Dec 2 Wed, skipping Dec 1 Tue)
await signUp("st_m", false, "stm@example.org");
await setClock("2026-11-30T10:00:00+01:00");
await playDaily("st_m", { cards: 10 });
await setClock("2026-12-02T10:00:00+01:00");
await playDaily("st_m", { cards: 10 });
ms = await call("st_m", "my_streak");
ok(ms.streak === 2 && ms.free_day_used === true, "grace streak continues across Nov->Dec month boundary");

// ─── 4. Painting of the Week (45) ───────────────────────────────────────────
console.log("\n4. Painting of the Week (45)");
await signUp("pt_ana", false, "ptana@example.org");
await signUp("pt_bob", false, "ptbob@example.org");
await setClock("2026-11-16T10:00:00+01:00"); // Mon

ok((await call("pt_ana", "my_painting", null)) === null, "no painting for week returns null");
ok((await err(() => call("pt_ana", "guess_painting", "Anyone"))).includes("no_painting"), "guess without painting rejected");

// Insert 3 inactive painting cards + 3 weekly_paintings (past 11-09, current 11-16, future 11-23)
await db.exec(`
  insert into public.cards (id, source_id, title, artist, year, tier, active, image_url) values
    ('wpc_past', 'wp-past', 'Past Work', 'Johannes Vermeer', 1665, 1, false, 'art/past.jpg'),
    ('wpc_curr', 'wp-curr', 'Current Work', 'Rembrandt van Rijn', 1642, 1, false, 'art/curr.jpg'),
    ('wpc_next', 'wp-next', 'Future Work', 'Claude Monet', 1872, 1, false, 'art/next.jpg');

  insert into public.weekly_paintings (week_start, card_id, varnish_url, patch_urls, artist_options, story, story_de) values
    ('2026-11-09', 'wpc_past', 'art/v-past.jpg',
     array['p1.jpg','p2.jpg','p3.jpg','p4.jpg','p5.jpg','p6.jpg','p7.jpg'],
     array['Johannes Vermeer','Rembrandt van Rijn','Frans Hals','Jan Steen'],
     'Past story EN', 'Past story DE'),
    ('2026-11-16', 'wpc_curr', 'art/v-curr.jpg',
     array['c1.jpg','c2.jpg','c3.jpg','c4.jpg','c5.jpg','c6.jpg','c7.jpg'],
     '{}',
     'Current story EN', 'Current story DE'),
    ('2026-11-23', 'wpc_next', 'art/v-next.jpg',
     array['n1.jpg','n2.jpg','n3.jpg','n4.jpg','n5.jpg','n6.jpg','n7.jpg'],
     array['Claude Monet','Pierre-Auguste Renoir','Edgar Degas','Édouard Manet'],
     'Future story EN', 'Future story DE');
`);

// Future week peeking blocked
ok((await call("pt_ana", "my_painting", "2026-11-23")) === null, "cannot peek at future week painting");

// Before playing Monday
let mp = await call("pt_ana", "my_painting", null);
ok(mp.week_start === "2026-11-16" && mp.varnish_url === "art/v-curr.jpg"
   && mp.earned_count === 0 && mp.today_index === 0 && mp.played_today === false
   && mp.can_guess === false && mp.artist_options.length === 0 && mp.revealed === null
   && mp.days.every(d => !d.earned && d.patch_url === null),
   "day 0 before playing: 0 patches, all patch_url null, no artist_options, no revealed");

// Play Mon (wrong on card 1 -> not perfect) & Tue (perfect)
await playDaily("pt_ana", { cards: 10, wrong: [1] });
await setClock("2026-11-17T10:00:00+01:00");
await playDaily("pt_ana", { cards: 10 });
mp = await call("pt_ana", "my_painting", null);
ok(mp.earned_count === 2 && mp.today_index === 1 && mp.played_today === true
   && mp.days[0].earned && !mp.days[0].perfect && mp.days[0].patch_url === "c1.jpg"
   && mp.days[1].earned && mp.days[1].perfect && mp.days[1].patch_url === "c2.jpg"
   && mp.days.slice(2).every(d => !d.earned && d.patch_url === null)
   && mp.artist_options.length === 0 && mp.can_guess === false,
   "after Mon+Tue: 2 patches returned, unplayed days have patch_url=null, artist_options hidden before day 3");
ok((await err(() => call("pt_ana", "guess_painting", "Rembrandt van Rijn"))).includes("not_enough_patches"),
   "guess rejected before 3 patches earned");

// Play Wed 11-18 -> 3 patches earned, deterministic 4 artist options revealed
await setClock("2026-11-18T10:00:00+01:00");
await playDaily("pt_ana", { cards: 10 });
mp = await call("pt_ana", "my_painting", null);
const mp2 = await call("pt_ana", "my_painting", null);
ok(mp.earned_count === 3 && mp.can_guess === true && mp.artist_options.length === 4
   && mp.artist_options.includes("Rembrandt van Rijn")
   && JSON.stringify(mp.artist_options) === JSON.stringify(mp2.artist_options),
   `day 3: 4 deterministic artist_options incl. Rembrandt van Rijn (${mp.artist_options.join(", ")})`);

ok((await err(() => call("pt_ana", "guess_painting", "Not In List"))).includes("bad_choice"),
   "invalid artist choice rejected");

const wrongOpt = mp.artist_options.find(a => a !== "Rembrandt van Rijn");
const gWrong = await call("pt_ana", "guess_painting", wrongOpt);
ok(gWrong.correct === false && gWrong.choice === wrongOpt && gWrong.day_index === 3 && !("artist" in gWrong),
   "wrong guess returns correct=false without leaking real artist");
ok((await err(() => call("pt_ana", "guess_painting", "Rembrandt van Rijn"))).includes("already_guessed"),
   "second guess on same day raises already_guessed");
mp = await call("pt_ana", "my_painting", null);
ok(mp.can_guess === false && mp.guessed_right === false && mp.guesses.length === 1,
   "can_guess false for rest of day after guessing");

// Play Thu 11-19 -> 4th patch, guess right!
await setClock("2026-11-19T10:00:00+01:00");
await playDaily("pt_ana", { cards: 10 });
mp = await call("pt_ana", "my_painting", null);
ok(mp.can_guess === true && mp.earned_count === 4, "next day can_guess=true again");
const gRight = await call("pt_ana", "guess_painting", "Rembrandt van Rijn");
ok(gRight.correct === true && gRight.day_index === 4, "right guess on day_index 4");
mp = await call("pt_ana", "my_painting", null);
ok(mp.guessed_right === true && mp.can_guess === false && mp.guesses.length === 2,
   "after right guess: guessed_right=true, can_guess=false");

// Friday: still cannot guess again once guessed_right
await setClock("2026-11-20T10:00:00+01:00");
await playDaily("pt_ana", { cards: 10 });
ok((await err(() => call("pt_ana", "guess_painting", "Rembrandt van Rijn"))).includes("already_guessed"),
   "cannot guess again after already guessing right");

// Sunday before Sunday daily: NOT revealed yet, NOT in my_restorations
await setClock("2026-11-22T10:00:00+01:00");
mp = await call("pt_ana", "my_painting", null);
ok(mp.revealed === null && (await call("pt_ana", "my_restorations")).length === 0,
   "Sunday before Sunday daily: painting not yet revealed or in restorations");

// Finish Sunday daily -> revealed & added to my_restorations!
await playDaily("pt_ana", { cards: 10 });
mp = await call("pt_ana", "my_painting", null);
ok(mp.revealed && mp.revealed.title === "Current Work" && mp.revealed.artist === "Rembrandt van Rijn"
   && mp.revealed.year === 1642 && mp.revealed.image_url === "art/curr.jpg"
   && mp.revealed.story === "Current story EN" && mp.revealed.story_de === "Current story DE",
   "after Sunday daily: painting revealed with title, artist, year, image_url, EN/DE story");

// Check past week rules: bob played 0 days in 2026-11-09 -> NOT revealed!
const bobPast = await call("pt_bob", "my_painting", "2026-11-09");
ok(bobPast.revealed === null && bobPast.artist_options.length === 0 && bobPast.days.every(d => d.patch_url === null),
   "past week with 0 earned patches stays unrevealed (no spoiler)");

// Play 1 day in past week for st_a (st_a played 2026-11-10..12 in 11-09 week, missed Sunday 11-15!)
const staPast = await call("st_a", "my_painting", "2026-11-09");
const staRest = await call("st_a", "my_restorations");
ok(staPast.revealed && staPast.days[6].earned === false && staPast.days[6].patch_url === null
   && staRest.length === 1 && staRest[0].week_start === "2026-11-09" && staRest[0].days[6].patch_url === null,
   "past week with >0 earned patches (missed Sunday) revealed in my_restorations, missed patch stays null");

// Future daily row in DB must NOT leak into current week my_painting (even if game row exists for Wed while clock is Mon)
await signUp("pt_peek", false, "ptpeek@example.org");
await setClock("2026-11-25T10:00:00+01:00");
await playDaily("pt_peek", { cards: 10 });
await setClock("2026-11-23T10:00:00+01:00"); // roll back to Monday of 11-23 week
const peekMp = await call("pt_peek", "my_painting", null);
ok(peekMp.earned_count === 0 && peekMp.days.every(d => !d.earned && d.patch_url === null),
   "future daily game row does not unlock future patch_url before that date");

// Play Sunday of 11-23 week for pt_ana -> verify my_restorations orders week_start desc (11-23 before 11-16)
await setClock("2026-11-29T10:00:00+01:00");
await playDaily("pt_ana", { cards: 10 });
const anaRest = await call("pt_ana", "my_restorations");
ok(anaRest.length === 2 && anaRest[0].week_start === "2026-11-23" && anaRest[1].week_start === "2026-11-16",
   "my_restorations returns unlocked paintings ordered by week_start desc");

// ─── 5. Compact Play History (34) ───────────────────────────────────────────
console.log("\n5. Compact Play History (34)");
await signUp("hi_ana", false, "hiana@example.org");
await signUp("hi_ben", false, "hiben@example.org");
await call("hi_ana", "update_profile", "HiAna", "hiana");
await call("hi_ben", "update_profile", "HiBen", "hiben");

// 1) Story daily on 2026-10-05
await db.exec(`
  insert into public.daily_themes (day, slug, title, title_de, intro, outro)
  values ('2026-10-05', 'oct-story', 'Autumn Gallery', 'Herbstgalerie', 'Intro', 'Outro');
  insert into public.daily_theme_cards (day, position, card_id, chapter) values
    ('2026-10-05', 0, '${deckIds[0]}', null),
    ('2026-10-05', 1, '${deckIds[1]}', 'ch1'),
    ('2026-10-05', 2, '${deckIds[2]}', 'ch2'),
    ('2026-10-05', 3, '${deckIds[3]}', 'ch3');
`);
await setClock("2026-10-05T11:00:00+02:00");
await playDaily("hi_ana", { cards: 3 });

// 2) Classic solo game at T+1h
await setClock("2026-10-05T12:00:00+02:00");
await submitSolo("hi_ana", { mode: "classic", rounds: 5, correct: 4 });

// 3) Finished friends game (live, 3 cards) at T+2h
await setClock("2026-10-05T13:00:00+02:00");
const fg = await call("hi_ana", "create_game", "live", 3, null, "HiAna");
await call("hi_ben", "join_game", fg.code, "HiBen");
await call("hi_ana", "start_game", fg.id);
for (let pos = 1; pos <= 3; pos++) {
  const rs = await rightSlot(fg.id, pos);
  await call("hi_ana", "next_card", fg.id);
  await call("hi_ben", "next_card", fg.id);
  await advance(2);
  await call("hi_ana", "answer", fg.id, pos, rs.slot);
  await call("hi_ben", "answer", fg.id, pos, rs.slot === 0 ? rs.n : 0);
  await call("hi_ana", "pick_bonus", fg.id, pos, null, null);
  await call("hi_ben", "pick_bonus", fg.id, pos, null, null);
  await advance(9);
  await call("hi_ana", "get_game", fg.id);
}
// Plus an unfinished lobby (must NOT appear in friends history)
await call("hi_ana", "create_game", "async", 6, 3, "HiAna");

// 4) Run game at T+3h
await setClock("2026-10-05T14:00:00+02:00");
await playRun("hi_ana", { wrongAt: [2, 3, 4] }); // 4 cards answered

// 5) Price solo game at T+4h
await setClock("2026-10-05T15:00:00+02:00");
await submitSolo("hi_ana", { mode: "price", rounds: 8, correct: 7 });

// 6) Pack solo game at T+5h
await setClock("2026-10-05T16:00:00+02:00");
await submitSolo("hi_ana", { mode: "baroque-masters", rounds: 6, correct: 6 });

const histAll = await call("hi_ana", "my_history", null, 30, 0);
ok(histAll.items.length === 6 && histAll.has_more === false, `my_history('all'): 6 items, has_more=false (got ${histAll.items.length})`);
ok(histAll.items.map(i => i.kind).join(",") === "solo,price,run,friends,solo,daily",
   `ordered played_at desc: ${histAll.items.map(i => i.kind).join(",")}`);
const hDaily = histAll.items[5];
ok(hDaily.title === "Autumn Gallery" && hDaily.title_de === "Herbstgalerie" && hDaily.challenge_no >= 1 && hDaily.total === 3,
   "daily history carries theme title, title_de, challenge_no, total");
const hRun = histAll.items[2];
ok(hRun.run_month === "2026-10-01" && hRun.total === 4 && hRun.correct === 1,
   "run history carries run_month and total=answered (4)");
const hFriend = histAll.items[3];
ok(hFriend.mode === "live" && hFriend.rank === 1 && hFriend.players === 2 && hFriend.status === "finished" && hFriend.title === "HiBen",
   "friends history carries mode, rank, players, status, opponent name");
const hPack = histAll.items[0];
ok(hPack.mode === "baroque-masters" && hPack.title === "Baroque Masters" && hPack.title_de === "Meister des Barock",
   "pack solo history carries pack title and title_de");

for (const [k, exp] of [["daily", 1], ["run", 1], ["price", 1], ["friends", 1], ["solo", 2]]) {
  const hk = await call("hi_ana", "my_history", k, 30, 0);
  ok(hk.items.length === exp && hk.items.every(i => i.kind === k), `filter '${k}' returns ${exp}`);
}
ok((await err(() => call("hi_ana", "my_history", "bogus", 10, 0))).includes("bad_settings"),
   "invalid p_kind raises bad_settings");

const p1 = await call("hi_ana", "my_history", "all", 2, 0);
const p2 = await call("hi_ana", "my_history", "all", 2, 2);
const p3 = await call("hi_ana", "my_history", "all", 2, 4);
ok(p1.items.length === 2 && p1.has_more === true
   && p2.items.length === 2 && p2.has_more === true
   && p3.items.length === 2 && p3.has_more === false,
   "pagination has_more works across pages");

const emptyHist = await call("pt_bob", "my_history", "all", 999, -5);
ok(emptyHist.items.length === 0 && emptyHist.has_more === false, "empty my_history & clamped limit/offset work");
const clampMin = await call("hi_ana", "my_history", "all", 0, 0);
ok(clampMin.items.length === 1 && clampMin.has_more === true, "p_limit <= 0 clamped to 1");

// ─── 6. Privacy 56b: Expiry Warning, Cleanup, Export & Guest Transfer ───────
console.log("\n6. Privacy 56b");
await realClock();
await setClock("2026-11-20T12:00:00+01:00");

await signUp("exp_warn_target", false, "warn@example.org");
await signUp("exp_no_email", false, null);
await signUp("exp_fresh", false, "fresh@example.org");
await signUp("exp_guest", true, null);
await signUp("exp_unwarned_25m", false, "unwarned@example.org");
await signUp("exp_warned_recent", false, "recent@example.org");
await signUp("exp_warned_delete", false, "delete@example.org");
await signUp("exp_returning", false, "return@example.org");

await q(`update public.profiles set last_seen_at = $1, created_at = $1 where id = $2`,
        [new Date(clock - 23.5 * 30 * 86400e3).toISOString(), users.exp_warn_target]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1 where id = $2`,
        [new Date(clock - 23.5 * 30 * 86400e3).toISOString(), users.exp_no_email]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1 where id = $2`,
        [new Date(clock - 1 * 30 * 86400e3).toISOString(), users.exp_fresh]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1 where id = $2`,
        [new Date(clock - 23.5 * 30 * 86400e3).toISOString(), users.exp_guest]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1 where id = $2`,
        [new Date(clock - 25 * 30 * 86400e3).toISOString(), users.exp_unwarned_25m]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1, expiry_warned_at = $2 where id = $3`,
        [new Date(clock - 25 * 30 * 86400e3).toISOString(), new Date(clock - 10 * 86400e3).toISOString(), users.exp_warned_recent]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1, expiry_warned_at = $2 where id = $3`,
        [new Date(clock - 25 * 30 * 86400e3).toISOString(), new Date(clock - 35 * 86400e3).toISOString(), users.exp_warned_delete]);
await q(`update public.profiles set last_seen_at = $1, created_at = $1, expiry_warned_at = $2 where id = $3`,
        [new Date(clock - 25 * 30 * 86400e3).toISOString(), new Date(clock - 40 * 86400e3).toISOString(), users.exp_returning]);

const toWarn = await asService(`select * from public.inactive_accounts_to_warn('23 months')`);
const warnIds = toWarn.map(r => r.player_id);
ok(warnIds.includes(users.exp_warn_target) && warnIds.includes(users.exp_unwarned_25m)
   && !warnIds.includes(users.exp_no_email) && !warnIds.includes(users.exp_fresh)
   && !warnIds.includes(users.exp_guest) && !warnIds.includes(users.exp_warned_recent),
   "inactive_accounts_to_warn selects only unwarned non-guest accounts with email idle >= 23m");

const marked = await callService("mark_expiry_warned", [users.exp_warn_target]);
ok(marked === 1, "mark_expiry_warned returns count updated");
const toWarnAfter = await asService(`select * from public.inactive_accounts_to_warn('23 months')`);
ok(!toWarnAfter.some(r => r.player_id === users.exp_warn_target),
   "marked account no longer returned by inactive_accounts_to_warn");

// Returning player activity clears expiry_warned_at!
await submitSolo("exp_returning", { rounds: 2, correct: 1 });
ok((await q1(`select expiry_warned_at from public.profiles where id = $1`, [users.exp_returning])).expiry_warned_at === null,
   "solo game activity clears expiry_warned_at");

// Also test get_my_profile clears expiry_warned_at
await q(`update public.profiles set expiry_warned_at = $1 where id = $2`,
        [new Date(clock - 40 * 86400e3).toISOString(), users.exp_returning]);
await call("exp_returning", "get_my_profile");
ok((await q1(`select expiry_warned_at from public.profiles where id = $1`, [users.exp_returning])).expiry_warned_at === null,
   "get_my_profile activity clears expiry_warned_at");

const cleanRes = await callService("privacy_cleanup");
ok(cleanRes.accounts_deleted === 1 && cleanRes.guests_deleted === 1,
   `privacy_cleanup deleted 1 expired non-guest and 1 idle guest (${JSON.stringify(cleanRes)})`);
ok((await q1(`select count(*)::int n from auth.users where id = $1`, [users.exp_warned_delete])).n === 0
   && (await q1(`select count(*)::int n from auth.users where id = $1`, [users.exp_warned_recent])).n === 1
   && (await q1(`select count(*)::int n from auth.users where id = $1`, [users.exp_unwarned_25m])).n === 1
   && (await q1(`select count(*)::int n from auth.users where id = $1`, [users.exp_returning])).n === 1,
   "only >=24m idle AND warned >30d ago without subsequent activity is deleted");

// Guest transfer + export_my_data with weekly_painting_guesses
await signUp("gt_acct", false, "gt@example.org");
await signUp("gt_guest", true, null);
await db.query(
  `insert into public.weekly_painting_guesses (player_id, week_start, guessed_on, day_index, choice, correct) values
    ($1, '2026-11-16', '2026-11-18', 3, 'Rembrandt van Rijn', true),
    ($1, '2026-11-16', '2026-11-19', 4, 'Frans Hals', false),
    ($2, '2026-11-16', '2026-11-19', 4, 'Johannes Vermeer', true)`,
  [users.gt_guest, users.gt_acct]
);
const gtTok = await call("gt_guest", "start_guest_transfer");
const gtRes = await call("gt_acct", "finish_guest_transfer", gtTok);
ok(gtRes.moved === true, "guest transfer succeeded");
const acctGuesses = await q(
  `select guessed_on::text d, choice, correct from public.weekly_painting_guesses where player_id = $1 order by guessed_on`,
  [users.gt_acct]
);
ok(acctGuesses.length === 2
   && acctGuesses[0].d === "2026-11-18" && acctGuesses[0].choice === "Rembrandt van Rijn"
   && acctGuesses[1].d === "2026-11-19" && acctGuesses[1].choice === "Johannes Vermeer",
   "weekly_painting_guesses transferred without overwriting target's same-day guess");

const exp = await call("gt_acct", "export_my_data");
for (const k of [
  "format", "exported_at", "controller", "account", "profile", "solo_games", "games",
  "feedback", "push_devices", "push_messages", "card_packs", "weekly_painting_guesses",
  "join_failures", "guest_transfers", "stored_on_this_device"
]) {
  ok(k in exp, `export_my_data preserves/includes key '${k}'`);
}
ok(Array.isArray(exp.weekly_painting_guesses) && exp.weekly_painting_guesses.length === 2
   && exp.weekly_painting_guesses[0].week_start === "2026-11-16"
   && exp.weekly_painting_guesses[0].day_index === 3
   && exp.weekly_painting_guesses[0].choice === "Rembrandt van Rijn"
   && exp.weekly_painting_guesses[0].correct === true,
   "export_my_data includes weekly_painting_guesses details");

// ─── 7. All Remaining Badges (40) ───────────────────────────────────────────
console.log("\n7. All Remaining Badges (40)");
await signUp("bd_hero", false, "hero@example.org");
await signUp("bd_rival", false, "rival@example.org");
await signUp("bd_guest", true);
await signUp("bd_future", false, "future@example.org");

ok((await call("bd_hero", "my_achievements")).length === 0, "new user starts with 0 badges");

// Guest gets no vernissage_guest even with a solo game
await submitSolo("bd_guest", { mode: "price", rounds: 15, correct: 15 });
const guestAch = (await call("bd_guest", "my_achievements")).map(x => x.key);
ok(!guestAch.includes("vernissage_guest") && guestAch.includes("going_going_gone"),
   "guest does not get vernissage_guest, does get going_going_gone");

// Account created >= 2027-01-01 gets no vernissage_guest
await q(`update public.profiles set created_at = '2027-01-01T00:00:00Z' where id = $1`, [users.bd_future]);
await submitSolo("bd_future", { mode: "price", rounds: 14, correct: 14 });
const futAch = (await call("bd_future", "my_achievements")).map(x => x.key);
ok(!futAch.includes("vernissage_guest") && !futAch.includes("going_going_gone"),
   "post-2026 account does not get vernissage_guest; price score 14 does not get going_going_gone");

// Hero earns EVERY badge!
// a) daily_streak (7 via grace streak with 1 missed day), perfect_daily, storyteller (Oct finished month)
await db.exec(`
  insert into public.daily_themes (day, slug, title, intro) values
    ('2026-10-10', 'oct-10', 'Oct 10', 'Intro');
  insert into public.daily_theme_cards (day, position, card_id) values
    ('2026-10-10', 0, '${deckIds[0]}'),
    ('2026-10-10', 1, '${deckIds[1]}'),
    ('2026-10-10', 2, '${deckIds[2]}'),
    ('2026-10-10', 3, '${deckIds[3]}');
  insert into public.daily_themes (day, slug, title, intro) values
    ('2026-11-25', 'nov-25', 'Nov 25', 'Intro');
  insert into public.daily_theme_cards (day, position, card_id) values
    ('2026-11-25', 0, '${deckIds[0]}'),
    ('2026-11-25', 1, '${deckIds[1]}'),
    ('2026-11-25', 2, '${deckIds[2]}'),
    ('2026-11-25', 3, '${deckIds[3]}');
`);

// Oct 5 & Oct 10 (all Oct daily_themes)
await setClock("2026-10-05T12:00:00+02:00");
await playDaily("bd_hero", { cards: 3 });
await playDaily("bd_rival", { cards: 3 }); // rival plays only 1 of 2 Oct themed dailies
await setClock("2026-10-10T12:00:00+02:00");
await playDaily("bd_hero", { cards: 3 });

// While still in Oct, storyteller must NOT unlock
await setClock("2026-10-20T12:00:00+02:00");
ok(!(await call("bd_hero", "my_achievements")).some(x => x.key === "storyteller"),
   "storyteller does not unlock before month finishes");

// Nov 1 -> Oct is finished! Plus build 7-day grace streak (Nov 16..23 skipping Nov 19)
await setClock("2026-11-01T12:00:00+01:00");
ok((await call("bd_hero", "my_achievements")).some(x => x.key === "storyteller" && x.tier === 1),
   "storyteller unlocks once finished Oct month has all themed dailies completed");
ok(!(await call("bd_rival", "my_achievements")).some(x => x.key === "storyteller"),
   "storyteller stays locked if one themed daily of the month was missed");

for (const d of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]) {
  await setClock(`${d}T12:00:00+01:00`);
  await playDaily("bd_hero", { cards: 10 });
}

// b) signature_spotter (100 artists) + movement_maker (100 movements) + photo_finish (< 100 margin)
const closeGameId = (await q1(
  `insert into public.games (kind, status, host_id, card_count, cards_per_turn, max_players)
   values ('async', 'finished', $1, 10, 1, 4) returning id`,
  [users.bd_hero]
)).id;
await q(
  `insert into public.game_players (game_id, player_id, display_name, score, answered, correct, artists_named, movements_named, final_rank) values
    ($1, $2, 'hero', 950, 10, 6, 100, 100, 1),
    ($1, $3, 'rival', 900, 10, 5, 0, 0, 2)`,
  [closeGameId, users.bd_hero, users.bd_rival]
);

// c) full_gallery: 3 of 4 packs -> NOT earned; 4 of 4 -> earned!
const allPacks = (await q(`select id from public.packs where active order by sort, id`)).map(r => r.id);
for (const pid of allPacks.slice(0, allPacks.length - 1)) {
  await q(`insert into public.player_packs (player_id, pack_id) values ($1, $2)`, [users.bd_hero, pid]);
}
ok(!(await call("bd_hero", "my_achievements")).some(x => x.key === "full_gallery"),
   "full_gallery requires ALL active packs");
await q(`insert into public.player_packs (player_id, pack_id) values ($1, $2)`, [users.bd_hero, allPacks[allPacks.length - 1]]);

// d) sharp_eye: day_index 5 alone does NOT unlock; day_index 3 DOES unlock
await q(
  `insert into public.weekly_painting_guesses (player_id, week_start, guessed_on, day_index, choice, correct)
   values ($1, '2026-11-09', '2026-11-13', 5, 'Johannes Vermeer', true)`,
  [users.bd_hero]
);
ok(!(await call("bd_hero", "my_achievements")).some(x => x.key === "sharp_eye"),
   "sharp_eye does not unlock on day_index 5");
await q(
  `insert into public.weekly_painting_guesses (player_id, week_start, guessed_on, day_index, choice, correct)
   values ($1, '2026-11-16', '2026-11-18', 3, 'Rembrandt van Rijn', true)`,
  [users.bd_hero]
);

// e) going_going_gone: score >= 15 in price mode
await submitSolo("bd_hero", { mode: "price", rounds: 15, correct: 15 });

// f) restorer: feedback with bug_rewarded = true via mark_bug_reporter
const fbId = await call("bd_hero", "submit_feedback", "Bug", "Found a varnish crack", null, {});
await callService("mark_bug_reporter", fbId, true);

const heroAch = await call("bd_hero", "my_achievements");
const byKey = Object.fromEntries(heroAch.map(x => [x.key, x.tier]));
ok(byKey.daily_streak === 7, `badge daily_streak tier=7 (via grace streak, got ${byKey.daily_streak})`);
ok(byKey.perfect_daily >= 7 && byKey.perfect_daily <= 10, `badge perfect_daily tier=${byKey.perfect_daily}`);
ok(byKey.signature_spotter === 100, "badge signature_spotter tier=100");
ok(byKey.movement_maker === 100, "badge movement_maker tier=100");
ok(byKey.photo_finish === 1, "badge photo_finish tier=1");
ok(byKey.storyteller === 1, "badge storyteller tier=1");
ok(byKey.full_gallery === 1, "badge full_gallery tier=1");
ok(byKey.sharp_eye === 1, "badge sharp_eye tier=1");
ok(byKey.going_going_gone === 15, "badge going_going_gone tier=15");
ok(byKey.restorer === 1, "badge restorer tier=1");
ok(byKey.vernissage_guest === 1, "badge vernissage_guest tier=1");

await callService("mark_bug_reporter", fbId, false);
ok(!(await call("bd_hero", "my_achievements")).some(x => x.key === "restorer"),
   "mark_bug_reporter(id, false) removes restorer badge");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
