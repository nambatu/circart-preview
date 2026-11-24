// 034: device time zone for the rough country count.
// Usage: node hardening.test.mjs <migrations dir> <deck.sql>
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

await signUp("ana"); await signUp("ben"); await signUp("cy"); await signUp("dee"); await signUp("host");

await signUp("tz1"); await signUp("tz2");
const tzOf = async n => (await db.query(`select time_zone from profiles where id = $1`, [users[n]])).rows[0].time_zone;
await call("tz1", "set_my_time_zone", "Europe/Vienna");
ok(await tzOf("tz1") === "Europe/Vienna", "a real time zone is saved");
await call("tz1", "set_my_time_zone", "Mars/Olympus");
ok(await tzOf("tz1") === "Europe/Vienna", "an unknown name is ignored");
await call("tz1", "set_my_time_zone", "x".repeat(200));
ok(await tzOf("tz1") === "Europe/Vienna", "a long text is ignored");
ok(await tzOf("tz2") === null, "only the caller's own profile changes");
ok((await err(() => as("tz2", `update profiles set time_zone = 'Europe/Berlin' where id = '${users.tz2}'`))).length > 0, "no direct writes to profiles");
const ex = await call("tz1", "export_my_data");
ok(ex.profile && ex.profile.time_zone === "Europe/Vienna", "the time zone is in the data export");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
