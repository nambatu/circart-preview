// CIRCArt — app shell: tabs, home, ranks, profile, theme, and the glue
// between the solo game (app.js) and the server (online.js).
//
// Load order in index.html: strings.js, supabase, online.js, app.js, shell.js.
// Works without online.js or without a connection: solo play, the gallery and
// the theme switch never depend on the server.

(function () {
    'use strict';

    const { t } = window.CircI18n;
    const online = () => (window.CircOnline && window.CircOnline.available()) ? window.CircOnline : null;
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    };

    // Multiplayer, daily challenge and leaderboards switch on here once their
    // screens are built (roadmap tasks 9–11). The server side is ready.
    const FEATURES = { daily: true, friends: true, leaderboards: true };

    // ─── theme ────────────────────────────────────────────────────────────
    const THEME_KEY = 'circart-theme';
    function applyTheme(choice) {
        if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
        else delete document.documentElement.dataset.theme;
        const dark = choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = dark ? '#16140f' : '#fcfbf9';
    }
    const themeChoice = () => store.get(THEME_KEY) || 'system';
    applyTheme(themeChoice());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(themeChoice()));

    function toast(msg) {
        const el = document.createElement('div');
        el.className = 'toast';
        el.setAttribute('role', 'status');
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2600);
    }

    // ─── tabs ─────────────────────────────────────────────────────────────
    const TAB_SCREENS = { play: 'start-screen', ranks: 'ranks-screen', gallery: 'gallery-screen', profile: 'profile-screen' };

    function showTab(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        if (name === 'gallery') {
            $('start-screen').classList.add('active');     // app.js's gallery handler expects to leave the start screen
            $('gallery-btn').click();
        } else {
            $(TAB_SCREENS[name]).classList.add('active');
        }
        if (name === 'play') renderHome();
        if (name === 'ranks') renderRanks();
        if (name === 'profile') renderProfile();
    }

    function syncTabs() {
        const active = document.querySelector('.screen.active');
        const tab = Object.keys(TAB_SCREENS).find(k => active && TAB_SCREENS[k] === active.id);
        document.body.classList.toggle('tabs-on', !!tab);
        document.querySelectorAll('.tabbar button').forEach(b => {
            if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
            else b.removeAttribute('aria-current');
        });
    }

    // ─── home ─────────────────────────────────────────────────────────────
    let deck = null;
    async function loadDeck() {
        if (deck) return deck;
        try { deck = await (await fetch('artline.json', { cache: 'no-cache' })).json(); } catch (e) { deck = []; }
        return deck;
    }

    async function renderHome() {
        if (online() && FEATURES.daily && !$('home-daily').firstElementChild) drawDaily($('home-daily'), online(), null, null);
        const sel = $('rounds-select');
        document.querySelectorAll('#round-chips .chip').forEach(c => {
            c.setAttribute('aria-pressed', String(c.dataset.rounds === sel.value));
        });

        // A different well-known work on the solo card each time you open the app.
        const img = $('home-hero-img');
        if (!img.dataset.set) {
            const cards = (await loadDeck()).filter(c => c.tier === 1 && c.image_local && c.visual_type === 'object');
            const c = cards[Math.floor(Math.random() * cards.length)];
            if (c) {
                img.src = c.image_local.replace(/\\/g, '/');
                img.alt = c.title;
                $('home-hero-caption').innerHTML = `<i>${esc(c.title)}</i><br>${esc(c.artist)}`;
                img.dataset.set = '1';
            }
        }

        const o = online();
        const u = o ? await o.user() : null;
        $('home-avatar').textContent = u ? (await profileName()).slice(0, 1).toUpperCase() : '?';
        renderDaily(o, u);
        renderRun(o, u);
        renderOnlineHome(o, u);
    }

    // ─── home: daily challenge + this month's challenge ───────────────────
    function untilText(iso, o) {
        const m = Math.max(0, Math.ceil((new Date(iso).getTime() - o.serverNow()) / 60000));
        return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
    }

    async function renderDaily(o, u) {
        const box = $('home-daily');
        if (!o || !FEATURES.daily) { box.innerHTML = ''; return; }
        // draw the card straight away so the page doesn't jump when the data arrives
        if (!box.firstElementChild) drawDaily(box, o, u, null);
        let d = null;
        if (u) { try { d = await o.dailySummary(); } catch (e) { d = null; } }
        drawDaily(box, o, u, d);
    }

    // ─── home: Monthly Run ─────────────────────────────────────────────────
    async function renderRun(o, u) {
        const box = $('home-run');
        if (!o || !FEATURES.daily) { box.innerHTML = ''; return; }
        if (!box.firstElementChild) drawRun(box, o, null);
        let r = null;
        if (u) { try { r = await o.runSummary(); } catch (e) { r = null; } }
        drawRun(box, o, r);
    }

    function drawRun(box, o, r) {
        const monthName = new Date().toLocaleString(window.CircI18n.lang, { month: 'long' }).toUpperCase();
        const pts = n => Number(n).toLocaleString();
        const line = !r ? t('run.rules')
            : r.best == null ? t('run.none', { days: r.days_left })
            : r.rank ? t('run.best', { score: pts(r.best), rank: r.rank, players: r.players })
            : t('run.bestUnranked', { score: pts(r.best) });
        box.innerHTML = `
          <section class="panel" style="padding:16px;display:flex;flex-direction:column;gap:8px">
            <div class="row" style="justify-content:space-between">
              <span class="eyebrow">${esc(t('run.eyebrow', { month: monthName }))}</span>
              ${r ? `<span class="note">${esc(t('run.daysLeft', { days: r.days_left }))}</span>` : ''}</div>
            <h2 class="serif" style="font-size:22px;line-height:1.2">${esc(r ? r.title : t('run.short'))}</h2>
            <p class="muted" style="font-size:14px">${esc(r ? r.description : t('run.rules'))}</p>
            ${r ? `<p style="font-weight:600">${esc(line)}</p>` : ''}
            ${r && r.above ? `<p class="note">🎯 ${esc(t('run.above', { name: r.above.username, score: pts(r.above.value) }))}</p>` : ''}
            <button class="btn ${r && r.best != null ? 'dark' : 'primary'} block" data-run="play">${esc(r && r.active ? t('run.continue') : t('run.play'))}</button>
          </section>`;
        box.querySelector('[data-run="play"]').addEventListener('click', async e => {
            const b = e.currentTarget; b.disabled = true;
            try {
                const before = r && r.best;
                const g = await o.startRun();
                cachedProfile = null;
                window.CircGame.open(g.id, { prevBest: before == null ? null : before });
            } catch (err) { b.disabled = false; toast(err.message || t('common.error')); }
        });
    }

    function drawDaily(box, o, u, d) {
        const status = d ? d.status : 'not_started';
        const me = d && d.me;
        const btn = status === 'done'
            ? `<button class="btn outline block" data-daily="results">${esc(t('game.results'))}</button>`
            : `<button class="btn primary block" data-daily="play">${esc(status === 'in_progress' ? t('home.daily.continue') : t('home.daily.play'))}</button>`;
        const done = status === 'done' && me ? `<p class="serif" style="font-size:18px">${esc(me.rank
            ? t('home.daily.done', { score: me.score.toLocaleString(), rank: me.rank })
            : t('home.daily.doneUnranked', { score: me.score.toLocaleString() }))}</p>` : '';
        const hard = d && d.yesterdays_hardest;
        const month = d && d.month;
        const monthName = new Date().toLocaleString(window.CircI18n.lang, { month: 'long' }).toUpperCase();
        box.innerHTML = `
          <section class="panel strong" style="padding:16px;display:flex;flex-direction:column;gap:8px">
            <div class="row" style="justify-content:space-between">
              <span class="eyebrow">${esc(t('home.daily.eyebrow', { no: d ? d.challenge_no : '·' }))}</span>
              ${d && d.streak > 0 ? `<span class="pill" title="daily streak">🔥 ${esc(d.streak === 1 ? t('home.streak1') : t('home.streak', { n: d.streak }))}</span>` : ''}
            </div>
            <h2 class="serif" style="font-size:22px;line-height:1.2">${esc(t('home.daily.title'))}</h2>
            ${done || `<p class="muted" style="font-size:14px">${esc(t('home.daily.sub'))}</p>`}
            ${btn}
            ${d ? `<p class="note">${esc(t('home.daily.resets', { time: untilText(d.resets_at, o) }))}</p>` : ''}
            ${hard ? `<div class="row" style="gap:10px;border-top:1px solid var(--line);padding-top:10px">
                ${hard.image_url ? `<img src="${esc(hard.image_url)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:6px">` : ''}
                <span class="note"><b>${esc(t('home.daily.hardest'))}</b><br>${esc(t('home.daily.hardestPct', { title: hard.title, pct: hard.percent_right }))} (${esc(hard.year)})</span></div>` : ''}
          </section>
          ${false ? `<button class="game-row" data-daily="month" style="flex-direction:column;align-items:flex-start;gap:2px">
              <span class="eyebrow">${esc(t('home.month.eyebrow', { month: monthName }))}</span>
              <b>${esc(month.title)}</b>
              <span class="note">${esc(month.description)}</span>
              <span class="note">${esc(month.me && month.me.rank ? t('home.month.rank', { rank: month.me.rank, days: month.days_left }) : t('home.month.norank', { days: month.days_left }))}</span>
            </button>` : ''}`;
        box.querySelectorAll('[data-daily]').forEach(b => b.addEventListener('click', async () => {
            if (b.dataset.daily === 'month') { ranksTab = 'month'; return showTab('ranks'); }
            b.disabled = true;
            try {
                const g = await o.playDaily();
                cachedProfile = null;
                window.CircGame.open(g.id, { challengeNo: g.challenge_no });
            } catch (e) { b.disabled = false; toast(e.message || t('common.error')); }
        }));
    }

    // ─── home: games with friends ─────────────────────────────────────────
    async function renderOnlineHome(o, u) {
        const box = $('home-online');
        if (!o || !FEATURES.friends) { box.innerHTML = ''; return; }
        let games = [];
        if (u) { try { games = await o.myGames(); } catch (e) { games = []; } }
        const mine = games.filter(g => !g.dropped);
        const turns = mine.filter(g => g.my_turn).length;
        const left = iso => {
            const m = Math.max(0, Math.ceil((new Date(iso).getTime() - o.serverNow()) / 60000));
            return m >= 60 ? Math.floor(m / 60) + ' h' : m + ' min';
        };
        const names = g => g.others.length === 0 ? '—'
            : g.others.length <= 2 ? g.others.join(' & ') : g.others.slice(0, 2).join(', ') + ' +' + (g.others.length - 2);
        const info = g => g.status === 'lobby' ? t('home.lobbyInfo', { code: g.code })
            : g.status === 'finished' ? t('home.finished', { rank: g.my_rank || '–' })
            : g.kind === 'live' ? t('home.liveNow')
            : g.my_turn ? t('home.turnInfo', { turn: g.turn, turns: g.turns, left: left(g.turn_deadline) })
            : t('home.waitingOthers', { turn: g.turn, turns: g.turns });

        box.innerHTML = `
          ${mine.length ? `<section style="display:flex;flex-direction:column;gap:8px">
            <div class="row"><h2 class="label">${esc(t('home.yourGames'))}</h2>${turns ? `<span class="badge">${turns}</span>` : ''}</div>
            ${mine.map(g => `<button class="game-row" data-game="${esc(g.id)}">
                <span style="flex:1;min-width:0"><b style="display:block">${esc(names(g))}</b>
                  <span class="note">${esc(info(g))}</span></span>
                ${g.my_turn ? `<span class="badge">${esc(t('game.yourTurn'))}</span>` : ''}</button>`).join('')}
          </section>` : ''}
          <button class="btn dark block" id="home-friends">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/></svg>
            ${esc(t('friends.title'))}</button>
          <form class="row" id="home-join" style="margin:0">
            <label class="note" for="home-code" style="flex-shrink:0">${esc(t('home.code.label'))}</label>
            <input id="home-code" class="input code-input" maxlength="4" placeholder="K7Q2" autocomplete="off" autocapitalize="characters">
            <button class="btn quiet" type="submit">${esc(t('home.code.join'))}</button>
          </form>`;
        box.querySelectorAll('[data-game]').forEach(b => b.addEventListener('click', () => window.CircGame.open(b.dataset.game)));
        $('home-friends').addEventListener('click', friendsSheet);
        $('home-join').addEventListener('submit', e => { e.preventDefault(); joinByCode($('home-code').value); });
    }

    function sheet(html) {
        const m = document.createElement('div');
        m.className = 'modal';
        m.innerHTML = `<div class="modal-content" role="dialog" aria-modal="true" style="display:flex;flex-direction:column;gap:12px">${html}
            <button class="btn link" data-close>${esc(t('common.close'))}</button></div>`;
        m.addEventListener('click', e => { if (e.target === m || e.target.hasAttribute('data-close')) m.remove(); });
        document.body.appendChild(m);
        return m;
    }

    async function currentName() {
        const o = online();
        return (o && await o.user()) ? await profileName() : '';
    }

    async function friendsSheet() {
        const name = await currentName();
        const m = sheet(`
          <h2 class="serif" style="font-size:24px">${esc(t('friends.title'))}</h2>
          <p class="muted" style="font-size:14px">${esc(t('friends.text'))}</p>
          <label class="label" for="fs-name">${esc(t('friends.name'))}</label>
          <input id="fs-name" class="input" maxlength="24" value="${esc(name === '?' ? '' : name)}">
          <button class="choice strong" data-kind="live"><span class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/></svg></span>
            <span><b>${esc(t('friends.live'))}</b><br><span class="note">${esc(t('friends.liveText'))}</span></span></button>
          <button class="choice" data-kind="async"><span class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></span>
            <span><b>${esc(t('friends.async'))}</b><br><span class="note">${esc(t('friends.asyncText'))}</span></span></button>`);
        m.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            try {
                const g = await online().createGame(b.dataset.kind, { displayName: m.querySelector('#fs-name').value.trim() || null });
                m.remove();
                cachedProfile = null;
                window.CircGame.open(g.id);
            } catch (e) { b.disabled = false; toast(e.message || t('common.error')); }
        }));
    }

    async function joinByCode(code) {
        code = (code || '').trim().toUpperCase();
        const o = online();
        if (!o || code.length !== 4) return;
        const go = async name => {
            try { const id = await o.joinGame(code, name); cachedProfile = null; window.CircGame.open(id); }
            catch (e) { toast(e.message || t('common.error')); }
        };
        if (await o.user()) return go(null);
        // first time: ask for a name before joining
        const m = sheet(`<h2 class="serif" style="font-size:22px">${esc(t('game.joinWith'))} ${esc(code)}</h2>
          <label class="label" for="js-name">${esc(t('friends.name'))}</label>
          <input id="js-name" class="input" maxlength="24" autocomplete="nickname">
          <button class="btn primary block" id="js-go">${esc(t('home.code.join'))}</button>`);
        m.querySelector('#js-name').focus();
        m.querySelector('#js-go').addEventListener('click', () => { const n = m.querySelector('#js-name').value.trim(); m.remove(); go(n || null); });
    }

    let cachedProfile = null;
    async function profileName() {
        try { cachedProfile = cachedProfile || await online().getProfile(); return cachedProfile.display_name || '?'; }
        catch (e) { return '?'; }
    }

    // ─── ranks: leaderboards + your stats ─────────────────────────────────
    let ranksTab = 'today';
    async function renderRanks() {
        const box = $('ranks-body');
        const o = online();
        if (!o) { box.innerHTML = `<p class="muted">${esc(t('ranks.offline'))}</p>`; return; }
        const u = await o.user();
        if (!u) { box.innerHTML = `<p class="muted">${esc(t('ranks.signIn'))}</p>`; return; }
        const tabs = ['today', 'month', 'allTime'];
        box.innerHTML = `
          <div class="seg" role="group" aria-label="${esc(t('ranks.title'))}" style="align-self:flex-start">
            ${tabs.map(k => `<button data-rt="${k}" aria-pressed="${ranksTab === k}">${esc(t('ranks.' + k))}</button>`).join('')}
          </div>
          <div id="ranks-board" style="margin-top:12px"><p class="muted">…</p></div>
          <div id="ranks-stats" style="margin-top:20px"></div>`;
        box.querySelectorAll('[data-rt]').forEach(b => b.addEventListener('click', () => { ranksTab = b.dataset.rt; renderRanks(); }));
        renderBoard(o);
        renderStats(o);
    }

    function boardList(entries, value) {
        if (!entries.length) return `<p class="muted">${esc(t('ranks.nobody'))}</p>`;
        return `<ol class="go-stand">${entries.map(e => `
            <li class="${e.is_me ? 'me' : ''}"><span class="go-rank" style="width:28px">${e.rank}</span>
              <span class="go-name">${esc(e.username)}${e.is_me ? ' ' + esc(t('game.you')) : ''}</span>
              <span class="go-pts">${esc(value(e))}</span></li>`).join('')}</ol>`;
    }

    const MEDALS = ['🥇', '🥈', '🥉'];
    const monthLabel = iso => new Date(iso + 'T12:00:00').toLocaleString(window.CircI18n.lang, { month: 'long', year: 'numeric' });

    // last month's podium (from 010); hidden while there's nothing to show
    function winnersStrip(w) {
        if (!w || !w.entries || !w.entries.length) return '';
        return `<section class="panel winners" style="margin-bottom:10px">
            <div class="eyebrow">${esc(t('ranks.winnersTitle', { month: monthLabel(w.month) }))}</div>
            <div class="note">${esc(w.title)}</div>
            <ol>${w.entries.map(e => `<li class="${e.is_me ? 'me' : ''}"><span class="medal">${MEDALS[e.rank - 1] || e.rank}</span>
              <b>${esc(e.username)}</b><span class="go-pts">${Number(e.value).toLocaleString()}</span></li>`).join('')}</ol></section>`;
    }

    async function renderBoard(o) {
        const el = $('ranks-board');
        const pts = n => t('ranks.pts', { n: Number(n).toLocaleString() });
        try {
            if (ranksTab === 'today') {
                const b = await o.dailyLeaderboard();
                el.innerHTML = `<p class="note" style="margin-bottom:8px">${esc(t('game.daily', { no: b.challenge_no }))} · ${esc(b.players === 1 ? t('ranks.players1') : t('ranks.players', { n: b.players }))}</p>
                  ${boardList(b.entries, e => pts(e.score))}`;
            } else if (ranksTab === 'month') {
                const [b, w] = await Promise.all([o.monthlyLeaderboard(), o.monthlyWinners ? o.monthlyWinners().catch(() => null) : null]);
                const fmt = v => b.metric === 'accuracy' ? v + '%' : b.metric === 'best_streak' || b.metric === 'artists_named' ? String(v) : pts(v);
                b.me = b.me && b.me.ranked === false ? null : b.me;      // guests: their best shows on the home card
                el.innerHTML = `${winnersStrip(w)}<section class="panel" style="padding:14px;margin-bottom:10px">
                    <b class="serif" style="font-size:18px">${esc(b.title)}</b>
                    <p class="note">${esc(b.description)} · ${esc(t('ranks.daysLeft', { n: b.days_left }))}</p></section>
                  ${boardList(b.entries, e => fmt(e.value))}
                  ${b.me && !b.entries.some(e => e.is_me) ? `<p class="note" style="margin-top:8px">${esc(t('ranks.youRank', { rank: b.me.rank, value: fmt(b.me.value) }))}</p>` : ''}`;
            } else {
                const b = await o.alltimeLeaderboard();
                el.innerHTML = `${boardList(b.entries, e => pts(e.points))}
                  ${b.me && !b.entries.some(e => e.is_me) ? `<p class="note" style="margin-top:8px">${esc(t('ranks.youRank', { rank: b.me.rank, value: pts(b.me.points) }))}</p>` : ''}`;
            }
            const p = cachedProfile || await o.getProfile().catch(() => null);
            if (p && (p.is_guest || !p.username)) el.insertAdjacentHTML('beforeend', `<p class="note" style="margin-top:8px">${esc(t('ranks.notRanked'))}</p>`);
        } catch (e) {
            el.innerHTML = `<p class="muted">${esc(t('ranks.offline'))}</p>`;
        }
    }

    async function renderStats(o) {
        const el = $('ranks-stats');
        try {
            const s = await o.myStats();
            const solo = s.solo || {};
            const pct = v => v == null ? '–' : Math.round(v * 100) + '%';
            const online = s.cards_placed ? `
              <section class="panel" style="padding:16px;margin-bottom:14px">
                <h2 class="label" style="margin-bottom:12px">${esc(t('ranks.online'))}</h2>
                <div class="stats-grid">
                  <div class="stat"><b>${s.games_played}</b><span>${esc(t('ranks.games'))}</span></div>
                  <div class="stat"><b>${pct(s.accuracy)}</b><span>${esc(t('ranks.accuracy'))}</span></div>
                  <div class="stat"><b>${s.wins}</b><span>${esc(t('ranks.wins'))}</span></div>
                  <div class="stat"><b>${Number(s.total_points).toLocaleString()}</b><span>${esc(t('ranks.points'))}</span></div>
                  <div class="stat"><b>${s.best_streak}</b><span>${esc(t('ranks.bestStreak'))}</span></div>
                  <div class="stat"><b>${s.daily_streak}</b><span>${esc(t('ranks.dailyStreak'))}</span></div>
                </div></section>` : '';
            const soloBox = solo.games ? `
              <section class="panel" style="padding:16px">
                <h2 class="label" style="margin-bottom:12px">${esc(t('ranks.solo'))}</h2>
                <div class="stats-grid">
                  <div class="stat"><b>${solo.games}</b><span>${esc(t('ranks.games'))}</span></div>
                  <div class="stat"><b>${pct(solo.accuracy)}</b><span>${esc(t('ranks.accuracy'))}</span></div>
                  <div class="stat"><b>${solo.cards_placed}</b><span>${esc(t('ranks.cards'))}</span></div>
                  <div class="stat"><b>${solo.best_score}</b><span>${esc(t('ranks.bestScore'))}</span></div>
                  <div class="stat"><b>${solo.best_streak}</b><span>${esc(t('ranks.bestStreak'))}</span></div>
                  <div class="stat"><b>${solo.total_score}</b><span>${esc(t('ranks.points'))}</span></div>
                </div></section>` : '';
            el.innerHTML = online || soloBox
                ? `<h2 class="label" style="margin-bottom:10px">${esc(t('ranks.yourStats'))}</h2>${online}${soloBox}`
                : `<p class="muted">${esc(t('ranks.empty'))}</p>`;
        } catch (e) { el.innerHTML = ''; }
    }

    // ─── profile ──────────────────────────────────────────────────────────
    let deleteArmed = false;

    async function renderProfile() {
        const box = $('profile-body');
        const o = online();
        const u = o ? await o.user() : null;
        let p = null;
        if (u) { try { p = cachedProfile = await o.getProfile(); } catch (e) { p = null; } }
        const theme = themeChoice();

        const account = !o ? `<p class="note">${esc(t('profile.offline'))}</p>`
          : !u ? `
            <section class="panel strong" style="padding:16px;display:flex;flex-direction:column;gap:10px">
              <h2 style="font-size:18px">${esc(t('profile.signedOutTitle'))}</h2>
              <p class="muted" style="font-size:14px">${esc(t('profile.signedOutText'))}</p>
              ${signInButtons()}
            </section>`
          : `
            <div class="row" style="gap:14px">
              <span class="avatar" style="width:56px;height:56px;font-size:22px;display:flex;align-items:center;justify-content:center;cursor:default" aria-hidden="true">${esc((p && p.display_name || '?').slice(0, 1).toUpperCase())}</span>
              <div>
                <h1 class="serif" style="font-size:24px;line-height:1.2">${esc(p ? p.display_name : '')}</h1>
                <div class="muted" style="font-size:14px">${esc(p && p.is_guest ? t('profile.guestName') : t('profile.signedInAs'))}</div>
              </div>
            </div>
            ${p && p.is_guest ? `
            <section class="panel strong" style="padding:16px;display:flex;flex-direction:column;gap:10px">
              <h2 style="font-size:17px">${esc(t('profile.guestTitle'))}</h2>
              <p class="muted" style="font-size:14px">${esc(t('profile.guestText'))}</p>
              ${signInButtons()}
            </section>` : ''}
            <section class="panel" style="padding:16px;display:flex;flex-direction:column;gap:12px">
              <label class="label" for="pf-name">${esc(t('profile.name'))}</label>
              <div class="row"><input id="pf-name" class="input" maxlength="24" value="${esc(p ? p.display_name : '')}">
                <button class="btn quiet" id="pf-name-save">${esc(t('profile.save'))}</button></div>
              ${p && !p.is_guest ? `
              <label class="label" for="pf-user">${esc(t('profile.username'))}${p.username ? '' : ' · ' + esc(t('profile.usernameNeeded'))}</label>
              <div class="row"><input id="pf-user" class="input" maxlength="20" autocapitalize="off" autocomplete="username" value="${esc(p.username || '')}">
                <button class="btn quiet" id="pf-user-save">${esc(t('profile.save'))}</button></div>
              <p class="note">${esc(t('profile.usernameHint'))}</p>` : ''}
            </section>`;

        box.innerHTML = `
          ${account}
          <div id="pf-badges"></div>
          <section class="panel list" aria-label="Settings">
            <div><span>${esc(t('profile.appearance'))}</span>
              <span class="seg" role="group" aria-label="${esc(t('profile.appearance'))}">
                ${['system', 'light', 'dark'].map(k => `<button data-theme="${k}" aria-pressed="${theme === k}">${esc(t('profile.theme.' + k))}</button>`).join('')}
              </span></div>
            ${o && o.pushSupported && o.pushSupported() ? `<button id="pf-push"><span>${esc(t('profile.notifications'))}</span>
              <span class="value" id="pf-push-v">…</span></button>` : ''}
            ${o && o.previewTestPush && document.querySelector('script[src="preview.js"]') && o.pushSupported && o.pushSupported()
              ? `<button id="pf-testpush"><span>${esc(t('profile.testPush'))}</span><span class="value" aria-hidden="true">🔔</span></button>` : ''}
            <div><span>${esc(t('profile.language'))}</span>
              <span class="seg" role="group" aria-label="${esc(t('profile.language'))}">
                ${window.CircI18n.languages().map(l => `<button data-lang="${l.code}" aria-pressed="${l.code === window.CircI18n.lang}">${esc(l.name)}</button>`).join('')}
              </span></div>
          </section>
          <section class="panel list" aria-label="More">
            <button id="pf-feedback"><span>${esc(t('profile.feedback'))}</span><span class="value" aria-hidden="true">›</span></button>
            <button id="pf-about"><span>${esc(t('profile.about'))}</span><span class="value" aria-hidden="true">›</span></button>
            ${u ? `<button id="pf-signout"><span>${esc(t('profile.signOut'))}</span></button>
                   <button id="pf-delete" class="danger"><span>${esc(deleteArmed ? t('profile.deleteConfirm') : t('profile.delete'))}</span></button>` : ''}
          </section>`;
        wireProfile(o);
        if (u && o.myBadges) o.myBadges().then(bs => {
            const el = $('pf-badges');
            if (!el || !bs || !bs.length) return;
            el.innerHTML = `<section class="panel" style="padding:14px;display:flex;flex-direction:column;gap:8px">
              <h2 class="label">${esc(t('profile.badges'))}</h2>
              ${bs.map(b => `<div class="badge-row"><span class="medal">${MEDALS[b.rank - 1] || '🏅'}</span>
                <span><b>${esc(monthLabel(b.month))}</b> · ${esc(b.title)}<br><span class="note">${esc(t('profile.badgeLine', { rank: b.rank, score: Number(b.value).toLocaleString() }))}</span></span></div>`).join('')}
            </section>`;
        }).catch(() => {});
    }

    function signInButtons() {
        return `
          <button class="btn outline block" id="pf-google">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M16.5 12H12"/></svg>
            ${esc(t('profile.google'))}</button>
          <div id="pf-email-box" class="hidden" style="display:flex;flex-direction:column;gap:8px">
            <label class="note" for="pf-email">${esc(t('profile.email'))}</label>
            <div class="row"><input id="pf-email" class="input" type="email" autocomplete="email" placeholder="${esc(t('profile.emailPlaceholder'))}">
              <button class="btn quiet" id="pf-email-send">${esc(t('profile.emailSend'))}</button></div>
          </div>
          <button class="btn link" id="pf-email-toggle">${esc(t('profile.email'))}</button>`;
    }

    function wireProfile(o) {
        const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
        const guard = fn => async () => { try { await fn(); } catch (e) { toast(e.message || t('common.error')); } };

        document.querySelectorAll('#profile-body [data-lang]').forEach(b => b.addEventListener('click', () => {
            window.CircI18n.setLanguage(b.dataset.lang);
            renderProfile();
        }));
        document.querySelectorAll('#profile-body .seg button[data-theme]').forEach(b => b.addEventListener('click', () => {
            store.set(THEME_KEY, b.dataset.theme);
            applyTheme(b.dataset.theme);
            renderProfile();
        }));
        on('pf-feedback', () => $('open-report-btn').click());
        on('pf-testpush', guard(async () => {
            if (!(await o.pushOn())) return toast(t('profile.testPushOff'));
            toast(t((await o.previewTestPush()) ? 'profile.testPushSent' : 'profile.testPushOff'));
        }));
        if ($('pf-push')) {
            let pushIsOn = false;
            o.pushOn().then(v => { pushIsOn = v; $('pf-push-v').textContent = t(v ? 'profile.notifOn' : 'profile.notifOff'); }).catch(() => {});
            on('pf-push', guard(async () => {
                if (pushIsOn) await o.disablePush(); else await o.enablePush();
                renderProfile();
            }));
        }
        on('pf-about', showAbout);
        if (!o) return;
        on('pf-google', guard(() => o.signInWithGoogle()));
        on('pf-email-toggle', () => { $('pf-email-box').classList.remove('hidden'); $('pf-email-toggle').classList.add('hidden'); $('pf-email').focus(); });
        on('pf-email-send', guard(async () => { await o.signInWithEmail($('pf-email').value.trim()); toast(t('profile.emailSent')); }));
        on('pf-name-save', guard(async () => { await o.updateProfile({ displayName: $('pf-name').value }); cachedProfile = null; toast(t('profile.saved')); renderProfile(); }));
        on('pf-user-save', guard(async () => { await o.updateProfile({ username: $('pf-user').value.trim() }); toast(t('profile.saved')); renderProfile(); }));
        on('pf-signout', guard(async () => { await o.signOut(); cachedProfile = null; renderProfile(); }));
        on('pf-delete', guard(async () => {
            if (!deleteArmed) { deleteArmed = true; renderProfile(); setTimeout(() => { deleteArmed = false; }, 8000); return; }
            deleteArmed = false;
            await o.deleteAccount();
            cachedProfile = null;
            renderProfile();
        }));
    }

    function showAbout() {
        const m = document.createElement('div');
        m.className = 'modal';
        m.innerHTML = `<div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="about-h">
            <h2 id="about-h">${esc(t('about.title'))}</h2><p>${esc(t('about.text'))}</p>
            <div class="modal-actions"><button class="primary-btn small-btn">${esc(t('about.close'))}</button></div></div>`;
        m.addEventListener('click', e => { if (e.target === m || e.target.tagName === 'BUTTON') m.remove(); });
        document.body.appendChild(m);
        m.querySelector('button').focus();
    }

    // ─── feedback: save to the database, email as the fallback ────────────
    // app.js's own handler (mailto) only runs if saving fails.
    let fallback = false;
    function hookFeedback() {
        const send = $('send-report-btn');
        send.addEventListener('click', async (e) => {
            if (fallback) { fallback = false; return; }          // let app.js handle it
            const o = online();
            const text = $('report-text').value.trim();
            if (!o || !text) return;                              // app.js shows its own messages
            e.stopImmediatePropagation();
            const card = typeof currentCard !== 'undefined' ? currentCard : null;   // eslint-disable-line no-undef
            const inGame = $('game-screen').classList.contains('active');
            try {
                await o.sendFeedback($('report-topic').value, text, inGame && card ? String(card.id) : null, {
                    round: inGame && typeof currentRound !== 'undefined' ? currentRound : null,  // eslint-disable-line no-undef
                    page: location.href, ua: navigator.userAgent.slice(0, 200),
                });
                $('report-modal').classList.add('hidden');
                $('report-text').value = '';
                toast(t('feedback.sent'));
            } catch (err) {
                fallback = true;
                send.click();
            }
        }, true);
    }

    // ─── solo game: logging and saving, without touching app.js ───────────
    // app.js declares its functions globally and calls them by name, so
    // wrapping window.placeCard / endGame / readSeen hooks in cleanly.
    /* global timeline, currentCard, currentRound, score, bonusPoints, fuzzyMatch */
    let soloLog = null;
    function hookSoloGame() {
        if (typeof window.placeCard !== 'function') return;
        const origPlace = window.placeCard;
        const origEnd = window.endGame;
        const origSeen = window.readSeen;

        window.placeCard = function (index) {
            if (!$('feedback-area').classList.contains('hidden')) return origPlace(index);   // already placed
            if (currentRound === 1 || !soloLog) {
                soloLog = { startedAt: new Date().toISOString(), cards: [{ id: timeline[0] && timeline[0].id }], streak: 0, best: 0 };
            }
            const card = currentCard;
            const g = id => ($(id).value || '').trim();
            const artist = !!g('guess-artist') && fuzzyMatch(g('guess-artist'), card.artistDisplayName || '');
            const title = !!g('guess-title') && fuzzyMatch(g('guess-title'), card.title || '');
            const year = !!g('guess-year') && parseInt(g('guess-year'), 10) === card.objectEndDate;
            const result = origPlace(index);
            const correct = timeline.includes(card);
            soloLog.streak = correct ? soloLog.streak + 1 : 0;
            soloLog.best = Math.max(soloLog.best, soloLog.streak);
            soloLog.cards.push({ id: card.id, correct, artist, title, year });
            // desktop: the result sits above the timeline, so bring it into view
            const main = document.querySelector('#game-screen .game-main');
            if (main && innerWidth > 780) main.scrollTo({ top: 0, behavior: 'smooth' });
            return result;
        };

        window.endGame = function () {
            const result = origEnd.apply(this, arguments);
            if (soloLog) {
                window.CircShell.soloGameFinished({
                    startedAt: soloLog.startedAt, score, bonusPoints,
                    bestStreak: soloLog.best, cards: soloLog.cards,
                });
                soloLog = null;
            }
            return result;
        };

        // Cards seen on other devices count as seen for the dealer too.
        window.readSeen = function () {
            const seen = origSeen();
            const now = Date.now();
            serverSeen.forEach(id => { if (!(id in seen)) seen[id] = now; });
            return seen;
        };
    }

    // ─── called by app.js ─────────────────────────────────────────────────
    let serverSeen = new Set();
    window.CircShell = {
        // Finished solo game → saved for signed-in players (queued while offline).
        soloGameFinished(game) {
            const o = online();
            if (o && game && game.cards && game.cards.length > 1) o.saveSoloGame(game);
        },
        // Cards this player saw on any device in the last day (artline ids).
        serverSeen: () => serverSeen,
        showTab,
        toast,
        t,
    };

    // ─── start ────────────────────────────────────────────────────────────
    function init() {
        window.CircI18n.apply();
        document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
        $('home-avatar').addEventListener('click', () => showTab('profile'));
        document.querySelectorAll('#round-chips .chip').forEach(c => c.addEventListener('click', () => {
            $('rounds-select').value = c.dataset.rounds;
            renderHome();
        }));
        $('flag-btn').addEventListener('click', () => $('open-report-btn').click());
        hookFeedback();
        hookSoloGame();

        new MutationObserver(syncTabs).observe($('app'), { subtree: true, attributes: true, attributeFilter: ['class'] });
        syncTabs();
        renderHome();

        document.addEventListener('circart:auth', () => {
            cachedProfile = null;
            if ($('profile-screen').classList.contains('active')) renderProfile();
            renderHome();
        });

        const o = online();
        if (o) o.recentlySeen(24).then(ids => { if (ids) serverSeen = new Set(ids); });

        // A new version took over (sw.js skips waiting): reload so the page and its
        // files match again — straight away on a tab, otherwise after the game.
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            let pending = false;
            const tryReload = () => {
                const active = document.querySelector('.screen.active');
                if (!active || Object.values(TAB_SCREENS).includes(active.id)) location.reload();
                else pending = true;
            };
            navigator.serviceWorker.addEventListener('controllerchange', tryReload);
            new MutationObserver(() => { if (pending) tryReload(); })
                .observe($('app'), { subtree: true, attributes: true, attributeFilter: ['class'] });
        }

        // a tapped notification while the app is already open
        if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
            if (!e.data || e.data.type !== 'circart:open') return;
            const id = new URL(e.data.url).searchParams.get('game');
            if (id && o) window.CircGame.open(id);
        });

        // links to a game you're in: ?game=<id> (from a share or a notification)
        const gameId = new URLSearchParams(location.search).get('game');
        if (gameId && o && FEATURES.friends) {
            history.replaceState(null, '', location.pathname);
            o.user().then(u => u && o.getGame(gameId).then(() => window.CircGame.open(gameId)).catch(() => toast(t('game.notFound'))));
        }

        // invite links: ?join=K7Q2
        const code = new URLSearchParams(location.search).get('join');
        if (code && o && FEATURES.friends) {
            history.replaceState(null, '', location.pathname);
            joinByCode(code);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
