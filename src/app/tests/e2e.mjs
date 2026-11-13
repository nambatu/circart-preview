import { PGlite } from "@electric-sql/pglite";
import http from "http"; import fs from "fs"; import path from "path";
import { createRequire } from "module"; const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const [E, MIG, DECK] = process.argv.slice(2);
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; grant usage on schema public to anon, authenticated;
  create schema auth; grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, is_anonymous boolean default false, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
for (const f of fs.readdirSync(MIG).filter(f => /^0\d\d_.*\.sql$/.test(f)).sort()) await db.exec(fs.readFileSync(`${MIG}/${f}`, "utf8"));
await db.exec(fs.readFileSync(DECK, "utf8"));
const imgs = fs.readdirSync(`${E}/site/images`);
await db.query(`update cards set image_url = '/images/' || (array[${imgs.map(i=>`'${i}'`).join(',')}])[1 + abs(hashtext(id)) % ${imgs.length}]`);
// 019: today's daily is a story daily (11 copies of deck cards, chapters, outro)
{
  const deck = (await db.query(`select * from cards where active order by year limit 40`)).rows;
  const pick = [20, 3, 31, 9, 25, 14, 38, 1, 28, 6, 17].map(i => deck[i]);
  for (const [i, c] of pick.entries())
    await db.query(`insert into cards (id, source_id, title, artist, year, movement, tier, image_url, trivia, active)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
                   ["st" + i, "daily:e2e:" + i, c.title, c.artist, c.year, c.movement, c.tier, c.image_url, c.trivia]);
  await db.exec(`insert into daily_themes (day, slug, title, title_de, intro, intro_de, outro, outro_de)
                 values (_today(), 'e2e-walk', 'A walk through the cathedral', 'Ein Gang durch den Dom',
                         'We start at the big west door.', 'Wir beginnen am Westportal.', 'And that is the end of our walk.', 'Damit endet unser Gang.')`);
  for (let i = 0; i <= 10; i++)
    await db.query(`insert into daily_theme_cards (day, position, card_id, chapter, chapter_de, credit) values (_today(), $1, $2, $3, $4, $5)`,
                   [i, "st" + i, "Now turn left to chapter " + (i + 1) + ".", "Jetzt links zu Kapitel " + (i + 1) + ".", "Photo: Test, CC BY-SA 4.0"]);
}
const users = {};
let q = Promise.resolve();                       // one query at a time, like a connection pool of 1
const run = fn => (q = q.then(fn, fn));
async function rpc(who, fn, args) {
  if (fn === '_test_user') return !!users[who];
  if (fn === '_test_signup') { if (!users[who]) users[who] = (await db.query(`insert into auth.users (is_anonymous) values (true) returning id`)).rows[0].id; return true; }
  if (!users[who]) throw new Error('not_signed_in');
  const keys = Object.keys(args); const vals = keys.map(k => args[k]);
  await db.exec(`reset role; set request.jwt.claim.sub = '${users[who]}'; set role authenticated;`);
  try { return Object.values((await db.query(`select public.${fn}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) r`, vals)).rows[0])[0]; }
  finally { await db.exec('reset role'); }
}
const types = {".js":"text/javascript",".css":"text/css",".json":"application/json",".jpg":"image/jpeg",".html":"text/html"};
const srv = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => run(async () => {
      const { who, fn, args } = JSON.parse(body);
      try { res.end(JSON.stringify({ result: await rpc(who, fn, args) })); }
      catch (e) { res.end(JSON.stringify({ error: e.message })); }
    }));
    return;
  }
  const u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(E, 'site', u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', types[path.extname(f)] || 'text/plain'); res.end(fs.readFileSync(f));
}).listen(8772);

let fails = 0; const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) fails++; };
const right = (gid, pos) => run(async () => { const r = (await db.query(`select c.year, _years_before($1,$2) ys from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [gid, pos])).rows[0];
  return { slot: r.ys.filter(y => y < r.year).length, n: r.ys.length }; });
const b = await chromium.launch();
const shot = (p, n) => p.screenshot({ path: `${E}/${n}.png` });
const errs = [];
const page = async (who, scheme = 'light') => { const p = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
  p.on('pageerror', e => errs.push(who + ': ' + e.message));
  p.on('console', m => { if (/Content.Security.Policy/i.test(m.text())) errs.push(who + ' CSP: ' + m.text().slice(0, 160)); });
  if (who !== 'newbie') await p.addInitScript(() => { try { localStorage.setItem('circart-onboarded', '1'); } catch (e) {} });
  return p; };
// the home cards fill in when their data arrives; wait so clicks don't land on a moving page
const homeReady = async p => { await p.waitForSelector('#home-friends'); await p.waitForTimeout(400); };
// click if it's (still) there: optional bonus questions can close by themselves
const clickIf = (p, sel) => p.click(sel, { timeout: 3000 }).catch(() => {});
const text = p => p.evaluate(() => document.getElementById('go-body').innerText);
const waitText = (p, s, ms = 15000) => p.waitForFunction(s => document.getElementById('go-body') && document.getElementById('go-body').innerText.toLowerCase().includes(s.toLowerCase()), s, { timeout: ms });

try {
  console.log("live game, two players");
  const ana = await page('ana'); await ana.goto('http://localhost:8772/?as=ana'); await homeReady(ana);
  await ana.click('#home-friends'); await ana.fill('#fs-name', 'Ana'); await ana.click('[data-kind="live"]');
  await waitText(ana, 'Join with code');
  const code = (await ana.textContent('.go-code')).trim();
  ok(/^[A-Z2-9]{4}$/.test(code), `lobby shows code ${code}`);
  await shot(ana, '1-lobby');
  const gid = await run(async () => (await db.query(`select id from games where code=$1`, [code])).rows[0].id);
  await run(() => db.query(`update games set card_count = 3 where id=$1`, [gid]));
  const ben = await page('ben', 'dark'); await ben.goto(`http://localhost:8772/?as=ben&join=${code}`); await ben.waitForTimeout(400);
  await ben.fill('#js-name', 'Ben'); await ben.click('#js-go');
  await waitText(ben, 'Waiting for the host');
  ok(true, "invite link: name asked, Ben joins and waits for the host");
  await waitText(ana, 'Ben', 8000);
  ok(true, "Ana's lobby shows Ben (live refresh)");
  await ana.click('[data-act="start"]');
  for (let pos = 1; pos <= 3; pos++) {
    await waitText(ana, 'Tap where it belongs'); await waitText(ben, 'Tap where it belongs', 8000);
    if (pos === 1) { ok(/Card 1 \/ 3/.test(await text(ana)), "both see card 1 with a timer"); await shot(ana, '2-round'); }
    if (pos === 1) ok(await ana.evaluate(() => { const e = document.querySelector('.go-sticky #go-bar'); return !!e && getComputedStyle(e.closest('.go-sticky')).position === 'sticky'; }), "countdown bar sits in a sticky header");
    const r = await right(gid, pos);
    await ana.click(`[data-gap="${r.slot}"]`);
    await ben.click(`[data-gap="${r.slot === 0 ? r.n : 0}"]`);
    await waitText(ana, 'Who made it?');
    if (pos === 1) { ok((await text(ana)).includes('Locked in'), "live: 'Locked in', result kept secret, artist question"); await shot(ana, '3-locked'); }
    const opts = await ana.$$eval('[data-artist]', bs => bs.map(b => b.dataset.artist));
    const artist = await run(async () => (await db.query(`select c.artist from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [gid, pos])).rows[0].artist);
    ok(opts.length === 4 && opts.includes(artist), `4 artist names incl. the right one (card ${pos})`);
    await ana.click(`[data-artist="${artist.replace(/"/g, '\\"')}"]`);
    if (pos === 1) ok((await ana.$$('[data-movement]')).length === 4 || (await ana.$$('[data-movement]')).length === 0, "movement question: 4 options (or none for this card)");
    await clickIf(ana, '[data-act="skip"]');
    await clickIf(ben, '[data-act="skip"]');
    await waitText(ana, 'Where everyone placed it', 8000); await waitText(ben, 'Where everyone placed it', 8000);
    if (pos === 1) {
      const ta = await text(ana), tb = await text(ben);
      ok(ta.includes('Correct!') && tb.includes('Not quite'), "reveal: Ana correct, Ben not");
      ok(/✓/.test(ta) && /Next card in/.test(ta), "reveal: right gap marked, countdown to the next card");
      await shot(ana, '4-reveal'); await shot(ben, '4-reveal-dark');
    }
  }
  await waitText(ana, 'Game over', 15000); await waitText(ben, 'Game over', 8000);
  ok((await text(ana)).includes('You win!') && (await text(ben)).includes('Ana wins'), "podium: 'You win!' for Ana, 'Ana wins' for Ben");
  await shot(ana, '5-podium');
  await ben.click('[data-act="rematch"]');
  await waitText(ben, 'Join with code');
  ok(true, "Ben: 'Play again' opens a new lobby");
  await waitText(ana, 'wants a rematch', 15000);
  await shot(ana, '5b-rematch-offer');
  await ana.click('[data-act="rematch"]');
  await waitText(ana, 'Waiting for the host');
  ok(true, "Ana sees 'Ben wants a rematch' and joins the same lobby");
  await ana.click('.go-close'); await ana.waitForTimeout(400);

  console.log("\nasync game");
  ok(await ana.isVisible('#home-friends'), "back on the home screen");
  await ana.click('#home-friends'); await ana.click('[data-kind="async"]');
  await waitText(ana, 'Join with code');
  const code2 = (await ana.textContent('.go-code')).trim();
  await ben.goto('http://localhost:8772/'); await ben.waitForSelector('#home-games [data-game]'); await ben.waitForFunction(() => document.getElementById('home-daily').innerText.includes('New in')); await ben.waitForTimeout(300);
  await ben.fill('#home-code', code2); await ben.click('#home-join button[type=submit]');
  await waitText(ben, 'Waiting for the host');
  ok(true, "Ben joins with the code from the home screen");
  await waitText(ana, 'Ben', 35000);
  ok(!(await ana.isChecked('[data-opt="timer"]')), "async lobby: timer switch, off by default");
  await ana.click('.go-switch:has([data-opt="timer"])'); await ana.waitForTimeout(500);
  ok(await ana.isChecked('[data-opt="timer"]'), "host can switch the timer on");
  await ana.click('[data-secs="45"]'); await ana.waitForTimeout(500);
  ok((await ana.getAttribute('[data-secs="45"]', 'aria-pressed')) === 'true', "host picks 45 seconds per card");
  await ana.click('.go-switch:has([data-opt="timer"])'); await ana.waitForTimeout(500);
  ok(!(await ana.isChecked('[data-opt="timer"]')), "…and off again");
  await ana.click('[data-act="start"]');
  await waitText(ana, 'Start turn 1');
  ok(true, "async: 'Your turn' with a Start button, no clock running yet");
  await shot(ana, '6-async-ready');
  const gid2 = await run(async () => (await db.query(`select id from games where code=$1`, [code2])).rows[0].id);
  const opened = await run(async () => (await db.query(`select count(*)::int n from answers where game_id=$1`, [gid2])).rows[0].n);
  ok(opened === 0, "opening the game didn't start a card");
  await ana.click('[data-act="ready"]');
  for (let k = 0; k < 3; k++) {
    await waitText(ana, 'Tap where it belongs');
    const pos = await run(async () => (await db.query(`select max(position)::int p from answers where game_id=$1 and player_id=$2`, [gid2, users.ana])).rows[0].p);
    const r = await right(gid2, pos);
    await ana.click(`[data-gap="${k === 1 ? (r.slot === 0 ? r.n : 0) : r.slot}"]`);
    await waitText(ana, 'Who made it?');
    if (k === 0) {
      ok((await text(ana)).includes('Correct!'), "async: own result straight away");
      ok(!(await ana.$('.go-timer')) || !(await ana.isVisible('.go-timer')), "timer off: no countdown");
      ok(await ana.evaluate(() => { const e = document.querySelector('.go-sticky'); return !e || getComputedStyle(e).position === 'sticky'; }), "countdown bar (when there is one) is sticky");
      ok(await ana.isVisible('.go-bonus-art'), "the painting stays visible next to the questions");
      const names = await ana.$$eval('[data-artist]', bs => bs.map(b => b.dataset.artist));
      const realA = await run(async () => (await db.query(`select c.artist from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [gid2, pos])).rows[0].artist);
      const wrongA = names.find(n => n !== realA);
      // watch the whole picking time: no right/wrong marker may appear, not even for a frame
      await ana.evaluate(() => { window.__flash = 0; const chk = () => { if (document.querySelector('.go-pick.right, .go-pick.wrong')) window.__flash++; };
        new MutationObserver(chk).observe(document.body, { subtree: true, childList: true, attributes: true }); });
      const other = names.find(n => n !== realA && n !== wrongA);
      await ana.click(`[data-artist="${wrongA.replace(/"/g, '\\"')}"]`); await ana.waitForTimeout(150);
      ok((await ana.$$('[data-artist]')).length === names.length, "artist answers stay changeable after the first tap");
      await ana.click(`[data-artist="${other.replace(/"/g, '\\"')}"]`); await ana.waitForTimeout(150);
      ok(!(await ana.$('.go-pick.right, .go-pick.wrong')), "nothing shown as right or wrong while picking");
      await ana.click(`[data-artist="${wrongA.replace(/"/g, '\\"')}"]`);
      if (await ana.$('[data-movement]')) {
        ok(!(await ana.$('[data-act="lock"]')), "no lock-in button until both are picked");
        const mv = await ana.$$('[data-movement]'); await mv[0].click(); await ana.waitForTimeout(100); await (await ana.$$('[data-movement]'))[1].click();
        ok(!!(await ana.$('[data-act="lock"]')), "lock-in button appears once both are picked");
        await ana.click('[data-act="lock"]');
      } else await ana.click('[data-act="skip"]');
      ok(await ana.evaluate(() => window.__flash) === 0, "no right/wrong flash at any moment before lock-in");
      await waitText(ana, 'Next');
      ok(!!(await ana.$('.go-pick.right')) && !!(await ana.$('.go-pick.wrong')), "the right answer shows green and my wrong pick red");
      await shot(ana, '7b-async-bonus');
    } else await ana.click('[data-act="skip"]');
    await waitText(ana, 'Next');
    if (k === 0) { ok(/\d{4}/.test(await text(ana)), "then the card's year and story"); await shot(ana, '7-async-result'); }
    if (k === 1) ok((await text(ana)).includes('Not quite'), "wrong placement shown");
    await ana.click('[data-act="next"]');
  }
  await waitText(ana, 'Turn done');
  ok((await text(ana)).includes('not yet'), "after 3 cards: turn done, Ben hasn't played");
  await shot(ana, '8-async-waiting');
  ok((await text(ana)).includes("your turn?"), "after the first async turn: 'Get told when it's your turn?'");
  await ana.click('[data-act="pushOn"]'); await ana.waitForTimeout(300);
  ok(!(await text(ana)).includes("your turn?"), "turned on: the prompt is gone and won't come back");
  await ana.click('.go-close'); await ana.waitForTimeout(600);
  await ben.goto('http://localhost:8772/'); await ben.waitForTimeout(800);
  ok((await ben.textContent('#home-games')).includes('Your turn'), "Ben's home shows 'Your turn'");
  await shot(ben, '9-home-yourturn-dark');

  console.log("\ndaily challenge");
  const cleo = await page('cleo'); await cleo.goto('http://localhost:8772/?as=cleo'); await cleo.waitForTimeout(500);
  await cleo.click('[data-daily="play"]');
  await waitText(cleo, 'We start at the big west door');
  ok(true, "story daily: the start screen shows the intro");
  await shot(cleo, '10-daily-start');
  await cleo.click('[data-act="ready"]');
  const gid3 = await run(async () => (await db.query(`select id from games where kind='daily'`)).rows[0].id);
  for (let k = 0; k < 10; k++) {
    await waitText(cleo, 'Tap where it belongs');
    if (k === 0) await shot(cleo, '11-daily-card');
    const pos = await run(async () => (await db.query(`select max(position)::int p from answers where game_id=$1 and player_id=$2`, [gid3, users.cleo])).rows[0].p);
    const r = await right(gid3, pos);
    await cleo.click(`[data-gap="${k % 3 === 2 ? (r.slot === 0 ? r.n : 0) : r.slot}"]`);
    await waitText(cleo, 'Who made it?');
    await cleo.click('[data-act="skip"]');
    await waitText(cleo, k === 9 ? 'See results' : 'Next');
    if (k === 0) {
      ok((await text(cleo)).includes('chapter 2') && (await text(cleo)).includes('CC BY-SA'), "after the first card: its chapter and the photo credit");
      ok((await cleo.locator('.go-trivia').count()) === 0 && (await cleo.locator('.go-chapter').count()) > 0, "story daily reveal: chapter shown, no card trivia");
      await shot(cleo, '11b-story-chapter');
    }
    await cleo.click('[data-act="next"]');
  }
  await waitText(cleo, 'Daily done');
  ok((await text(cleo)).includes('end of our walk'), "results: the story's ending");
  ok((await text(cleo)).includes('7 of 10 placed right'), "daily done: 7 of 10 right, score shown");
  ok(((await text(cleo)).match(/🟥/g) || []).length === 3 && ((await text(cleo)).match(/🟩/g) || []).length === 7, "daily done: 7 green and 3 red squares");
  await shot(cleo, '12-daily-done');
  await cleo.click('[data-act="home"]'); await cleo.waitForTimeout(800);
  ok((await cleo.textContent('#home-daily')).includes('A walk through the cathedral'), "home: the daily card shows the story's title");
  ok((await cleo.textContent('#home-daily')).includes('See results'), "home: daily shows 'See results' after playing");
  await shot(cleo, '13-home-daily-done');
  await cleo.click('.tabbar [data-tab="ranks"]'); await cleo.waitForTimeout(800);
  const rk = await cleo.textContent('#ranks-body');
  ok(rk.includes('today') && rk.includes('pick a name'), "ranks: today's board, hint to pick a name");
  ok(rk.includes('ONLINE GAMES') || rk.toLowerCase().includes('online games'), "ranks: your online stats");
  await shot(cleo, '14-ranks-today');
  await cleo.click('[data-rt="month"]'); await cleo.waitForTimeout(600);
  ok((await cleo.textContent('#ranks-body')).includes('days left'), "ranks: month tab shows the monthly rule");
  await cleo.click('[data-rt="allTime"]'); await cleo.waitForTimeout(600); await shot(cleo, '15-ranks-alltime');

  console.log("\nmonthly run");
  const dora = await page('dora'); await dora.goto('http://localhost:8772/?as=dora'); await dora.waitForTimeout(600);
  await dora.waitForFunction(() => document.getElementById('home-run').innerText.includes('Masterpieces') || document.getElementById('home-run').innerText.includes('Monthly Run'));
  await shot(dora, '16-home-run');
  await dora.click('[data-run="play"]');
  await waitText(dora, 'until your third mistake');
  ok(true, "run card opens the run with a Start screen");
  await dora.click('[data-act="ready"]');
  const rid = await run(async () => (await db.query(`select g.id from games g join game_players gp on gp.game_id=g.id where g.kind='run' and gp.player_id=$1`, [users.dora])).rows[0].id);
  for (let k = 1; k <= 12; k++) {
    await waitText(dora, 'Tap where it belongs');
    if (k === 1) { ok((await text(dora)).includes('❤️❤️❤️'), "three lives shown"); await shot(dora, '17-run-card'); }
    const pos = await run(async () => (await db.query(`select max(position)::int p from answers where game_id=$1`, [rid])).rows[0].p);
    const r = await right(rid, pos);
    const wrong = [2, 4, 5].includes(k);
    await dora.click(`[data-gap="${wrong ? (r.slot === 0 ? r.n : 0) : r.slot}"]`);
    await dora.waitForFunction(() => document.getElementById('go-body').innerText.match(/Next|See results/));
    if (k === 1) {
      ok(!(await text(dora)).includes('Who made it?'), "runs ask no artist or style questions");
      ok((await text(dora)).includes('+1'), "a right card is worth 1 point");
    }
    if (k === 5) { await waitText(dora, 'See results'); ok((await text(dora)).includes('Run over'), "third mistake: 'Run over'"); await dora.click('[data-act="next"]'); break; }
    await waitText(dora, 'Next');
    if (k === 2) ok((await text(dora)).includes('One life lost'), "a mistake costs a life");
    await dora.click('[data-act="next"]');
  }
  await dora.waitForSelector('[data-act="runAgain"]');
  const rdone = await text(dora);
  ok(rdone.includes('5 cards placed') && rdone.includes('New personal best') && rdone.includes('cards placed right'), "results: 5 cards, new personal best: " + rdone.slice(0, 160).replace(/\n/g, ' | '));
  await shot(dora, '18-run-done');
  await dora.click('[data-act="runAgain"]');
  await waitText(dora, 'until your third mistake');
  ok(true, "'Again' starts a fresh run straight away");
  await dora.click('.go-close'); await dora.waitForTimeout(800);
  ok((await dora.textContent('#home-run')).includes('Continue your run'), "home offers to continue the unfinished run");
  ok(!(await dora.$('#home-packs')), "packs are no longer on the home screen");
  ok((await dora.getAttribute('#home-code', 'placeholder')) === 'ABCD', "join field shows the example code ABCD");
  await dora.click('.tabbar [data-tab="gallery"]'); await dora.waitForTimeout(600);
  await dora.click('#gallery-seg [data-gview="packs"]');
  await dora.waitForFunction(() => document.getElementById('gallery-packs').innerText.includes('Baroque'));
  const pk = await dora.textContent('#gallery-packs');
  ok(pk.includes('Baroque Masters') && pk.includes('1 of 3') && pk.includes('German Artists'), "Gallery → Packs: Baroque Masters 1 of 3 runs, German Artists locked");
  await dora.click('[data-open-pack="baroque-masters"]');
  await dora.waitForSelector('.gp-grid .gp-secret');
  ok((await dora.$$('.gp-grid .gp-secret')).length === 25 && !(await dora.$('[data-pack-play]')), "a locked pack shows 25 hidden pieces and no play button");
  await dora.goBack(); await dora.waitForTimeout(500);
  ok(!!(await dora.$('[data-open-pack]')) && await dora.isVisible('#gallery-screen'), "back closes the pack, not the gallery");
  await shot(dora, '19a-packs');
  await dora.click('.tabbar [data-tab="play"]'); await dora.waitForTimeout(600);

  console.log("\nwinners + badges (next month)");
  await run(() => db.query(`update profiles set username = 'dora', is_guest = false where id = $1`, [users.dora]));
  const nm = new Date(); nm.setUTCMonth(nm.getUTCMonth() + 1, 2); nm.setUTCHours(12);
  await run(() => db.exec(`set circart.test_now = '${nm.toISOString()}'`));
  await dora.click('.tabbar [data-tab="ranks"]'); await dora.waitForTimeout(600);
  await dora.click('[data-rt="month"]'); await dora.waitForTimeout(900);
  const rkt = await dora.textContent('#ranks-body');
  ok(rkt.includes('🥇') && rkt.includes('dora') && rkt.toLowerCase().includes('winners'), "Ranks → Month: last month's winners with dora 🥇");
  await shot(dora, '19-winners');
  await dora.click('.tabbar [data-tab="profile"]'); await dora.waitForTimeout(1200);
  ok((await dora.textContent('#profile-body')).includes('Monthly Run · place 1'), "Profile shows dora's badge");
  ok((await dora.$$('#profile-body input.input:not([type=email])')).length === 1 && (await dora.inputValue('#pf-name')) === 'dora', "Profile has ONE name field (the username)");
  await dora.fill('#pf-name', 'dora two'); await dora.click('#pf-name-save'); await dora.waitForTimeout(500);
  ok((await dora.textContent('body')).includes('without spaces'), "an invalid name gets a plain explanation");
  await dora.fill('#pf-name', 'dora_2'); await dora.click('#pf-name-save'); await dora.waitForTimeout(800);
  const dn = await run(() => db.query(`select username, display_name from profiles where id = $1`, [users.dora]));
  ok(dn.rows[0].username === 'dora_2' && dn.rows[0].display_name === 'dora_2', "saving sets the leaderboard name and the game name together");
  ok(await dora.isVisible('#pf-install'), "Profile offers 'Install the app'");
  await dora.click('#pf-install'); await dora.waitForTimeout(400);
  ok((await dora.textContent('body')).includes('Add to Home screen'), "…with a how-to where the browser has no install prompt");
  await dora.keyboard.press('Escape'); await dora.evaluate(() => document.querySelectorAll('body > .modal').forEach(m => m.remove()));
  await shot(dora, '20-badge');
  await run(() => db.exec(`reset circart.test_now`));

  console.log("\ntutorial");
  const nb = await page('newbie'); await nb.goto('http://localhost:8772/?as=newbie'); await nb.waitForTimeout(1500);
  const dlg = await nb.$('[role="dialog"]:not(#zoom-modal)');
  ok(!!dlg && (await dlg.innerText()).toLowerCase().includes('which came first'), "first visit: the tutorial opens (new plain wording)");
  await shot(nb, '21-tutorial');
  for (let i = 0; i < 6; i++) { const b = await nb.$('[role="dialog"]:not(#zoom-modal) button:has-text("Next"), [role="dialog"]:not(#zoom-modal) button:has-text("Let\'s play")'); if (!b) break; await b.click(); await nb.waitForTimeout(250); }
  ok(!(await nb.$('[role="dialog"]:not(#zoom-modal)')) || !(await nb.isVisible('[role="dialog"]:not(#zoom-modal)')), "Next … Let's play closes it");
  await nb.reload(); await nb.waitForTimeout(1500);
  ok(!(await nb.$('[role="dialog"]:not(#zoom-modal)')) || !(await nb.isVisible('[role="dialog"]:not(#zoom-modal)')), "…and it doesn't come back");
  await nb.click('.tabbar [data-tab="profile"]'); await nb.waitForTimeout(600);
  await nb.click('#pf-howto'); await nb.waitForTimeout(500);
  ok(await nb.isVisible('[role="dialog"]:not(#zoom-modal)'), "Profile → How to play opens it again");

  console.log("\nback button");
  const bk = await page('backy'); await bk.goto('http://localhost:8772/?as=backy'); await bk.waitForTimeout(1200);
  await bk.click('.tabbar [data-tab="ranks"]'); await bk.waitForTimeout(400);
  await bk.evaluate(() => history.back()); await bk.waitForTimeout(500);
  ok(await bk.evaluate(() => document.querySelector('.screen.active').id) === 'start-screen', "back on Ranks → home");
  await bk.evaluate(() => history.back()); await bk.waitForTimeout(500);
  ok((await bk.textContent('body')).includes('Swipe back once more'), "back on home → 'swipe back once more' hint, app stays open");
  await bk.mouse.click(5, 5); await bk.waitForTimeout(200);
  await bk.click('#start-btn').catch(() => {}); await bk.waitForTimeout(2500);
  if (await bk.evaluate(() => document.querySelector('.screen.active').id) === 'game-screen') {
    await bk.evaluate(() => history.back()); await bk.waitForTimeout(500);
    ok((await bk.textContent('body')).includes('Leave this game?') && await bk.evaluate(() => document.querySelector('.screen.active').id) === 'game-screen', "back in a solo game → 'Leave this game?', game still there");
    await bk.click('[data-x="stay"]'); await bk.waitForTimeout(300);
    await bk.evaluate(() => history.back()); await bk.waitForTimeout(500);
    await bk.click('[data-x="leave"]'); await bk.waitForTimeout(500);
    ok(await bk.evaluate(() => document.querySelector('.screen.active').id) === 'start-screen', "'Leave the game' → home");
  } else ok(false, "solo game didn't start in the test site");
  ok(errs.length === 0, "no script errors" + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) { console.log("  ✗ " + e.message.split('\n')[0]); fails++; }
console.log(fails ? `${fails} FAILED` : "all checks passed");
await b.close(); srv.close(); process.exit(fails ? 1 : 0);
