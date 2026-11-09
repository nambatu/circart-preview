// 011: data export, full account deletion, feedback hygiene, retention clean-up, advisor fixes.
// Usage: node privacy011.test.mjs <migrations dir> <deck.sql>
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
const files = fs.readdirSync(DIR).filter(f => /^0\d\d_.*\.sql$/.test(f)).sort();
for (const f of files) await db.exec(fs.readFileSync(`${DIR}/${f}`, "utf8"));
await db.exec(fs.readFileSync(DECK, "utf8"));
ok(files.includes("011_privacy.sql"), `migrations loaded: ${files.join(", ")}`);

let clock;
const setClock = async iso => { clock = new Date(iso).getTime(); await db.exec(`set circart.test_now = '${new Date(clock).toISOString()}'`); };
const advance = s => setClock(new Date(clock + s * 1000).toISOString());
const realClock = () => db.exec(`set circart.test_now = ''`);
const users = {};
const signUp = async (n, anon = false, email = null) =>
  users[n] = (await db.query(`insert into auth.users (is_anonymous, email) values ($1, $2) returning id`, [anon, email])).rows[0].id;
async function as(who, sql, params = [], role = "authenticated") {
  await db.exec(`reset role; set request.jwt.claim.sub = '${who ? users[who] : ""}'; set role ${role};`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const call = async (who, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(",");
  return Object.values((await as(who, `select public.${fn}(${ph}) r`, args))[0])[0];
};
const err = async f => { try { await f(); return ""; } catch (e) { return e.message; } };
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const count = async (sql, p = []) => Number(Object.values((await q(sql, p))[0])[0]);
async function rightSlot(game, pos) {
  const r = (await q(`select c.year, _years_before($1,$2) ys from game_cards gc join cards c on c.id=gc.card_id
                       where gc.game_id=$1 and gc.position=$2`, [game, pos]))[0];
  return { slot: r.ys.filter(y => y < r.year).length, n: r.ys.length };
}
async function playRun(who, { wrongAt = [1, 2, 3], secs = 3 } = {}) {
  const g = await call(who, "start_run");
  for (let k = 1; k <= 100; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(secs);
    await call(who, "answer", g.id, c.position, wrongAt.includes(k) ? (rs.slot === 0 ? rs.n : 0) : rs.slot);
  }
  return g.id;
}
async function playDaily(who) {
  const g = await call(who, "play_daily");
  for (let k = 0; k < 10; k++) {
    const c = await call(who, "next_card", g.id);
    if (c.wait) break;
    const rs = await rightSlot(g.id, c.position);
    await advance(3);
    await call(who, "answer", g.id, c.position, rs.slot);
  }
  return g.id;
}
const deckIds = (await q(`select source_id from cards where active order by source_id limit 4`)).map(r => r.source_id);
const soloGame = () => ({ client_id: crypto.randomUUID(), score: 2, bonus_points: 1, best_streak: 2,
  finished_at: new Date().toISOString(),
  cards: [{ id: deckIds[0] }, { id: deckIds[1], correct: true, artist: true }, { id: deckIds[2], correct: true }, { id: deckIds[3], correct: false }] });

await signUp("ana", false, "ana@example.org"); await signUp("ben", false, "ben@example.org"); await signUp("gus", true);
await call("ana", "update_profile", null, "ana"); await call("ben", "update_profile", null, "benny");
await setClock("2026-11-10T19:00:00+01:00");

console.log("advisor fixes");
const cfg = await q(`select proname, proconfig from pg_proc where proname in ('_now','_grace','_turn_of','_is_done','_today','_day_start') and pronamespace = 'public'::regnamespace`);
ok(cfg.length === 6 && cfg.every(r => (r.proconfig || []).some(s => s.startsWith("search_path="))), "six helpers have a fixed search_path");
ok((await as("ana", `select display_name from profiles`)).length === 1, "own-profile policy still works (one row: mine)");
const idx = (await q(`select indexname from pg_indexes where schemaname='public'`)).map(r => r.indexname);
ok(["answers_player_idx", "feedback_player_idx", "games_host_idx", "push_outbox_game_idx"].every(i => idx.includes(i)), "foreign-key indexes exist");

console.log("export_my_data");
const anaRun = await playRun("ana", { wrongAt: [2, 3, 4] });
const daily = await playDaily("ana"); await playDaily("ben");
await call("ana", "submit_solo_game", soloGame());
await call("ana", "save_push_subscription", "https://push.example/ana-phone", "p256dh-key", "auth-secret", "Mozilla/5.0 test");
await call("ana", "submit_feedback", "Bug", "The timer froze", deckIds[1], { round: 3, page: "https://x.test/app/?game=1#access_token=SECRET", ua: "UA-ana", evil: "x".repeat(5000) });
const ex = await call("ana", "export_my_data");
ok(ex.format === "circart-export-1" && ex.account.email === "ana@example.org" && ex.profile.username === "ana", "account + profile included");
ok(ex.solo_games.length === 1 && ex.solo_games[0].cards.length === 4 && ex.solo_games[0].cards[1].title, "solo game with its cards");
ok(ex.games.length === 2 && ex.games.some(g => g.game.kind === "run") && ex.games.some(g => g.game.kind === "daily"), `online games: ${ex.games.map(g => g.game.kind).join(", ")}`);
const runEx = ex.games.find(g => g.game.id === anaRun);
ok(runEx.answers.length >= 3 && runEx.answers[0].card_title && runEx.me.score >= 0, "answers of a finished game name the card");
ok(ex.feedback.length === 1 && ex.feedback[0].message === "The timer froze", "own feedback included");
ok(ex.push_devices.length === 1 && ex.push_devices[0].user_agent === "Mozilla/5.0 test" && !JSON.stringify(ex).includes("auth-secret"), "push device listed, keys left out");
const exs = JSON.stringify(ex);
ok(!exs.includes(users.ben) && !exs.includes("benny") && !exs.includes("ben@example.org"), "nothing about other players");
ok((await err(() => as(null, `select public.export_my_data()`, [], "anon"))).includes("permission denied"), "anon can't export");
const bx = await call("ben", "export_my_data");
ok(bx.feedback.length === 0 && bx.solo_games.length === 0 && bx.games.length === 1, "ben's export has only ben's data");

console.log("submit_feedback hygiene");
const fb = (await q(`select context, card_source_id from feedback order by id desc limit 1`))[0];
ok(fb.context.page === "https://x.test/app/" && fb.context.ua === "UA-ana" && fb.context.round === 3 && !("evil" in fb.context), `context trimmed: ${JSON.stringify(fb.context)}`);
ok((await err(() => call("ana", "submit_feedback", "Bug", "x", "y".repeat(500), {}))) === "bad_feedback", "oversized card id refused");
ok(typeof (await call("gus", "submit_feedback", "Idea", "hello", null, [1, 2])) === "number", "non-object context is tolerated (stored empty)");
await q(`insert into feedback (topic, message, created_at) select 't', 'm', now() - interval '2 hours' from generate_series(1, 300)`);
ok((await err(() => as(null, `select public.submit_feedback('t','m',null,'{}')`, [], "anon"))) === "too_much_feedback", "daily cap for anonymous feedback");
await q(`delete from feedback where topic = 't'`);
ok(typeof Object.values((await as(null, `select public.submit_feedback('t2','m',null,'{}') r`, [], "anon"))[0])[0] === "number", "anonymous feedback still works under the cap");

console.log("delete_my_account");
// ana also hosts a lobby ben joined, has an empty lobby, and a queued push
const lb1 = await call("ana", "create_game", "async", 9, 3, null), lobbyBen = lb1.id;
await call("ben", "join_game", lb1.code, null);
const lobbyAlone = (await call("ana", "create_game", "live", 5, 1, null)).id;
await q(`insert into push_outbox (player_id, kind, title, body, url) values ($1, 'turn', 't', 'b', '?x')`, [users.ana]);
const before = await count(`select count(*) from games`);
await call("ana", "delete_my_account");
const id = users.ana;
const left = await q(`select
   (select count(*) from auth.users where id=$1) u, (select count(*) from profiles where id=$1) p,
   (select count(*) from solo_games where player_id=$1) s, (select count(*) from game_players where player_id=$1) gp,
   (select count(*) from answers where player_id=$1) a, (select count(*) from push_subscriptions where player_id=$1) ps,
   (select count(*) from push_outbox where player_id=$1) po, (select count(*) from feedback where player_id=$1) f,
   (select count(*) from games where host_id=$1) h`, [id]);
ok(Object.values(left[0]).every(v => Number(v) === 0), `nothing points to ana any more ${JSON.stringify(left[0])}`);
ok(await count(`select count(*) from games where id = $1`, [anaRun]) === 0 && await count(`select count(*) from games where id = $1`, [lobbyAlone]) === 0, "her run and her empty lobby are gone");
ok((await q(`select status from games where id = $1`, [lobbyBen]))[0].status === "cancelled", "the lobby ben joined is cancelled, not orphaned");
ok(await count(`select count(*) from games where id = $1`, [daily]) === 1 && await count(`select count(*) from game_players where game_id = $1`, [daily]) === 1, "the shared daily stays, with ben only");
const kept = (await q(`select context from feedback where message = 'The timer froze'`))[0];
ok(kept && !kept.context.ua && !kept.context.page && kept.context.round === 3, "her feedback stays, without device or page");
ok(before - await count(`select count(*) from games`) === 2, "exactly two games removed");
ok((await call("ben", "get_my_profile")).username === "benny", "ben is untouched");

console.log("privacy_cleanup");
await realClock();
await signUp("old_guest", true); await signUp("new_guest", true); await signUp("old_member", false, "m@example.org");
await signUp("busy_guest", true);
for (const n of ["old_guest", "new_guest", "old_member", "busy_guest"]) await call(n, "get_my_profile");
await call("old_member", "save_push_subscription", "https://push.example/old", "k", "a", null);
await call("ben", "save_push_subscription", "https://push.example/ben", "k", "a", null);
await call("busy_guest", "submit_solo_game", soloGame());
await q(`update profiles set last_seen_at = now() - interval '200 days', created_at = now() - interval '300 days'
          where id = any($1)`, [[users.old_guest, users.old_member, users.busy_guest]]);
const oldLobby = (await call("ben", "create_game", "live", 5, 1, null)).id;
await q(`update games set created_at = now() - interval '8 days' where id = $1`, [oldLobby]);
await q(`insert into push_outbox (player_id, kind, title, body, url, sent_at, created_at) values
          ($1, 'turn', 'old', 'b', '?x', now() - interval '20 days', now() - interval '20 days'),
          ($1, 'turn', 'stuck', 'b', '?x', null, now() - interval '3 days'),
          ($1, 'turn', 'fresh', 'b', '?x', now(), now())`, [users.ben]);
await q(`insert into feedback (topic, message, context, status, created_at) values
          ('a', 'done long ago', '{"ua":"x","page":"p"}', 'done', now() - interval '13 months'),
          ('a', 'open, 100 days', '{"ua":"x","page":"p","round":1}', 'new', now() - interval '100 days'),
          ('a', 'ancient', '{}', 'new', now() - interval '25 months'),
          ('a', 'recent', '{"ua":"x"}', 'new', now())`);
const r = await q(`select public.privacy_cleanup() r`).then(x => x[0].r);
ok(await count(`select count(*) from auth.users where id = $1`, [users.old_guest]) === 0, "idle guest deleted");
ok(await count(`select count(*) from auth.users where id = $1`, [users.new_guest]) === 1, "active guest kept");
ok(await count(`select count(*) from auth.users where id = $1`, [users.busy_guest]) === 1, "guest who played recently (solo save) kept");
ok(await count(`select count(*) from auth.users where id = $1`, [users.old_member]) === 1, "idle account with email kept");
ok(await count(`select count(*) from push_subscriptions where endpoint = 'https://push.example/old'`) === 0
   && await count(`select count(*) from push_subscriptions where endpoint = 'https://push.example/ben'`) === 1, "push device of idle player removed, active kept");
const titles = (await q(`select title from push_outbox where player_id = $1`, [users.ben])).map(x => x.title);
ok(titles.length === 1 && titles[0] === "fresh", `old + stuck push messages deleted (${titles})`);
ok(await count(`select count(*) from games where id = $1`, [oldLobby]) === 0, "week-old lobby deleted");
const msgs = (await q(`select message, context from feedback where topic = 'a' order by message`));
ok(msgs.map(m => m.message).join("|") === "open, 100 days|recent", `feedback kept: ${msgs.map(m => m.message)}`);
ok(!msgs[0].context.ua && msgs[0].context.round === 1 && msgs[1].context.ua === "x", "90-day-old feedback stripped, recent untouched");
ok(r.guests_deleted === 1 && r.feedback_deleted === 2, `report: ${JSON.stringify(r)}`);
ok((await err(() => as("ben", `select public.privacy_cleanup()`))).includes("permission denied"), "players can't run the clean-up");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
