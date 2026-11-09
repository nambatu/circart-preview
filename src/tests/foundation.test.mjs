// Tests the foundation migration on an embedded Postgres, with stand-ins for
// Supabase's sign-in system. Usage: node foundation.test.mjs <migration.sql> <deck.sql>
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";

const [MIG, DECK] = process.argv.slice(2);
const db = new PGlite();
let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

await db.exec(`
  create role anon; create role authenticated;
  grant usage on schema public to anon, authenticated;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text,
    is_anonymous boolean default false, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
await db.exec(fs.readFileSync(MIG, "utf8"));
await db.exec(fs.readFileSync(DECK, "utf8"));

const users = {};
async function signUp(name, anon = true, meta = {}) {
  users[name] = (await db.query(`insert into auth.users (is_anonymous, raw_user_meta_data) values ($1,$2) returning id`,
                                [anon, meta])).rows[0].id;
}
async function as(name, sql, params = []) {
  await db.exec(`reset role; set request.jwt.claim.sub = '${name ? users[name] : ""}'; set role ${name ? "authenticated" : "anon"};`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
}
const err = async f => { try { await f(); return ""; } catch (e) { return e.message; } };
const one = async (who, sql, p) => Object.values((await as(who, sql, p))[0])[0];

console.log("deck");
const n = (await db.query(`select count(*)::int n from cards`)).rows[0].n;
ok(n >= 200, `${n} cards loaded`);
const leak = (await db.query(`select count(*)::int n from cards where id ~ '(1[3-9]|20)\\d\\d' or image_url ~ '/\\d{4}-'`)).rows[0].n;
ok(leak === 0, "no public id or image link contains a year");
ok((await db.query(`select artist from cards where source_id like '%abramovic%'`)).rows[0].artist === "Marina Abramović",
   "broken characters repaired (Abramović)");
ok((await db.query(`select tier from cards where source_id like '%arnolfini%'`)).rows[0].tier === 1, "tier kept");
ok((await err(() => as("x", `select 1`))) !== null, "setup");

console.log("\naccounts");
await signUp("guest"); await signUp("julian", false, { full_name: "Julian Langschwert" }); await signUp("anna");
let p = await one("guest", `select get_my_profile()`);
ok(/^Guest \d{4}$/.test(p.display_name) && p.is_guest && !p.needs_username, `guest gets "${p.display_name}"`);
p = await one("julian", `select get_my_profile()`);
ok(p.display_name === "Julian" && !p.is_guest && p.needs_username, "Google user: first name taken, asked to pick a username");
p = await one("julian", `select update_profile(null, 'julian')`);
ok(p.username === "julian" && !p.needs_username, "username set");
ok((await err(() => as("anna", `select update_profile(null, 'JULIAN')`))).includes("username_taken"), "usernames unique regardless of case");
ok((await err(() => as("anna", `select update_profile(null, 'a b')`))).includes("username_invalid"), "invalid usernames refused");
ok(await one("anna", `select username_available('anna_k')`) === true, "availability check");
await db.query(`update auth.users set is_anonymous=false where id=$1`, [users.guest]);
ok((await one("guest", `select get_my_profile()`)).is_guest === false, "guest who links Google/email becomes a full account (same id)");
ok((await as("anna", `select * from profiles`)).length === 1, "players only see their own profile row");

console.log("\nsecrecy");
ok((await err(() => as("julian", `select year from cards`))).includes("permission denied"), "cards unreadable from the app");
ok((await err(() => as(null, `select get_my_profile()`))).includes("permission denied"), "signed-out visitors can't call account functions");

console.log("\nsolo games");
const deck = (await db.query(`select source_id from cards order by random() limit 11`)).rows.map(r => r.source_id);
const game = (cid, score = 9) => ({
  client_id: cid, started_at: new Date(Date.now() - 300000).toISOString(), finished_at: new Date().toISOString(),
  score, bonus_points: 2, best_streak: 4,
  cards: [{ id: deck[0] }, ...deck.slice(1).map((id, i) => ({ id, correct: i < 7, artist: i < 2 }))],
});
const cid = crypto.randomUUID();
let r = await one("julian", `select submit_solo_game($1)`, [game(cid)]);
ok(!r.duplicate && r.unknown_cards === 0, "game saved");
r = await one("julian", `select submit_solo_game($1)`, [game(cid)]);
ok(r.duplicate, "re-sending the same game (offline queue) doesn't double-count");
ok((await err(() => as("julian", `select submit_solo_game($1)`, [game(crypto.randomUUID(), 999)]))).includes("bad_game"),
   "impossible scores refused");
const g2 = game(crypto.randomUUID()); g2.cards.push({ id: "1999-not-in-deck", correct: true });
r = await one("julian", `select submit_solo_game($1)`, [g2]);
ok(r.unknown_cards === 1, "cards missing from the database are skipped, not fatal");
const st = await one("julian", `select my_solo_stats()`);
ok(st.games === 2 && st.best_streak === 4 && st.accuracy > 0, `stats: ${JSON.stringify(st)}`);
const seen = await one("julian", `select recently_seen_cards(24)`);
ok(seen.length === 11 && seen.includes(deck[0]), "recently seen cards come back as artline ids (any device)");
ok((await one("anna", `select recently_seen_cards(24)`)).length === 0, "other players' history isn't shared");
ok((await as("anna", `select * from solo_games`)).length === 0, "can't read someone else's games");

console.log("\nfeedback");
const fid = await one(null, `select submit_feedback('Wrong year', 'Arnolfini is 1434', $1, '{"round":3}')`, [deck[0]]);
ok(fid > 0, "signed-out visitors can send feedback");
await one("julian", `select submit_feedback('Feature suggestion', 'Dark mode please')`);
ok((await db.query(`select count(*)::int n from feedback where player_id=$1`, [users.julian])).rows[0].n === 1, "feedback linked to the player");
ok((await err(() => as("julian", `select * from feedback`))).includes("permission denied"), "players can't read feedback");
for (let i = 0; i < 10; i++) await one("anna", `select submit_feedback('x', 'y')`);
ok((await err(() => as("anna", `select submit_feedback('x', 'y')`))).includes("too_much_feedback"), "spam limit: 10 per hour");

console.log("\naccount deletion");
await one("julian", `select delete_my_account()`);
ok((await db.query(`select count(*)::int n from solo_games where player_id=$1`, [users.julian])).rows[0].n === 0, "games removed with the account");
ok((await db.query(`select count(*)::int n from feedback where message='Dark mode please' and player_id is null`)).rows[0].n === 1,
   "feedback kept, but no longer linked to the person");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
