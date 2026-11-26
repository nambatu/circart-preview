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
  // 033: a story that looks back (start card chapter + the whole story in order at the end)
  await db.exec(`insert into daily_themes (day, slug, title, title_de, intro, intro_de, outro, outro_de, look_back)
                 values (_today(), 'e2e-walk', 'A walk through the cathedral', 'Ein Gang durch den Dom',
                         'We start at the big west door.', 'Wir beginnen am Westportal.', 'And that is the end of our walk.', 'Damit endet unser Gang.', true)`);
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
const types = {".js":"text/javascript",".css":"text/css",".json":"application/json",".jpg":"image/jpeg",".png":"image/png",".html":"text/html"};
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
let b;
try { b = await chromium.launch(); }
catch (e) { b = await chromium.launch({ channel: 'chrome' }); }
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
    if (pos !== 2) await ben.click(`[data-gap="${r.slot === 0 ? r.n : 0}"]`);
    await waitText(ana, 'Who made it?');
    if (pos === 1) { ok((await text(ana)).includes('Locked in'), "live: 'Locked in', result kept secret, artist question"); await shot(ana, '3-locked'); }
    const opts = await ana.$$eval('[data-artist]', bs => bs.map(b => b.dataset.artist));
    const artist = await run(async () => (await db.query(`select c.artist from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [gid, pos])).rows[0].artist);
    ok(opts.length === 4 && opts.includes(artist), `4 artist names incl. the right one (card ${pos})`);
    await ana.click(`[data-artist="${artist.replace(/"/g, '\\"')}"]`);
    if (pos === 1) ok((await ana.$$('[data-movement]')).length === 4 || (await ana.$$('[data-movement]')).length === 0, "movement question: 4 options (or none for this card)");
    await clickIf(ana, '[data-act="skip"]');
    if (pos === 2) {
      await ana.waitForSelector('.lw-crowd');
      ok(await ana.isVisible('.lw-art img') && (await ana.textContent('.lw-crowd')).includes('Locked guesses so far'),
         "live waiting (task 32): painting stays visible and crowd timeline renders after locking in");
      await ana.waitForSelector('[data-call-seat][data-call-ok="0"]');
      await ana.click('[data-call-seat][data-call-ok="0"]');
      await ana.click('[data-react-emoji="🎨"]');
      await ana.waitForSelector('.lw-feed-item');
      ok((await ana.textContent('.lw-feed')).includes('🎨'), "live waiting (task 32): emoji reaction appears in live feed");
      await shot(ana, 'w2-live-waiting-light');
      await ben.click(`[data-gap="${r.slot === 0 ? r.n : 0}"]`);
    }
    await clickIf(ben, '[data-act="skip"]');
    await waitText(ana, 'Where everyone placed it', 8000); await waitText(ben, 'Where everyone placed it', 8000);
    if (pos === 1) {
      const ta = await text(ana), tb = await text(ben);
      ok(ta.includes('Picture perfect!') && tb.includes('Back to the drawing board'), "reveal: Ana all right, Ben not");
      ok(tb.includes('Your guess') && !ta.includes('Your guess'), "reveal: a wrong card shows where it was placed and where it belongs");
      ok(/✓/.test(ta) && /Next card in/.test(ta), "reveal: right gap marked, countdown to the next card");
      ok((await ana.locator('.rr-row').count()) === 2, "reveal (task 32): per-player round breakdown shown");
      await shot(ana, '4-reveal'); await shot(ben, '4-reveal-dark');
    }
    if (pos === 2) {
      ok((await ana.locator('.rr-call-pill').count()) >= 1 && (await text(ana)).includes('25'),
         "reveal (task 32): accurate Call-It awards +25 bonus pill");
      await shot(ben, 'w2-live-reveal-dark');
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
  await ana.waitForSelector('.modal:has([data-act="on"])', { timeout: 5000 });
  ok((await ana.textContent('.modal:has([data-act="on"])')).includes("Know when it's your turn"), "new game over several days: asks to allow notifications");
  await shot(ana, '5b-async-ask-push');
  await ana.click('.modal [data-act="on"]'); await ana.waitForTimeout(400);
  ok(!(await ana.$('.modal:has([data-act="on"])')) && await ana.evaluate(() => window.__perm) === 'granted', "turned on: the sheet closes");
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
      ok((await text(ana)).includes('Card placed') && !(await ana.$('.go-verdict')) && !(await ana.$('.go-flash')), "async: no verdict, no flash before lock-in");
      ok(!(await ana.$('.go-timer')) || !(await ana.isVisible('.go-timer')), "timer off: no countdown");
      ok(await ana.evaluate(() => { const e = document.querySelector('.go-sticky'); return !e || getComputedStyle(e).position === 'sticky'; }), "countdown bar (when there is one) is sticky");
      ok(await ana.isVisible('.go-bonus-art'), "the painting stays visible next to the questions");
      const names = await ana.$$eval('[data-artist]', bs => bs.map(b => b.dataset.artist));
      const realA = await run(async () => (await db.query(`select c.artist from game_cards gc join cards c on c.id=gc.card_id where gc.game_id=$1 and gc.position=$2`, [gid2, pos])).rows[0].artist);
      const wrongA = names.find(n => n !== realA);
      // watch the whole picking time: no right/wrong marker may appear, not even for a frame
      await ana.evaluate(() => { window.__flash = 0; const chk = () => { if (document.querySelector('.go-pick.right, .go-pick.wrong, .go-verdict, .go-flash')) window.__flash++; };
        window.__rebuilt = 0; const pk = document.querySelector('#go-body .panel');
        new MutationObserver(() => { if (pk && !pk.isConnected) window.__rebuilt++; }).observe(document.getElementById('go-body'), { childList: true });
        new MutationObserver(chk).observe(document.body, { subtree: true, childList: true, attributes: true }); });
      const other = names.find(n => n !== realA && n !== wrongA);
      await ana.click(`[data-artist="${wrongA.replace(/"/g, '\\"')}"]`); await ana.waitForTimeout(150);
      ok((await ana.$$('[data-artist]')).length === names.length, "artist answers stay changeable after the first tap");
      await ana.click(`[data-artist="${other.replace(/"/g, '\\"')}"]`); await ana.waitForTimeout(150);
      ok(!(await ana.$('.go-pick.right, .go-pick.wrong')), "nothing shown as right or wrong while picking");
      await ana.click(`[data-artist="${wrongA.replace(/"/g, '\\"')}"]`);
      if (await ana.$('[data-movement]')) {
        ok(!(await ana.isVisible('[data-act="lock"]')), "no lock-in button until both are picked");
        const mv = await ana.$$('[data-movement]'); await mv[0].click(); await ana.waitForTimeout(100); await (await ana.$$('[data-movement]'))[1].click();
        ok(await ana.isVisible('[data-act="lock"]'), "lock-in button appears once both are picked");
        ok(await ana.evaluate(() => window.__rebuilt) === 0, "tapping answers doesn't redraw the screen");
        await ana.click('[data-act="lock"]');
      } else await ana.click('[data-act="skip"]');
      ok(await ana.evaluate(() => window.__flash) === 0, "no right/wrong flash at any moment before lock-in");
      await waitText(ana, 'Next');
      ok(!!(await ana.$('.go-pick.right')) && !!(await ana.$('.go-pick.wrong')), "the right answer shows green and my wrong pick red");
      await ana.waitForTimeout(1000); await shot(ana, '7b-async-bonus');
    } else await ana.click('[data-act="skip"]');
    await waitText(ana, 'Next');
    if (k === 0) { ok(/\d{4}/.test(await text(ana)), "then the card's year and story"); await shot(ana, '7-async-result'); }
    if (k === 1) { const tx = await text(ana); ok(tx.includes('Back to the drawing board') && tx.includes('Your guess') && /cards? off/.test(tx), "wrong placement shown, with where I put it");
      await ana.waitForTimeout(1000); await shot(ana, '7c-async-wrong'); }
    await ana.click('[data-act="next"]');
  }
  await waitText(ana, 'Turn done');
  ok((await text(ana)).includes('not yet'), "after 3 cards: turn done, Ben hasn't played");
  await shot(ana, '8-async-waiting');
  await ana.click('.go-close'); await ana.waitForTimeout(600);
  await ben.goto('http://localhost:8772/'); await ben.waitForTimeout(800);
  ok((await ben.textContent('#home-games')).includes('Your turn'), "Ben's home shows 'Your turn'");
  await shot(ben, '9-home-yourturn-dark');

  console.log("\ndaily challenge");
  const cleo = await page('cleo'); await cleo.goto('http://localhost:8772/?as=cleo'); await cleo.waitForTimeout(500);
  await cleo.click('[data-daily="play"]');
  await waitText(cleo, 'We start at the big west door');
  ok(true, "story daily: the start screen shows the intro");
  ok((await text(cleo)).includes('chapter 1') && (await cleo.locator('.go-start-chapter').count()) === 1,
     "look-back story: the start screen shows the start card's chapter");
  await shot(cleo, '10-daily-start');
  await cleo.click('[data-act="ready"]');
  const gid3 = await run(async () => (await db.query(`select id from games where kind='daily'`)).rows[0].id);
  for (let k = 0; k < 10; k++) {
    await waitText(cleo, 'Tap where it belongs');
    if (k === 0) await shot(cleo, '11-daily-card');
    if (k === 9) {
      const pinCheck = await cleo.evaluate(() => {
        const body = document.getElementById('go-body');
        const art = document.querySelector('.go-sticky .go-art');
        if (!body || !art) return null;
        const before = art.getBoundingClientRect();
        body.scrollTop = body.scrollHeight;
        const after = art.getBoundingClientRect();
        return {
          scrolled: body.scrollTop,
          horizOverflow: body.scrollWidth > body.clientWidth,
          beforeTop: before.top,
          afterTop: after.top,
          afterBottom: after.bottom,
          vh: window.innerHeight,
        };
      });
      ok(!!pinCheck && pinCheck.scrolled > 80 && !pinCheck.horizOverflow
         && Math.abs(pinCheck.afterTop - pinCheck.beforeTop) <= 1
         && pinCheck.afterBottom <= pinCheck.vh,
         `daily card 10: artwork stays pinned while scrolled (${pinCheck?.scrolled}px, diff=${Math.abs((pinCheck?.afterTop||0)-(pinCheck?.beforeTop||0)).toFixed(1)}px)`);
      await shot(cleo, '11c-daily-scrolled-light');
      await cleo.evaluate(() => { document.getElementById('go-body').scrollTop = 0; });
    }
    const pos = await run(async () => (await db.query(`select max(position)::int p from answers where game_id=$1 and player_id=$2`, [gid3, users.cleo])).rows[0].p);
    const r = await right(gid3, pos);
    await cleo.click(`[data-gap="${k % 3 === 2 ? (r.slot === 0 ? r.n : 0) : r.slot}"]`);
    await waitText(cleo, 'Who made it?');
    if (k === 9) {
      const bonusPin = await cleo.evaluate(() => {
        const body = document.getElementById('go-body');
        const img = document.querySelector('.go-sticky .go-bonus-art');
        if (!body || !img) return null;
        body.scrollTop = body.scrollHeight;
        const rect = img.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, w: rect.width, h: rect.height, vh: window.innerHeight };
      });
      ok(!!bonusPin && bonusPin.w > 0 && bonusPin.h > 0 && bonusPin.top >= 0 && bonusPin.bottom <= bonusPin.vh,
         "daily bonus picker: artwork stays visible inside viewport when scrolled");
    }
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
  await cleo.waitForSelector('.modal:has([data-h])', { timeout: 5000 });
  ok((await cleo.textContent('.modal:has([data-h])')).includes('reminder for the daily')
     && (await cleo.textContent('.modal:has([data-h])')).includes('Never ask me again')
     && (await cleo.locator('.modal:has([data-h]) [data-close]').count()) === 1,
     "first finished daily: asks about a daily reminder, with 'Not now' and 'Never ask me again'");
  await cleo.click('.modal [data-h="9"]'); await shot(cleo, '12a-daily-reminder-ask');
  await cleo.click('.modal [data-act="yes"]'); await cleo.waitForTimeout(600);
  ok(!(await cleo.$('.modal:has([data-h])')) && (await cleo.evaluate(() => window.CircOnline.pushSettings())).daily_hour === 9,
     "reminder saved for 09:00 and the sheet closes");
  ok((await text(cleo)).includes('end of our walk'), "results: the story's ending");
  {
    const recap = await cleo.evaluate(() => {
      const items = [...document.querySelectorAll('.go-recap .go-recap-item')];
      const years = items.map(li => parseInt(li.querySelector('b').textContent, 10));
      return { n: items.length, texts: items.filter(li => li.querySelector('.go-recap-text')).length,
               sorted: years.every((y, i) => i === 0 || years[i - 1] <= y) };
    });
    ok((await cleo.textContent('#go-body')).includes('The whole story, in order') && recap.n === 11 && recap.texts === 11 && recap.sorted,
       `results: the whole story in year order, every card with its chapter (${recap.n} cards, ${recap.texts} texts)`);
  }
  await cleo.waitForTimeout(1500);
  await cleo.emulateMedia({ colorScheme: 'dark' }); await cleo.waitForTimeout(300);
  await cleo.evaluate(() => document.querySelector('.go-recap')?.scrollIntoView());
  await shot(cleo, '12b-story-recap-dark');
  await cleo.emulateMedia({ colorScheme: 'light' }); await cleo.waitForTimeout(300);
  await cleo.evaluate(() => document.querySelector('.go-recap')?.scrollIntoView());
  await shot(cleo, '12c-story-recap-light');
  await cleo.evaluate(() => { document.getElementById('go-body').scrollTop = 0; });
  ok((await text(cleo)).includes('7 of 10 placed right'), "daily done: 7 of 10 right, score shown");
  ok(((await text(cleo)).match(/🟥/g) || []).length === 3 && ((await text(cleo)).match(/🟩/g) || []).length === 7, "daily done: 7 green and 3 red squares");
  await shot(cleo, '12-daily-done');
  const cleoCol = await cleo.evaluate(() => window.CircOnline.myCollection());
  ok(cleoCol && cleoCol.seen.length === 11 && cleoCol.correct.length === 7 && cleoCol.seen.every(id => /^daily:e2e:\d+$/.test(id)),
     `daily collection: returns 11 seen and 7 correct source_ids (${cleoCol?.seen?.length}/${cleoCol?.correct?.length})`);
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
  const dlg = await nb.$('.onb-overlay [role="dialog"]');
  ok(!!dlg && (await dlg.innerText()).toLowerCase().includes('which came first'), "first visit: the tutorial opens (new plain wording)");
  await shot(nb, '21-tutorial');
  for (let i = 0; i < 6; i++) { const b = await nb.$('.onb-overlay [role="dialog"] button:has-text("Next"), .onb-overlay [role="dialog"] button:has-text("Let\'s play")'); if (!b) break; await b.click(); await nb.waitForTimeout(250); }
  ok(!(await nb.$('.onb-overlay [role="dialog"]')) || !(await nb.isVisible('.onb-overlay [role="dialog"]')), "Next … Let's play closes it");
  await nb.reload(); await nb.waitForTimeout(1500);
  ok(!(await nb.$('.onb-overlay [role="dialog"]')) || !(await nb.isVisible('.onb-overlay [role="dialog"]')), "…and it doesn't come back");
  await nb.click('.tabbar [data-tab="profile"]'); await nb.waitForTimeout(600);
  await nb.click('#pf-howto'); await nb.waitForTimeout(500);
  ok(await nb.isVisible('.onb-overlay [role="dialog"]'), "Profile → How to play opens it again");

  // Helpers for unified Solo & Pack play on #game-online-screen
  const normImg = s => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const attrEsc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const findCardBySrc = (deck, src) => {
    const n = normImg(src);
    if (!n) return null;
    return deck.find(c => normImg(c.image_local) === n || normImg(c.image) === n || normImg(c.image_source) === n)
        || deck.find(c => normImg(c.image_local).split('?')[0] === n.split('?')[0]);
  };
  const readActiveCard = async (p, deck) => {
    const src = await p.getAttribute('.go-art img', 'src').catch(() => null);
    let card = findCardBySrc(deck, src);
    if (!card) {
      const typo = (await p.textContent('.go-typo').catch(() => '')).trim();
      card = deck.find(c => c.title === typo) || null;
    }
    return { card, src };
  };
  const readTlYears = p => p.$$eval('.go-tl b', bs => bs.map(b => parseInt(b.textContent, 10)).sort((a, b) => a - b));
  const readScore = async p => Number(((await p.textContent('#go-score')).replace(/,/g, '').match(/\d+/) || [0])[0]);

  async function playSoloCards(p, deck, rounds, {
    wantWrong = false,
    testFlag = false,
    testBonusLock = false,
    shotsPrefix = null,
    verifyTimelineGrowth = false,
    verifyPackImage = false,
  } = {}) {
    let startCard = null;
    const played = [];
    let expectedScore = 0;
    let didWrong = false;
    let justPlacedWrong = false;
    let prevTlLen = 0;
    let bonusTested = false;

    for (let pos = 1; pos <= rounds; pos++) {
      await waitText(p, 'Tap where it belongs');
      ok((await text(p)).includes(`Card ${pos} / ${rounds}`), `solo card ${pos}/${rounds} shown`);
      const ys = await readTlYears(p);
      const { card, src } = await readActiveCard(p, deck);
      ok(!!card, `solo card ${pos}: identified in deck`);

      if (pos === 1) {
        const hasTimer = (await p.$('.go-timer')) || (await p.$('#go-bar'));
        ok(!hasTimer, "solo: no timer or countdown bar");
        if (verifyTimelineGrowth) ok(ys.length === 1, "solo starts with 1 card on timeline");
        const startSrc = await p.getAttribute('.go-tl img', 'src').catch(() => null);
        startCard = findCardBySrc(deck, startSrc);
        if (verifyPackImage) {
          ok(!!src && /^(\/?art\/|https:\/\/)/.test(src),
             `pack solo: card image uses art/ or pack image_source (${src})`);
        }
        if (testFlag) {
          await p.waitForSelector('#go-flag');
          ok(await p.isVisible('#go-flag'), "solo: #go-flag is visible");
          await p.click('#go-flag');
          await p.waitForSelector('#report-modal:not(.hidden)');
          const repTxt = await p.textContent('#report-modal');
          const privHref = await p.getAttribute('#report-hint a', 'href').catch(() => null);
          ok(!!privHref && /^privacy-(en|de)\.html$/.test(privHref),
             "report modal: #report-hint contains a clickable privacy policy link");
          ok(!repTxt.includes(String(card.year)) && !repTxt.includes(card.artist),
             "solo: #go-flag opens #report-modal without leaking hidden card year or artist");
          await p.click('#cancel-report-btn');
          await p.waitForSelector('#report-modal', { state: 'hidden' });
        }
        if (shotsPrefix) await shot(p, `solo-play-${shotsPrefix}`);
      }
      if (shotsPrefix === 'dark' && pos === rounds) {
        const darkPin = await p.evaluate(() => {
          const body = document.getElementById('go-body');
          const art = document.querySelector('.go-sticky .go-art');
          if (!body || !art) return null;
          const before = art.getBoundingClientRect();
          body.scrollTop = body.scrollHeight;
          const after = art.getBoundingClientRect();
          return {
            scrolled: body.scrollTop,
            horizOverflow: body.scrollWidth > body.clientWidth,
            beforeTop: before.top,
            afterTop: after.top,
            afterBottom: after.bottom,
            vh: window.innerHeight,
          };
        });
        ok(!!darkPin && darkPin.scrolled > 40 && !darkPin.horizOverflow
           && Math.abs(darkPin.afterTop - darkPin.beforeTop) <= 1
           && darkPin.afterBottom <= darkPin.vh,
           `offline solo dark card ${pos}: artwork stays pinned while scrolled (${darkPin?.scrolled}px)`);
        await shot(p, 'solo-scrolled-dark');
        await p.evaluate(() => { document.getElementById('go-body').scrollTop = 0; });
      }

      if (pos === 2 && verifyTimelineGrowth && played[0]?.correct) {
        ok(ys.length === 2, "solo: timeline grew from 1 to 2 after placing card 1 right");
      }
      if (justPlacedWrong) {
        ok(ys.length === prevTlLen, `solo Hitster rule: timeline stays at ${prevTlLen} after wrong card`);
        justPlacedWrong = false;
      }

      let slot = ys.filter(y => y < card.year).length;
      let isWrong = false;
      if (pos >= 2 && wantWrong && !didWrong) {
        const wrongSlot = card.year > ys[0] ? 0 : card.year < ys[ys.length - 1] ? ys.length : -1;
        if (wrongSlot !== -1) {
          slot = wrongSlot;
          isWrong = true;
          didWrong = true;
          prevTlLen = ys.length;
          justPlacedWrong = true;
        }
      }

      await p.click(`[data-gap="${slot}"]`);
      await p.waitForFunction(() => {
        const el = document.getElementById('go-body');
        return el && !!el.querySelector('[data-act="lock"], [data-act="skip"], [data-act="next"]');
      });
      if (!isWrong) expectedScore += 1;

      const hasA = !!(await p.$('[data-artist]'));
      const hasM = !!(await p.$('[data-movement]'));
      let artistBonus = false;
      if (testBonusLock && !bonusTested && !isWrong && (hasA || hasM)) {
        bonusTested = true;
        const ptsBefore = await readScore(p);
        await p.evaluate(() => {
          window.__flash = 0;
          const chk = () => { if (document.querySelector('.go-pick.right, .go-pick.wrong, .go-verdict, .go-flash')) window.__flash++; };
          window.__obs = new MutationObserver(chk);
          window.__obs.observe(document.body, { subtree: true, childList: true, attributes: true });
        });

        let expectedBonus = 0;
        let pickedRight = false;
        let pickedWrong = false;

        if (hasA) {
          const aOpts = await p.$$eval('[data-artist]', bs => bs.map(b => b.dataset.artist));
          const wrongA = aOpts.find(a => a !== card.artist) || aOpts[0];
          await p.click(`[data-artist="${attrEsc(wrongA)}"]`);
          await p.waitForTimeout(100);
          ok((await p.$$('[data-artist]')).length === aOpts.length, "solo bonus: artist answers stay changeable");
          if (hasM) ok(!(await p.isVisible('[data-act="lock"]')), "solo bonus: no lock-in button until all questions picked");
          const targetA = aOpts.includes(card.artist) ? card.artist : (aOpts.find(a => a !== wrongA) || wrongA);
          await p.click(`[data-artist="${attrEsc(targetA)}"]`);
          await p.waitForTimeout(80);
          if (targetA === card.artist) { expectedBonus += 1; pickedRight = true; artistBonus = true; }
          else pickedWrong = true;
        }

        if (hasM) {
          const mOpts = await p.$$eval('[data-movement]', bs => bs.map(b => b.dataset.movement));
          const realM = await p.evaluate(m => window.CircStyles && window.CircStyles.groupOf(m), card.movement);
          await p.click(`[data-movement="${attrEsc(mOpts[0])}"]`);
          await p.waitForTimeout(80);
          // Pick a wrong movement when artist was already right so both green + red + +1 bonus are exercised
          const targetM = (hasA && pickedRight)
            ? (mOpts.find(m => m !== realM) || mOpts[0])
            : (mOpts.includes(realM) ? realM : mOpts[0]);
          await p.click(`[data-movement="${attrEsc(targetM)}"]`);
          await p.waitForTimeout(80);
          if (targetM === realM) { expectedBonus += 1; pickedRight = true; }
          else pickedWrong = true;
        }

        ok(!(await p.$('.go-pick.right, .go-pick.wrong')), "solo bonus: nothing shown as right or wrong before lock-in");
        ok(await p.isVisible('[data-act="lock"]'), "solo bonus: lock-in button appears once all present questions picked");
        await p.waitForTimeout(50);
        const flashBeforeLock = await p.evaluate(() => {
          if (window.__obs) window.__obs.disconnect();
          return window.__flash;
        });
        ok(flashBeforeLock === 0, "solo bonus: zero right/wrong flash before lock-in");
        await p.click('[data-act="lock"]');
        await p.waitForSelector('[data-act="next"]');
        ok(!!(await p.$('.go-pick.right')), "solo bonus: right answer highlighted green after lock-in");
        if (pickedWrong) ok(!!(await p.$('.go-pick.wrong')), "solo bonus: wrong answer highlighted red after lock-in");
        const ptsAfter = await readScore(p);
        expectedScore += expectedBonus;
        ok(ptsAfter === ptsBefore + 1 + expectedBonus, `solo bonus: the score shows the card only after lock-in, +${1 + expectedBonus} (${ptsBefore} -> ${ptsAfter})`);
        ok(await p.$eval('.go-verdict', (e, cls) => e.classList.contains(cls), pickedWrong ? 'part' : 'ok'), "solo bonus: partly right gets its own verdict colour");
        ok(!!(await p.$(".go-yearbox.ok")), "solo bonus: the year box says right spot");
        if (shotsPrefix) { await p.waitForTimeout(1000); } if (shotsPrefix) await shot(p, `solo-bonus-${shotsPrefix}`);
      } else if (await p.$('[data-act="skip"]')) {
        await p.click('[data-act="skip"]');
      }

      await p.waitForSelector('[data-act="next"]');
      if (isWrong) {
        const resTxt = await text(p);
        ok(/drawing board|first sketch|masterpiece/i.test(resTxt) && /stays off your timeline/i.test(resTxt) && resTxt.includes(String(card.year)) && resTxt.includes('Your guess'),
           "solo wrong card: verdict, 'stays off your timeline', the year and where I put it");
        if (card.trivia) {
          const tr = await p.textContent('.go-trivia').catch(() => '');
          ok(tr.trim().length > 0, "solo wrong card: shows trivia");
        }
      }
      if (pos === rounds) {
        ok((await p.textContent('[data-act="next"]')).includes('See results'), "solo last card: next button says 'See results'");
      }
      played.push({ card, correct: !isWrong, artistBonus });
      await p.click('[data-act="next"]');
    }

    await p.waitForSelector('[data-act="soloAgain"]');
    if (justPlacedWrong) {
      ok((await readTlYears(p)).length === prevTlLen, `solo Hitster rule: final timeline stays at ${prevTlLen}`);
    }
    if (shotsPrefix) await shot(p, `solo-done-${shotsPrefix}`);
    return { startCard, played, expectedScore, didWrong };
  }

  console.log("\nback button");
  const bk = await page('backy'); await bk.goto('http://localhost:8772/?as=backy'); await homeReady(bk);
  await bk.click('.tabbar [data-tab="ranks"]'); await bk.waitForTimeout(400);
  await bk.evaluate(() => history.back()); await bk.waitForTimeout(500);
  ok(await bk.evaluate(() => document.querySelector('.screen.active').id) === 'start-screen', "back on Ranks → home");
  await bk.evaluate(() => history.back()); await bk.waitForTimeout(500);
  ok((await bk.textContent('body')).includes('Swipe back once more'), "back on home → 'swipe back once more' hint, app stays open");
  await bk.click('#round-chips [data-rounds="5"]');
  ok((await bk.getAttribute('#round-chips [data-rounds="5"]', 'aria-pressed')) === 'true', "home: 5-card chip active");
  await bk.click('#start-btn');
  await bk.waitForSelector('#game-online-screen.active');
  await waitText(bk, 'Tap where it belongs');
  ok((await text(bk)).includes('Card 1 / 5'), "solo opens on #game-online-screen with Card 1 / 5");
  ok(!(await bk.$('.go-timer')) && !(await bk.$('#go-bar')), "solo: no timer or countdown bar");
  await bk.evaluate(() => history.back()); await bk.waitForTimeout(400);
  ok((await bk.textContent('body')).includes('Leave this game?') && await bk.evaluate(() => document.querySelector('.screen.active').id) === 'game-online-screen',
     "back in solo game → 'Leave this game?' and stays on #game-online-screen");
  await bk.click('[data-x="no"]'); await bk.waitForTimeout(300);
  ok(!(await bk.$('[data-x="no"]')) && await bk.evaluate(() => document.querySelector('.screen.active').id) === 'game-online-screen',
     "'Keep playing' closes dialog and stays in solo game");
  await bk.evaluate(() => history.back()); await bk.waitForTimeout(400);
  await bk.click('[data-x="yes"]'); await bk.waitForTimeout(400);
  ok(await bk.evaluate(() => document.querySelector('.screen.active').id) === 'start-screen', "'Leave the game' → home");

  console.log("\nsolo game (signed-in guest) + collection + gallery");
  const baseDeck = JSON.parse(fs.readFileSync(path.join(E, 'site', 'artline.json'), 'utf8'));
  const solo = await page('solo');
  await solo.goto('http://localhost:8772/?as=solo'); await homeReady(solo);
  await solo.evaluate(() => window.CircOnline.ensureGuest());
  await solo.reload(); await homeReady(solo);
  await solo.click('#round-chips [data-rounds="5"]');
  ok((await solo.getAttribute('#round-chips [data-rounds="5"]', 'aria-pressed')) === 'true', "solo: 5-card round chip selected");
  await solo.click('#start-btn');
  await solo.waitForSelector('#game-online-screen.active');
  const sRes = await playSoloCards(solo, baseDeck, 5, {
    wantWrong: true, testFlag: true, testBonusLock: true, shotsPrefix: 'light', verifyTimelineGrowth: true,
  });
  ok(sRes.didWrong, "solo: placed at least one card wrong to exercise Hitster rule");
  const sDoneTxt = await text(solo);
  const rightCount = sRes.played.filter(x => x.correct).length;
  const sqMatch = sDoneTxt.match(/[🟩🟥🎨]+/gu) || [];
  const sqJoined = sqMatch.join('');
  ok(sDoneTxt.includes(String(sRes.expectedScore)) && /placed right/i.test(sDoneTxt)
     && [...sqJoined].length === 5 && !!(await solo.$('[data-act="soloAgain"]'))
     && !!(await solo.$('[data-act="shareSolo"]')) && /your timeline/i.test(sDoneTxt)
     && (await readTlYears(solo)).length === 1 + rightCount,
     `solo finished: score ${sRes.expectedScore}, ${rightCount}/5 placed right, squares ${sqJoined}`);

  // Verify PGlite DB saved the solo game (mode = 'classic', rounds = 5, 6 solo_game_cards rows)
  let savedSolo = null;
  for (let w = 0; w < 25; w++) {
    const r = await run(() => db.query(`select * from solo_games where player_id = $1 order by created_at desc limit 1`, [users.solo]));
    if (r.rows.length) { savedSolo = r.rows[0]; break; }
    await solo.waitForTimeout(150);
  }
  ok(!!savedSolo && savedSolo.mode === 'classic' && savedSolo.rounds === 5
     && savedSolo.placements_correct === rightCount && savedSolo.score === sRes.expectedScore,
     "DB solo_games: saved mode='classic', rounds=5, exact score & placements_correct");
  if (savedSolo) {
    const sgc = await run(() => db.query(
      `select sgc.position, c.source_id, sgc.correct from solo_game_cards sgc join cards c on c.id = sgc.card_id where sgc.game_id = $1 order by sgc.position`,
      [savedSolo.id]));
    ok(sgc.rows.length === 6
       && sgc.rows.every((r, idx) => r.position === idx)
       && sgc.rows[0].correct === null
       && sgc.rows.slice(1).every((r, idx) => r.correct === sRes.played[idx].correct),
       "DB solo_game_cards: 6 rows (position 0..5) matching start card and played cards");
  }

  // Collection + Gallery check (updated naturally by Solo play, no track() / currentCard)
  const localCol = await solo.evaluate(() => JSON.parse(localStorage.getItem('circart-collection') || 'null'));
  const expectedSeenIds = [sRes.startCard?.id, ...sRes.played.map(x => x.card.id)].filter(Boolean);
  const expectedCorrectIds = sRes.played.filter(x => x.correct).map(x => x.card.id);
  ok(!!localCol && Array.isArray(localCol.seen) && Array.isArray(localCol.correct)
     && expectedSeenIds.every(id => localCol.seen.includes(id))
     && localCol.seen.length === expectedSeenIds.length
     && expectedCorrectIds.every(id => localCol.correct.includes(id))
     && localCol.correct.length === expectedCorrectIds.length
     && (!sRes.startCard || !localCol.correct.includes(sRes.startCard.id)),
     `collection: localStorage has ${localCol?.seen?.length} seen (start + 5 played) and ${localCol?.correct?.length} correct`);

  await solo.click('[data-act="home"]');
  await solo.waitForSelector('#start-screen.active');
  await solo.click('.tabbar [data-tab="gallery"]');
  await solo.waitForSelector('#gallery-count');
  await solo.waitForFunction(() => /^\d+ of \d+ discovered$/.test((document.getElementById('gallery-count') || {}).textContent?.trim() || ''));
  const gal = await solo.evaluate(() => ({
    total: document.querySelectorAll('#gallery-grid > .gallery-card').length,
    open: document.querySelectorAll('#gallery-grid > .gallery-card:not(.undiscovered)').length,
    gold: document.querySelectorAll('#gallery-grid > .gallery-card.mastered').length,
    count: (document.getElementById('gallery-count') || {}).textContent.trim(),
    hiddenBad: [...document.querySelectorAll('#gallery-grid > .undiscovered .gallery-details')].some(d => d.textContent.trim() !== '?'),
    hiddenZoom: document.querySelectorAll('#gallery-grid > .undiscovered .zoomable-img').length,
  }));
  ok(gal.total > 100 && gal.open === localCol.seen.length && gal.gold === localCol.correct.length
     && gal.count === `${localCol.seen.length} of ${gal.total} discovered` && !gal.hiddenBad && gal.hiddenZoom === 0,
     `gallery: ${gal.open} open, ${gal.gold} gold, counter '${gal.count}', undiscovered hidden without zoom`);

  console.log("\noffline solo (dark mode)");
  const off = await page('off', 'dark');
  await off.route('**/rpc', route => route.abort());
  await off.goto('http://localhost:8772/');
  await off.waitForSelector('#start-btn'); await off.waitForTimeout(400);
  await off.click('#round-chips [data-rounds="5"]');
  await off.click('#start-btn');
  await off.waitForSelector('#game-online-screen.active');
  await waitText(off, 'Tap where it belongs');
  const { card: offFirstCard } = await readActiveCard(off, baseDeck);
  ok(!!offFirstCard, "offline solo: first active card read before offline report check");
  await off.click('#go-flag');
  await off.waitForSelector('#report-modal:not(.hidden)');
  await off.fill('#report-text', 'Looks cropped before placement');
  await off.click('#send-report-btn');
  await off.waitForSelector('#report-fallback:not(.hidden)');
  const offFbTxt = await off.inputValue('#report-fallback-text');
  ok(!!offFbTxt && !offFbTxt.includes('Card ID:') && !offFbTxt.includes(String(offFirstCard.year)) && !offFbTxt.includes(offFirstCard.artist) && !offFbTxt.includes(offFirstCard.id),
     "offline solo: fallback report before placing card hides year, artist, and card id");
  await off.click('#cancel-report-btn');
  await off.waitForSelector('#report-modal', { state: 'hidden' });
  const offRes = await playSoloCards(off, baseDeck, 5, {
    wantWrong: false, testBonusLock: true, shotsPrefix: 'dark',
  });
  const offDoneTxt = await text(off);
  ok(offDoneTxt.includes(String(offRes.expectedScore)) && /placed right/i.test(offDoneTxt),
     "offline solo (dark mode): plays 5 cards + bonus lock-in cleanly to results");
  await off.click('[data-act="soloAgain"]');
  await waitText(off, 'Tap where it belongs');
  ok((await text(off)).includes('Card 1 / 5'), "offline solo: 'Play again' starts a new game cleanly");

  console.log("\nunlocked pack solo");
  const packDeck = JSON.parse(fs.readFileSync(path.join(E, 'site', 'packs', 'baroque-masters.json'), 'utf8')).cards;
  await run(() => db.query(
    `insert into player_packs (player_id, pack_id, seen) values ($1, 'baroque-masters', true) on conflict do nothing`,
    [users.dora]));
  await dora.goto('http://localhost:8772/?as=dora'); await homeReady(dora);
  await dora.click('#round-chips [data-rounds="5"]');
  await dora.click('.tabbar [data-tab="gallery"]');
  await dora.waitForSelector('#gallery-seg [data-gview="packs"]');
  await dora.click('#gallery-seg [data-gview="packs"]');
  await dora.waitForSelector('[data-open-pack="baroque-masters"]');
  await dora.click('[data-open-pack="baroque-masters"]');
  await dora.waitForSelector('[data-pack-play="baroque-masters"]');
  ok((await dora.$$('.gp-grid .gp-secret')).length === 0 && (await dora.$$('.gp-grid .gallery-card')).length === 25,
     "unlocked pack shows all 25 cards and 'Play this pack'");
  await dora.click('[data-pack-play="baroque-masters"]');
  await dora.waitForSelector('#game-online-screen.active');
  await waitText(dora, 'Tap where it belongs');
  ok((await dora.textContent('#go-title')).includes('Baroque Masters'),
     "pack solo: #game-online-screen opens with 'Baroque Masters' in #go-title");
  await playSoloCards(dora, packDeck, 5, { wantWrong: false, verifyPackImage: true });
  ok(!!(await dora.$('[data-act="soloAgain"]')), "pack solo: plays cleanly on #game-online-screen to finished screen");

  console.log("\nwave 1: streak + weekly painting (Gallery-only) + price mode + compact history + badges");
  // Cleo finished today's daily (Fri 2026-11-20 -> day 4 of week 2026-11-16)
  await cleo.goto('http://localhost:8772/?as=cleo'); await homeReady(cleo);
  await cleo.waitForSelector('#home-streak:not(.hidden)');
  const cleoStreak = await cleo.textContent('#home-streak').catch(() => '');
  const dailyHomeTxt = await cleo.textContent('#home-daily').catch(() => '');
  ok(!(await cleo.$('#home-painting')) && !dailyHomeTxt.includes('🔥') && cleoStreak.includes('1'),
     `home: single streak pill '${cleoStreak.trim()}', no duplicate flame in Daily, and no weekly frame on Home`);
  await shot(cleo, 'w1-home-clean-light');
  await cleo.click('#home-streak');
  await cleo.waitForSelector('[data-open-studio]');
  await cleo.click('[data-open-studio]');
  await cleo.waitForSelector('#gallery-restorations .wk-card');
  ok((await cleo.locator('#gallery-restorations .wk-patch').count()) === 1,
     "Gallery -> Restorations (Cleo): active weekly painting opens from streak popover with 1 cleaned patch");
  await shot(cleo, 'w1-gallery-painting-light');

  // Dora plays 3 days in week 2026-11-16 (Mon..Wed), guesses artist in Gallery, finishes Sunday -> Restorations
  const finishDailyAt = async (who, iso) => {
    await run(() => db.exec(`set circart.test_now = '${iso}'`));
    const dg = await rpc(who, 'play_daily', {});
    for (let i = 1; i <= dg.card_count; i++) {
      const nc = await rpc(who, 'next_card', { p_game: dg.id });
      const rs = await right(dg.id, nc.position);
      await rpc(who, 'answer', { p_game: dg.id, p_position: nc.position, p_slot: rs.slot });
      await rpc(who, 'pick_bonus', { p_game: dg.id, p_position: nc.position, p_artist: null, p_movement: null });
    }
  };
  await finishDailyAt('dora', '2026-11-16T12:00:00+01:00');
  await finishDailyAt('dora', '2026-11-17T12:00:00+01:00');
  await finishDailyAt('dora', '2026-11-18T12:00:00+01:00');
  await dora.goto('http://localhost:8772/?as=dora'); await homeReady(dora);
  await dora.click('.tabbar [data-tab="gallery"]');
  await dora.waitForSelector('#gallery-seg [data-gview="restorations"]');
  await dora.click('#gallery-seg [data-gview="restorations"]');
  await dora.waitForSelector('[data-wk-guess]');
  await dora.click('[data-wk-guess]');
  await dora.waitForSelector('[data-wk-choice]');
  await dora.click('[data-wk-choice]');
  await dora.waitForSelector('#wk-guess-res:not(.hidden)');
  ok((await dora.textContent('#wk-guess-res')).trim().length > 0, "weekly painting: 3-day artist guess in Gallery saves and shows feedback");
  await dora.click('body > .modal [data-close]');
  await dora.waitForSelector('body > .modal', { state: 'detached' }).catch(() => {});
  await finishDailyAt('dora', '2026-11-22T12:00:00+01:00');
  await dora.goto('http://localhost:8772/?as=dora'); await homeReady(dora);
  await dora.click('.tabbar [data-tab="gallery"]');
  await dora.waitForSelector('#gallery-seg [data-gview="restorations"]');
  await dora.click('#gallery-seg [data-gview="restorations"]');
  await dora.waitForSelector('#gallery-restorations .wk-rest-card');
  ok((await dora.textContent('#gallery-restorations')).includes('Vermeer')
     && (await dora.locator('#gallery-restorations .wk-rest-card').count()) >= 1,
     "Gallery -> Restorations lists completed Sunday weekly restoration");
  await shot(dora, 'w1-restorations-light');
  await run(() => db.exec('reset circart.test_now'));

  // Dora (ranked username dora_2) plays Price Mode (3 right, 3 wrong -> score 3, Ledger, Ranks Price tab)
  const priceDeck = JSON.parse(fs.readFileSync(path.join(E, 'site', 'price-deck.json'), 'utf8'));
  const findPriceCard = async p => {
    const src = await p.getAttribute('.price-chal .go-art img', 'src').catch(() => '');
    const tit = (await p.textContent('.price-chal-title')).trim();
    const norm = s => String(s || '').replace(/^\/+/, '');
    return priceDeck.find(c => norm(c.image_local) === norm(src)) || priceDeck.find(c => c.title === tit);
  };
  const findRefCard = async p => {
    const src = await p.getAttribute('.price-ref img', 'src').catch(() => '');
    const tit = (await p.textContent('.price-ref-title')).trim();
    const norm = s => String(s || '').replace(/^\/+/, '');
    return priceDeck.find(c => norm(c.image_local) === norm(src)) || priceDeck.find(c => c.title === tit);
  };
  await dora.goto('http://localhost:8772/?as=dora'); await homeReady(dora);
  await dora.waitForSelector('[data-price="play"]');
  await dora.click('[data-price="play"]');
  await dora.waitForSelector('[data-price-dir="higher"]');
  const firstChal = await findPriceCard(dora);
  ok(!!firstChal, "price mode: first challenger card loads with image and metadata");
  await dora.click('#go-flag');
  await dora.waitForSelector('#report-modal:not(.hidden)');
  const prRepTxt = await dora.textContent('#report-modal');
  ok(!prRepTxt.includes(firstChal.sale_price_display) && !prRepTxt.includes(firstChal.auction_house),
     "price mode: report modal before reveal hides sale price and auction house");
  await dora.click('#cancel-report-btn');
  await dora.waitForSelector('#report-modal', { state: 'hidden' });
  await shot(dora, 'w1-price-play-light');

  for (let round = 1; round <= 6; round++) {
    await dora.waitForSelector('[data-price-dir="higher"]');
    const refC = await findRefCard(dora);
    const chalC = await findPriceCard(dora);
    const shouldRight = round <= 3;
    const realHigher = chalC.price_usd_today >= refC.price_usd_today;
    const dir = shouldRight ? (realHigher ? 'higher' : 'lower') : (realHigher ? 'lower' : 'higher');
    await dora.click(`[data-price-dir="${dir}"]`);
    await dora.waitForSelector('[data-act="priceNext"]');
    if (round === 1) {
      const prTxt = await text(dora);
      ok(prTxt.includes('today') && prTxt.includes(String(chalC.sale_year)) && prTxt.includes(chalC.auction_house),
         "price mode: reveal shows sale year, today's price, and auction story");
      await shot(dora, 'w1-price-reveal-light');
    }
    await dora.click('[data-act="priceNext"]');
  }
  await dora.waitForSelector('.price-ledger-row');
  ok((await dora.locator('.price-ledger-row').count()) === 7 && (await text(dora)).includes('3'),
     "price mode: 3 mistakes ends run with score 3 and full 7-card auction ledger");
  await dora.click('[data-act="home"]'); await homeReady(dora);

  // Dark mode screenshot of Price Mode + Profile Compact History + Price Leaderboard
  await ben.goto('http://localhost:8772/?as=ben'); await homeReady(ben);
  await shot(ben, 'w1-home-clean-dark');
  await ben.click('.tabbar [data-tab="gallery"]');
  await ben.waitForSelector('#gallery-seg [data-gview="restorations"]');
  await ben.click('#gallery-seg [data-gview="restorations"]');
  await ben.waitForSelector('#gallery-restorations .wk-card');
  await shot(ben, 'w1-gallery-painting-dark');
  await ben.click('.tabbar [data-tab="play"]'); await homeReady(ben);
  await ben.waitForSelector('[data-price="play"]');
  await ben.click('[data-price="play"]');
  await ben.waitForSelector('[data-price-dir="higher"]');
  await shot(ben, 'w1-price-play-dark');
  await ben.click('.go-close');
  await ben.waitForSelector('[data-x="yes"]');
  await ben.click('[data-x="yes"]');
  await homeReady(ben);
  await ben.click('.tabbar [data-tab="profile"]');
  await ben.waitForSelector('#pf-history .hist-row');
  await shot(ben, 'w1-profile-history-dark');

  await dora.click('.tabbar [data-tab="ranks"]');
  await dora.waitForSelector('[data-rt="price"]');
  await dora.click('[data-rt="price"]');
  await dora.waitForFunction(() => (document.getElementById('ranks-board') || {}).innerText.includes('dora_2'));
  ok(true, "ranks: Price tab ranks dora_2");

  await dora.click('.tabbar [data-tab="profile"]');
  await dora.waitForSelector('#pf-history .hist-row');
  const compactCount = await dora.locator('#pf-history .hist-row').count();
  ok(compactCount >= 1 && compactCount <= 3, `profile: shows compact recent history (${compactCount} <= 3 rows)`);
  await dora.click('#pf-history-all');
  await dora.waitForSelector('.hist-modal [data-hf="price"]');
  await dora.click('.hist-modal [data-hf="price"]');
  await dora.waitForSelector('#hist-modal-list .hist-row');
  ok((await dora.locator('#hist-modal-list .hist-row').count()) >= 1, "profile: history modal filters by Price Mode cleanly");
  await dora.keyboard.press('Escape');
  await dora.evaluate(() => document.querySelectorAll('body > .modal').forEach(m => m.remove()));
  await shot(dora, 'w1-profile-history-light');

  console.log("\nwave 2: friends, friends leaderboards, friend profile + badges & direct async invites");
  await run(() => db.query(`update profiles set username = 'ana_1', is_guest = false where id = $1`, [users.ana]));
  await ana.goto('http://localhost:8772/?as=ana'); await homeReady(ana);
  await ana.click('.tabbar [data-tab="profile"]');
  await ana.waitForSelector('#pf-friend-add');
  await ana.fill('#pf-friend-add', 'dora_2');
  await ana.click('#pf-friend-submit');
  await ana.waitForFunction(() => (document.getElementById('pf-friends') || {}).innerText.includes('dora_2'));
  ok(true, "friends (task 33): Ana sends friend request to dora_2");

  await dora.click('.tabbar [data-tab="profile"]');
  await dora.waitForSelector('[data-fr-acc="ana_1"]');
  await dora.click('[data-fr-acc="ana_1"]');
  await dora.waitForSelector('[data-fr-open="ana_1"]');
  await dora.locator('#pf-friends').scrollIntoViewIfNeeded();
  await shot(dora, 'w2-friends-profile-light');
  await dora.click('[data-fr-open="ana_1"]');
  await dora.waitForSelector('body > .modal .modal-content');
  const frModalTxt = await dora.textContent('body > .modal .modal-content');
  ok(frModalTxt.includes('ana_1') && (await dora.locator('body > .modal .hist-row').count()) === 0,
     "friends (task 33): tapping friend opens read-only stats & badges sheet with zero play history");
  await dora.keyboard.press('Escape');
  await dora.evaluate(() => document.querySelectorAll('body > .modal').forEach(m => m.remove()));

  await dora.click('.tabbar [data-tab="ranks"]');
  await dora.waitForSelector('[data-rscope="friends"]');
  await dora.click('[data-rscope="friends"]');
  await dora.waitForFunction(() => (document.getElementById('ranks-board') || {}).innerText.includes('dora_2'));
  ok(true, "ranks (task 33): Friends filter scopes leaderboard cleanly");

  await dora.click('.tabbar [data-tab="play"]'); await homeReady(dora);
  await dora.click('#home-friends');
  await dora.waitForSelector('#fs-direct [data-inv-friend="ana_1"]');
  await dora.click('#fs-direct [data-inv-friend="ana_1"]');
  await dora.click('[data-send-inv]');
  await dora.waitForSelector('#game-online-screen.active');
  ok(true, "invites (task 44): Dora sends direct async invite to Ana");

  const anaDark = await page('ana', 'dark');
  await anaDark.goto('http://localhost:8772/?as=ana'); await homeReady(anaDark);
  await anaDark.waitForSelector('#home-invites [data-inv-accept]');
  await anaDark.locator('#home-invites').scrollIntoViewIfNeeded();
  await shot(anaDark, 'w2-home-invite-dark');
  await anaDark.click('#home-invites [data-inv-accept]');
  await anaDark.waitForSelector('#game-online-screen.active');
  await waitText(anaDark, 'Turn 1');
  ok((await text(anaDark)).toLowerCase().includes('start'), "invites (task 44): accepting invite auto-starts the async game");
  await anaDark.close();

  ok(errs.length === 0, "no script errors" + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) { console.log("  ✗ " + e.message.split('\n')[0]); fails++; }
console.log(fails ? `${fails} FAILED` : "all checks passed");
await b.close(); srv.close(); process.exit(fails ? 1 : 0);
