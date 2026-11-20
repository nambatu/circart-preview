// CIRCArt — playing with friends: live rooms and async games.
//
// One screen for both, driven by the server's `phase` (lobby · play ·
// waiting · reveal · finished · dropped). The server owns the clock and the
// answers; this file only shows what get_game / next_card / reveal return.
// Live updates come from watchGame(); timers re-fetch at each deadline.

(function () {
    'use strict';

    const { t, esc, de } = window.CircI18n;
    const $ = id => document.getElementById(id);
    const O = () => window.CircOnline;
    const imgUrl = raw => String((raw && (raw.image_local || raw.image || raw.image_source)) || '').replace(/\\/g, '/');
    const soloSourceId = (raw, packId) => (raw && (raw.pack || packId)) ? ('pack:' + (raw.pack || packId) + ':' + raw.id) : String(raw.id);
    const formatTlCard = raw => ({ year: raw.year, title: raw.title, artist: raw.artist || raw.artistDisplayName || '', image_url: imgUrl(raw) });

    let G = null;          // the open game: { id, st, card, answer, picked, rev, ... }
    let unwatch = null;
    let tick = null;       // countdown interval
    let poll = null;       // fallback refresh
    let refreshing = false, again = false;
    let soloToken = 0;

    // ─── open / close ─────────────────────────────────────────────────────
    function open(id, extra) {
        close(true);
        G = { id, st: null, card: null, answer: null, picked: false, rev: null, revFor: null, wantCard: false,
              challengeNo: extra && extra.challengeNo, prevBest: extra ? extra.prevBest : undefined, board: null, results: null, rematch: null, sel: {}, bonusRes: null };
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        $('game-online-screen').classList.add('active');
        $('go-body').innerHTML = `<p class="muted" style="padding:2rem;text-align:center">…</p>`;
        unwatch = O().watchGame(id, () => refresh());
        refresh();
    }

    async function openSolo({ rounds = 10, cards = null, packId = null, packTitle = null } = {}) {
        close(true);
        const token = soloToken;
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        $('game-online-screen').classList.add('active');
        $('go-title').textContent = packTitle || t('solo.title');
        $('go-score').textContent = '';
        $('go-body').innerHTML = `<p class="muted" style="padding:2rem;text-align:center">…</p>`;

        const baseDeck = (window.CircShell && window.CircShell.loadDeck) ? await window.CircShell.loadDeck() : [];
        if (token !== soloToken) return;

        const deck = ((cards || baseDeck) || []).filter(c => c && (c.image_local || c.image || c.image_source));
        if (deck.length < 2) {
            window.CircShell.toast(t('solo.noCards'));
            close();
            return;
        }

        const extraSeen = packId || !window.CircShell || !window.CircShell.serverSeen ? null : window.CircShell.serverSeen();
        const deal = new window.CircDealer.Dealer(deck, extraSeen).deal(rounds, { markAll: false });
        const startCard = deal.starting_cards[0];
        const pile = deal.draw_pile;
        if (!startCard || !pile.length) {
            window.CircShell.toast(t('solo.noCards'));
            close();
            return;
        }

        const artists = new Set();
        for (const c of deck) {
            const a = (c && (c.artist || c.artistDisplayName) || '').trim();
            if (a && !/unknown/i.test(a)) artists.add(a.toLowerCase());
        }
        const artistPool = artists.size >= 4 ? deck : [...deck, ...baseDeck];

        window.CircDealer.markSeen([startCard.id]);
        if (window.CircCollection) window.CircCollection.record(startCard.id, false);

        G = {
            id: null,
            st: {
                kind: 'solo',
                phase: 'play',
                status: 'playing',
                card_count: pile.length,
                current_turn: 1,
                timeline: [formatTlCard(startCard)],
                me: { score: 0, answered: 0, correct: 0, streak: 0, best_streak: 0 },
            },
            card: null,
            answer: null,
            picked: false,
            rev: null,
            revFor: null,
            wantCard: true,
            results: [],
            sel: {},
            bonusRes: null,
            local: {
                rounds,
                packId: packId || null,
                packTitle: packTitle || null,
                allCards: cards || null,
                pile,
                index: 0,
                artistPool,
                startedAt: new Date().toISOString(),
                bonusPoints: 0,
                logCards: [{ id: soloSourceId(startCard, packId) }],
                saved: false,
                currentRaw: null,
            },
        };
        openSoloCard();
        draw();
    }

    function openSoloCard() {
        const raw = G.local.pile[G.local.index];
        G.local.currentRaw = raw;
        G.card = {
            position: G.local.index + 1,
            image_url: imgUrl(raw),
            title: raw.title,
        };
        G.st.current_turn = G.local.index + 1;
        window.CircDealer.markSeen([raw.id]);
        $('go-body').scrollTop = 0;
    }

    function close(silent) {
        soloToken++;
        if (unwatch) unwatch();
        clearInterval(tick); clearInterval(poll);
        unwatch = tick = poll = null;
        G = null;
        $('go-body').innerHTML = '';
        if (!silent) window.CircShell.showTab('play');
    }

    const left = iso => Math.max(0, new Date(iso).getTime() - O().serverNow());
    function fmtLeft(ms) {
        const m = Math.ceil(ms / 60000);
        if (m >= 60) return t('game.hoursMin', { h: Math.floor(m / 60), m: m % 60 });
        return t('game.minutes', { m });
    }

    // ─── refresh: one server round-trip, then draw ────────────────────────
    async function refresh() {
        if (!G || (G.st && G.st.kind === 'solo') || !G.id) return;
        if (refreshing) { again = true; return; }
        refreshing = true;
        try {
            const st = G.st = await O().getGame(G.id);
            const live = st.kind === 'live';
            if (st.kind === 'daily' && O().dailyStory && (G.story === undefined || G.storyAt !== st.me.answered)) {
                try { G.story = await O().dailyStory(st.challenge_date || null); } catch (e) { G.story = null; }
                G.storyAt = st.me.answered;
            }

            // a new live round or async turn: forget the previous card
            if (G.answer && live && (st.phase === 'play' || st.phase === 'reveal') && G.answer.turn !== st.current_turn) {
                G.answer = null; G.card = null;
            }
            if (live && st.phase === 'reveal' && G.revFor !== st.current_turn) {
                G.answer = null; G.card = null;
                try {
                    G.rev = await O().reveal(G.id, st.current_turn); G.revFor = st.current_turn;
                    if (!G.rev.mine.timed_out || G.rev.mine.slot != null) feel(!!G.rev.mine.correct);
                } catch (e) { G.rev = null; }
            }
            // live deals the card to everyone at once; async waits for "Ready"
            if (st.phase === 'play' && !G.answer && (!G.card || G.card.wait) && (live || G.wantCard)) {
                G.card = await O().nextCard(G.id);
                G.cardTurn = st.current_turn;
            }
            if ((st.kind === 'live' || st.kind === 'async') && (st.phase === 'lobby' || !G.opts)) {
                try { G.opts = await O().gameOptions(G.id); } catch (e) { G.opts = null; }
            }
            if ((st.phase === 'finished' || st.phase === 'done') && !G.answer && !G.results) {
                try { G.results = await O().myResults(G.id); } catch (e) { G.results = []; }
            }
            if (st.phase === 'finished' && st.kind !== 'daily' && st.kind !== 'run') {
                try { G.rematch = await O().rematchInfo(G.id); } catch (e) { G.rematch = null; }
            }
            if (st.kind === 'run' && st.phase === 'finished' && !G.answer && !G.board) {
                try { G.board = await O().monthlyLeaderboard(); } catch (e) { G.board = { entries: [] }; }
            }
            if (st.kind === 'daily' && st.phase === 'done' && !G.answer && !G.board) {
                try { G.board = await O().dailyLeaderboard(); G.challengeNo = G.board.challenge_no; } catch (e) { G.board = { entries: [] }; }
            }
            draw();
            schedule();
        } catch (e) {
            $('go-body').innerHTML = `<p class="muted" style="padding:2rem">${esc(e.message)}</p>`;
        } finally {
            refreshing = false;
            if (again) { again = false; refresh(); }
        }
    }

    // timers: countdown redraws, and a re-fetch when a deadline passes
    function schedule() {
        clearInterval(tick); clearInterval(poll);
        if (!G || !G.st || G.st.kind === 'solo') return;
        const st = G.st;
        const live = st.kind === 'live';
        let due = null, bonusDue = false;
        if (st.phase === 'play' && G.card && G.card.ends_at && !G.answer && timed()) due = G.card.ends_at;
        else if (G.answer && !G.picked && G.answer.bonusEnds && st.kind !== 'live') { due = new Date(G.answer.bonusEnds).toISOString(); bonusDue = true; }
        else if (st.phase === 'reveal') due = st.next_round_at;
        else if (live && st.phase === 'waiting') due = st.turn_deadline;
        if (due) {
            tick = setInterval(() => {
                const ms = left(due);
                document.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = Math.ceil(ms / 1000); });
                const bar = $('go-bar');
                const total = bonusDue ? G.answer.bonusTotal : (G.card && G.card.seconds ? G.card.seconds * 1000 : 0);
                if (bar && total) bar.style.width = Math.max(0, Math.min(100, 100 * ms / total)) + '%';
                if (ms <= 0) { clearInterval(tick); if (bonusDue) pick(); else setTimeout(refresh, 400); }   // bonus time up: send what's picked
            }, 200);
        }
        // realtime is primary; this catches a dropped connection
        const pollIfVisible = () => { if (!document.hidden) refresh(); };    // no requests while the app is in the background
        if (['lobby', 'play', 'waiting', 'reveal'].includes(st.phase)) poll = setInterval(pollIfVisible, live ? 4000 : 30000);
        else if (st.phase === 'finished' && st.kind !== 'daily' && st.kind !== 'run') poll = setInterval(pollIfVisible, 10000);   // a rematch may appear
    }

    // ─── drawing ──────────────────────────────────────────────────────────
    function draw() {
        const st = G.st;
        $('go-title').textContent = st.kind === 'solo' ? (G.local.packTitle || t('solo.title'))
            : st.kind === 'live' ? t('game.live')
            : st.kind === 'daily' ? (G.challengeNo ? t('game.daily', { no: G.challengeNo }) : t('game.dailyShort'))
            : st.kind === 'run' ? t('run.short')
            : t('game.async');
        $('go-score').textContent = (st.phase === 'lobby' || (st.kind === 'solo' && st.phase === 'finished')) ? '' : t('game.points', { n: st.me.score.toLocaleString() });
        const body = $('go-body');
        if (G.answer) return body.innerHTML = st.kind === 'live' ? viewLocked() : viewResult(), wire();
        const view = {
            lobby: viewLobby, play: viewPlay, waiting: viewWaiting, reveal: viewReveal, done: viewDailyDone,
            finished: () => (st.kind === 'solo' ? viewSoloDone() : st.kind === 'run' ? viewRunDone() : viewPodium()), dropped: () => note(t('game.dropped')), cancelled: () => note(t('game.cancelled')),
        }[st.phase] || (() => '');
        body.innerHTML = view();
        wire();
    }

    const note = msg => `<div class="page"><p class="muted">${esc(msg)}</p>
        <button class="btn outline" data-act="home">${esc(t('game.home'))}</button></div>`;

    function avatar(name, i, size) {
        const colours = ['#3c5a73', '#8a6a2f', '#5b6e4a', '#6b4e71', '#722f37', '#2f5d50', '#8a5a12'];
        return `<span class="go-av" style="width:${size || 32}px;height:${size || 32}px;background:${colours[i % colours.length]}">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
    }

    function standings(limit, highlightDone) {
        const st = G.st;
        return `<ol class="go-stand">${st.players.slice(0, limit || 99).map((p, i) => `
            <li class="${p.is_me ? 'me' : ''}">
              <span class="go-rank">${i + 1}</span>${avatar(p.name, i)}
              <span class="go-name">${esc(p.name)}${p.is_me ? ' ' + esc(t('game.you')) : ''}${p.dropped ? ' · ' + esc(t('game.out')) : ''}
                ${highlightDone && st.status === 'playing' && !p.dropped ? `<small>${esc(p.done_this_turn ? t('game.played') : t('game.notYet'))}</small>` : ''}</span>
              <span class="go-pts">${p.score.toLocaleString()}</span></li>`).join('')}</ol>`;
    }

    function viewLobby() {
        const st = G.st;
        return `<div class="page">
          <div style="text-align:center">
            <div class="muted">${esc(t('game.joinWith'))}</div>
            <div class="go-code">${esc(st.code)}</div>
          </div>
          <button class="btn outline block" data-act="share">${esc(t('game.share'))}</button>
          <div class="row" style="justify-content:space-between"><h2 class="label">${esc(t('game.players'))}</h2>
            <span class="note">${st.players.length}</span></div>
          <ul class="go-lobby">${st.players.map((p, i) => `<li>${avatar(p.name, i)}<b>${esc(p.name)}</b>${p.is_host ? `<small>${esc(t('game.host'))}</small>` : ''}</li>`).join('')}</ul>
          <p class="note" style="text-align:center">${esc(st.kind === 'live'
              ? t('game.liveRules', { n: st.card_count })
              : t('game.asyncRules', { turns: st.turns, cards: st.cards_per_turn }))}</p>
          ${artistOption()}
          ${st.is_host
              ? `<button class="btn primary block" data-act="start" ${st.players.length < 2 ? 'disabled' : ''}>${esc(st.players.length < 2 ? t('game.waitPlayers') : t('game.start'))}</button>`
              : `<p class="muted" style="text-align:center">${esc(t('game.waitHost'))}</p>`}
          <button class="btn link" data-act="leave">${esc(t('game.leave'))}</button>
        </div>`;
    }

    // games with friends can switch the timer off (018); daily and runs always have it; solo has no timer
    const timed = () => G.st.kind !== 'solo' && !(G.opts && G.opts.timer === false && (G.st.kind === 'live' || G.st.kind === 'async'));

    function artistOption() {
        const a = !G.opts || G.opts.artist_bonus !== false, m = !G.opts || G.opts.movement_bonus !== false;
        if (!G.st.is_host) return `<p class="note" style="text-align:center">${esc(
            a && m ? t('game.bonusBoth') : a ? t('game.bonusArtist') : m ? t('game.bonusMovement') : t('game.bonusNone'))}
            ${esc(timed() ? t('game.timerOnNote', { s: (G.opts && G.opts.seconds) || 20 }) : t('game.timerOffNote'))}</p>`;
        const sw = (key, on, title, text) => `<label class="panel go-switch"><span><b>${esc(title)}</b><br>
            <span class="note">${esc(text)}</span></span>
            <input type="checkbox" data-opt="${key}" ${on ? 'checked' : ''}><span class="go-toggle" aria-hidden="true"></span></label>`;
        const secs = (G.opts && G.opts.seconds) || 20;
        const SECONDS = [10, 15, 20, 30, 45, 60, 90];
        const chips = timed() ? `<div class="chips go-secs" role="group" aria-label="${esc(t('game.timerSeconds'))}">${SECONDS.map(n =>
            `<button class="chip" data-secs="${n}" aria-pressed="${n === secs}">${n}s</button>`).join('')}</div>` : '';
        return sw('timer', timed(), t('game.timer'), t(G.st.kind === 'live' ? 'game.timerTextLive' : 'game.timerTextAsync'))
             + chips
             + sw('artist', a, t('game.artistBonus'), t('game.artistBonusText'))
             + sw('movement', m, t('game.movementBonus'), t('game.movementBonusText'));
    }

    // the test site (circart-preview) loads preview.js; the real game doesn't
    const isPreview = () => !!document.querySelector('script[src="preview.js"]') && !!O().previewResetDaily;

    // ─── feedback you can feel: a colour flash, a mark, a short buzz ──────
    // Android buzzes; iPhone browsers don't allow vibration, so it's visual there.
    function feel(ok) {
        try { if (navigator.vibrate) navigator.vibrate(ok ? 35 : [45, 70, 45]); } catch (e) { /* ignore */ }
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const f = document.createElement('div');
        f.className = 'go-flash ' + (ok ? 'ok' : 'bad');
        f.innerHTML = `<span>${ok ? '✓' : '✗'}</span>`;
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 900);
    }

    function timeline(clickable) {
        const tl = G.st.timeline;              // oldest first; the gap index is what the server wants
        const gap = i => {
            const lo = tl[i - 1], hi = tl[i];
            const label = !lo ? t('game.before', { y: hi.year }) : !hi ? t('game.after', { y: lo.year }) : t('game.between', { a: lo.year, b: hi.year });
            return clickable ? `<li><button class="go-gap" data-gap="${i}">+ ${esc(label)}</button></li>` : '';
        };
        const card = c => `<li class="go-tl">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : '<span class="go-noimg"></span>'}
            <b class="serif">${esc(c.year)}</b><span>${esc(c.title)}<br><small>${esc(c.artist)}</small></span></li>`;
        let out = gap(tl.length);
        for (let i = tl.length - 1; i >= 0; i--) out += card(tl[i]) + gap(i);
        return `<ol class="go-timeline" aria-label="${esc(t('game.timeline'))}">${out}</ol>`;
    }

    const lives = st => Math.max(0, 3 - ((st.me.answered || 0) - (st.me.correct || 0)));
    const hearts = st => `<span class="run-hearts" aria-label="${esc(t('run.lives'))}: ${lives(st)}">${'❤️'.repeat(lives(st))}${'🤍'.repeat(3 - lives(st))}</span>`;

    function viewReady() {
        const st = G.st;
        if (st.kind === 'run') {
            const started = st.me.answered > 0;
            return `<div class="page">
              <section class="panel strong" style="padding:18px;display:flex;flex-direction:column;gap:10px">
                <span class="eyebrow">${esc(t('run.short'))}</span>
                <h2 class="serif" style="font-size:24px">${esc(t('run.rules'))}</h2>
                <p class="muted" style="font-size:14px">${esc(t('run.startText'))}</p>
                ${started ? `<p class="note">${hearts(st)} · ${esc(t('run.cards', { n: st.me.answered }))} · ${esc(t('game.points', { n: st.me.score.toLocaleString() }))}</p>` : ''}
                <button class="btn primary block" data-act="ready">${esc(started ? t('home.daily.continue') : t('run.go'))}</button>
              </section></div>`;
        }
        if (st.kind === 'daily') {
            const started = st.me.answered > 0;
            return `<div class="page">
              <section class="panel strong" style="padding:18px;display:flex;flex-direction:column;gap:10px">
                <span class="eyebrow">${esc(G.story ? t('story.eyebrow') : G.challengeNo ? t('home.daily.eyebrow', { no: G.challengeNo }) : t('game.dailyShort'))}</span>
                <h2 class="serif" style="font-size:24px">${esc(G.story ? de(G.story, 'title') : t('home.daily.title'))}</h2>
                <p class="muted" style="font-size:${G.story ? 16 : 14}px;line-height:1.5">${esc(G.story ? de(G.story, 'intro') : t('game.dailyStartText'))}</p>
                ${G.story ? `<p class="note">${esc(t('story.howTo'))}</p>` : ''}
                ${started ? `<p class="note">${esc(t('game.card', { n: st.me.answered + 1, total: st.card_count }))} · ${esc(t('game.points', { n: st.me.score.toLocaleString() }))}</p>` : ''}
                <button class="btn primary block" data-act="ready">${esc(started ? t('home.daily.continue') : t('game.dailyStart'))}</button>
              </section>
              ${st.timeline.length > 1 ? `<h2 class="label">${esc(t('game.yourTimeline'))} · ${st.timeline.length}</h2>${timeline(false)}` : ''}
            </div>`;
        }
        return `<div class="page">
          <div class="go-turns">${Array.from({ length: st.turns }, (_, i) =>
              `<span class="${i + 1 < st.current_turn ? 'done' : i + 1 === st.current_turn ? 'now' : ''}"></span>`).join('')}</div>
          <div class="row" style="justify-content:space-between">
            <b>${esc(t('game.turnOf', { n: st.current_turn, total: st.turns }))}</b>
            <span class="note">${esc(t('game.closesIn', { time: fmtLeft(left(st.turn_deadline)) }))}</span></div>
          <section class="panel strong" style="padding:18px;display:flex;flex-direction:column;gap:8px">
            <h2 class="serif" style="font-size:22px">${esc(t('game.yourTurn'))}</h2>
            <p class="muted" style="font-size:14px">${esc(t('game.readyText', { n: st.cards_per_turn }))}</p>
            <button class="btn primary block" data-act="ready">${esc(t('game.startTurn', { n: st.current_turn }))}</button></section>
          <h2 class="label">${esc(t('game.standings'))}</h2>
          ${standings(99, true)}
        </div>`;
    }

    function viewPlay() {
        const c = G.card;
        if (!c && G.st.kind !== 'live') return viewReady();
        if (!c || c.wait) return viewWaiting();
        const total = G.st.card_count;
        return `<div class="page">
          <div class="go-sticky">
          <div class="row" style="justify-content:space-between">
            <span><b>${esc(G.st.kind === 'run' ? '#' + c.position : t('game.card', { n: c.position, total }))}</b>${G.st.kind === 'run' ? ' ' + hearts(G.st) : ''}</span>
            ${timed() ? `<span class="go-timer" aria-live="off"><span data-countdown>${Math.ceil(left(c.ends_at) / 1000)}</span>s</span>` : ''}
          </div>
          ${timed() ? `<div class="go-barbox" aria-hidden="true"><div id="go-bar" class="go-bar" style="width:${c.seconds && c.ends_at ? Math.max(0, Math.min(100, 100 * left(c.ends_at) / (c.seconds * 1000))) : 100}%"></div></div>` : ''}
          </div>
          <div class="go-art">${c.image_url ? `<img src="${esc(c.image_url)}" alt="${esc(t('game.artAlt'))}">` : `<div class="go-typo serif">${esc(c.title || '?')}</div>`}</div>
          <div class="row" style="justify-content:space-between"><b>${esc(t('game.tap'))}</b>
            ${G.st.kind === 'live' ? `<span class="note">${esc(t('game.answered', { n: G.st.players.filter(p => p.done_this_turn).length, total: G.st.players.filter(p => !p.dropped).length }))}</span>` : ''}</div>
          ${timeline(true)}
        </div>`;
    }

    // ─── bonus questions after placing: artist (+200) and movement (+100) ──
    // Tap one answer per question; when every question has one, it's sent.
    // "Skip" sends whatever is picked so far.
    const opts = (r, k) => (r && r[k + '_options'] && r[k + '_options'].length) ? r[k + '_options'] : null;
    function hasBonus(res) { return !!(opts(res, 'artist') || opts(res, 'movement')); }

    function bonusRow(kind, title, pts, list) {
        const sel = G.sel[kind], res = G.bonusRes, live = G.st.kind === 'live';
        const real = res && res[kind];                       // async/daily: the right answer, after sending
        // closed = the 20-second window ran out: no points, but you still see the right answer
        const cls = n => G.picked
            ? (live || !res || !real ? (n === sel ? 'chosen' : '')
               : n === real ? 'right' : n === sel ? (res.closed ? 'chosen' : 'wrong') : '')
            : (n === sel ? 'chosen' : '');
        const mark = c => c === 'right' ? ' ✓' : c === 'wrong' ? ' ✗' : '';
        const locked = G.picked;                            // until lock-in you can change your mind freely
        const help = kind === 'movement' && window.CircStyles ? ' ' + window.CircStyles.helpButton(list) : '';
        return `<div style="display:flex;flex-direction:column;gap:8px"><b>${esc(title)} <span class="note">+${pts}</span>${help}</b>
          <div class="two">${list.map(n => locked
              ? `<span class="go-pick ${cls(n)}">${esc(n)}${mark(cls(n))}</span>`
              : `<button class="go-pick ${cls(n)}" aria-pressed="${n === sel}" data-${kind}="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>`;
    }

    function artistPicker() {
        const r = G.answer.res, a = opts(r, 'artist'), m = opts(r, 'movement');
        if (!a && !m) return '';
        if (G.picked && !G.sel.artist && !G.sel.movement) return '';
        const res = G.bonusRes;
        const solo = G.st.kind === 'solo';
        const showArt = !G.picked && G.card && G.card.image_url;   // look at the painting again while you decide
        const ends = !G.picked && G.answer.bonusEnds && G.st.kind !== 'live';
        const total = G.answer.bonusTotal || 19000;
        return `<section class="panel" style="padding:14px;display:flex;flex-direction:column;gap:14px">
          ${ends ? `<div class="go-sticky"><div class="go-barbox" aria-hidden="true"><div id="go-bar" class="go-bar" style="width:${Math.max(0, Math.min(100, 100 * (G.answer.bonusEnds - O().serverNow()) / total))}%"></div></div></div>` : ''}
          ${showArt || ends ? `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
              ${showArt ? `<img class="go-bonus-art zoomable-img" src="${esc(G.card.image_url)}" alt="${esc(t('game.artAlt'))}">` : '<span></span>'}
              ${ends ? `<span class="go-timer" aria-live="off"><span data-countdown>${Math.max(0, Math.ceil((G.answer.bonusEnds - O().serverNow()) / 1000))}</span>s</span>` : ''}</div>` : ''}
          ${res && res.closed ? `<p class="note">${esc(t('game.bonusClosed'))}</p>` : ''}
          ${a ? bonusRow('artist', t('game.whoPainted'), solo ? 1 : 200, a) : ''}
          ${m ? bonusRow('movement', t('game.whichMovement'), solo ? 1 : 100, m) : ''}
          ${G.picked ? '' : `${(!a || G.sel.artist) && (!m || G.sel.movement) ? `<button class="btn primary block" data-act="lock">${esc(t('game.lockIn'))}</button>` : ''}<button class="btn link" data-act="skip">${esc(t('game.skip'))}</button>`}</section>`;
    }

    // live: you answered; the result comes when the round closes
    function viewLocked() {
        const a = G.answer;
        return `<div class="page">
          <h2 class="serif" style="font-size:26px">${esc(a.res.timed_out ? t('game.tooSlow') : t('game.locked'))}</h2>
          ${a.res.timed_out ? '' : artistPicker()}
          <p class="muted">${esc(t('game.answered', { n: G.st.players.filter(p => p.done_this_turn).length, total: G.st.players.filter(p => !p.dropped).length }))}
            ${timed() ? `· <span data-countdown>${Math.ceil(left(G.st.turn_deadline) / 1000)}</span>s` : ''}</p>
          ${standings(5)}
        </div>`;
    }

    // async / daily / run / solo: your own result right away, then the card's story
    function viewResult() {
        const a = G.answer, r = a.res, rev = G.rev, solo = G.st.kind === 'solo';
        const verdict = r.timed_out ? t('game.tooSlow') : r.correct ? t('game.correct') : t('game.wrong');
        const aPts = solo ? 1 : 200, mPts = solo ? 1 : 100;
        const gained = (r.points || 0) + (rev && rev.mine.artist_correct ? aPts : 0) + (rev && rev.mine.movement_correct ? mPts : 0);
        return `<div class="page">
          <div class="row" style="justify-content:space-between">
            <h2 class="serif go-verdict ${r.correct ? 'ok' : 'bad'}">${esc(verdict)}</h2>
            <b class="serif" style="font-size:26px">+${gained}</b></div>
          ${r.streak > 1 ? `<p class="note">${esc(t(solo ? 'solo.streak' : 'game.streak', { n: r.streak }))}</p>` : ''}
          ${solo && !r.correct ? `<p class="note">${esc(t('solo.droppedNote'))}</p>` : ''}
          ${G.st.kind === 'run' ? `<p class="note">${hearts(G.st)} ${!r.correct ? esc(G.st.status === 'finished' ? t('run.over') : t('run.lifeLost')) : ''}</p>` : ''}
          ${artistPicker()}
          ${rev ? cardStory(rev) : ''}
          ${rev && G.story ? chapterFor(a.position) : ''}
          ${G.picked || !hasBonus(r) ? `<button class="btn primary block" data-act="next">${esc(((G.st.kind === 'daily' || solo) && a.position >= G.st.card_count) || (G.st.kind === 'run' && G.st.status === 'finished') ? t('game.results') : t('game.next'))}</button>` : ''}
        </div>`;
    }

    // ─── story dailies (019) ─────────────────────────────────────────────
    function chapterFor(pos) {
        const s = G.story;
        const ch = s && s.chapters && s.chapters.find(c => c.position === pos);
        if (!ch || !de(ch, 'chapter')) return '';
        return `<section class="panel go-chapter"><span class="eyebrow">${esc(t('story.next'))}</span>
          <p>${esc(de(ch, 'chapter'))}</p></section>`;
    }
    function creditFor(pos) {
        const s = G.story;
        const ch = s && s.chapters && s.chapters.find(c => c.position === pos);
        return ch && ch.credit ? `<p class="note go-credit">${esc(ch.credit)}</p>` : '';
    }

    function cardStory(rev) {
        const c = rev.card;
        const meta = [c.medium, c.location].filter(Boolean).join(' · ');
        return `<section class="panel go-story">
          ${c.image_url ? `<img src="${esc(c.image_url)}" alt="${esc(c.title)}">` : ''}
          <div><b class="serif" style="font-size:26px">${esc(c.year)}</b>
            <div class="serif"><i>${esc(c.title)}</i></div>
            <div class="muted">${esc(c.artist)}${c.movement_group ? ' · ' + esc(c.movement_group) : ''}</div>
            ${meta ? `<div class="note" style="margin-top:4px">${esc(meta)}</div>` : ''}
            ${c.trivia && !G.story ? `<p class="go-trivia">${esc(c.trivia)}</p>` : ''}
            ${G.story && G.answer ? creditFor(G.answer.position) : ''}</div></section>`;
    }

    function distribution(rev) {
        if (!rev.distribution) return '';
        const ys = rev.timeline_years, n = ys.length;
        const total = Object.values(rev.distribution).reduce((a, b) => a + b, 0) || 1;
        let rows = '';
        for (let i = n; i >= 0; i--) {
            const label = i === 0 ? t('game.before', { y: ys[0] }) : i === n ? t('game.after', { y: ys[n - 1] }) : `${ys[i - 1]} – ${ys[i]}`;
            const k = rev.distribution[String(i)] || 0;
            const right = i === rev.correct_slot;
            rows += `<span class="${right ? 'go-right' : 'muted'}">${esc(label)}${right ? ' ✓' : ''}</span>
              <span class="go-dbar"><span style="width:${100 * k / total}%" class="${right ? 'ok' : ''}"></span></span><span>${k}</span>`;
        }
        return `<section><h2 class="label" style="margin-bottom:8px">${esc(t('game.whereEveryone'))}</h2><div class="go-dist">${rows}</div></section>`;
    }

    function viewReveal() {
        const rev = G.rev;
        if (!rev) return `<div class="page"><p class="muted">…</p></div>`;
        const m = rev.mine;
        const verdict = m.timed_out ? t('game.tooSlow') : m.correct ? t('game.correct') : t('game.wrong');
        return `<div class="page">
          <div class="row" style="justify-content:space-between">
            <h2 class="serif go-verdict ${m.correct ? 'ok' : 'bad'}">${esc(verdict)}</h2>
            <b class="serif" style="font-size:26px">+${m.points}</b></div>
          ${m.artist_choice ? `<p class="go-artline ${m.artist_correct ? 'ok' : 'bad'}">${esc(t('game.artistWas', { name: m.artist_choice }))} ${m.artist_correct ? '✓ +200' : '✗ · ' + esc(rev.card.artist)}</p>` : ''}
          ${m.movement_choice ? `<p class="go-artline ${m.movement_correct ? 'ok' : 'bad'}">${esc(t('game.movementWas', { name: m.movement_choice }))} ${m.movement_correct ? '✓ +100' : '✗ · ' + esc(rev.card.movement_group || '')}</p>` : ''}
          ${cardStory(rev)}
          ${distribution(rev)}
          <h2 class="label">${esc(t('game.afterCard', { n: rev.position }))}</h2>
          ${standings(5)}
          <p class="muted" style="text-align:center">${esc(G.st.current_turn >= G.st.turns ? t('game.finalIn') : t('game.nextIn'))} <span data-countdown>${Math.ceil(left(G.st.next_round_at) / 1000)}</span>s</p>
        </div>`;
    }

    function viewWaiting() {
        const st = G.st;
        if (st.kind === 'live') return viewLocked();
        return `<div class="page">
          <div class="go-turns">${Array.from({ length: st.turns }, (_, i) =>
              `<span class="${i + 1 < st.current_turn ? 'done' : i + 1 === st.current_turn ? 'now' : ''}"></span>`).join('')}</div>
          <div class="row" style="justify-content:space-between">
            <b>${esc(t('game.turnOf', { n: st.current_turn, total: st.turns }))}</b>
            <span class="note">${esc(t('game.closesIn', { time: fmtLeft(left(st.turn_deadline)) }))}</span></div>
          <section class="panel" style="padding:14px"><b>${esc(t('game.turnDone'))}</b>
            <p class="muted" style="font-size:14px">${esc(t('game.turnDoneText'))}</p></section>
          ${pushPrompt()}
          <h2 class="label">${esc(t('game.standings'))}</h2>
          ${standings(99, true)}
          ${st.timeline.length > 1 ? `<h2 class="label">${esc(t('game.timeline'))} · ${st.timeline.length}</h2>${timeline(false)}` : ''}
        </div>`;
    }

    function viewSoloDone() {
        const st = G.st, me = st.me;
        return `<div class="page">
          <div style="text-align:center">
            <div class="label">${esc(t('solo.done'))}</div>
            <h1 class="serif" style="font-size:40px">${me.score.toLocaleString()}</h1>
            <p style="font-size:22px;letter-spacing:2px;margin:4px 0;word-break:break-all">${squares()}</p>
            <p class="muted">${esc(t('solo.placedRight', { correct: me.correct, total: st.card_count }))}</p>
          </div>
          <div class="stats-grid" style="text-align:center">
            <div class="stat"><b>${me.correct}/${st.card_count}</b><span>${esc(t('ranks.accuracy'))}</span></div>
            <div class="stat"><b>${G.local.bonusPoints}</b><span>${esc(t('solo.bonusPoints'))}</span></div>
            <div class="stat"><b>${me.best_streak}</b><span>${esc(t('ranks.bestStreak'))}</span></div>
          </div>
          <button class="btn primary block" data-act="soloAgain">${esc(t('game.playAgain'))}</button>
          <button class="btn outline block" data-act="shareSolo">${esc(t('game.dailyShare'))}</button>
          <h2 class="label">${esc(t('game.yourTimeline'))} · ${st.timeline.length}</h2>
          ${timeline(false)}
          <button class="btn outline block" data-act="home">${esc(t('game.home'))}</button>
        </div>`;
    }

    function viewRunDone() {
        const st = G.st, me = st.me, b = G.board || { entries: [] };
        const newBest = G.prevBest === null || (G.prevBest !== undefined && me.score > G.prevBest);
        const top = b.entries.slice(0, 10);
        return `<div class="page">
          <div style="text-align:center">
            <div class="label">${esc(t('run.over'))}</div>
            <h1 class="serif" style="font-size:40px">${me.score.toLocaleString()}</h1>
            <p class="note" style="margin-top:-6px">${esc(t('run.rightLabel'))}</p>
            ${newBest && me.score > 0 ? `<p class="run-best">🏆 ${esc(t('run.newBest'))}</p>` : ''}
            <p style="font-size:20px;letter-spacing:2px;margin:4px 0;word-break:break-all">${squares()}</p>
            <p class="muted">${esc(t('run.cards', { n: me.answered }))} · ${esc(t('ranks.bestStreak'))} ${me.best_streak}
              ${b.me && b.me.rank ? ' · #' + b.me.rank : ''}</p>
          </div>
          ${b.me && b.me.ranked === false ? `<p class="note" style="text-align:center">${esc(t('game.dailyUnranked'))}</p>` : ''}
          <button class="btn primary block" data-act="runAgain">${esc(t('run.again'))}</button>
          <button class="btn outline block" data-act="shareRun">${esc(t('game.dailyShare'))}</button>
          ${top.length ? `<h2 class="label">${esc(t('run.board'))} · ${esc((window.CircI18n.lang === 'de' && b.title_de) || b.title || '')}</h2>
            <ol class="go-stand">${top.map(e => `<li class="${e.is_me ? 'me' : ''}"><span class="go-rank" style="width:28px">${e.rank}</span>
              <span class="go-name">${esc(e.username)}</span><span class="go-pts">${Number(e.value).toLocaleString()}</span></li>`).join('')}</ol>` : ''}
          <h2 class="label">${esc(t('game.yourTimeline'))}</h2>
          ${timeline(false)}
          <button class="btn outline block" data-act="home">${esc(t('game.home'))}</button>
        </div>`;
    }

    function viewDailyDone() {
        const st = G.st, b = G.board || { entries: [] }, me = st.me;
        const no = G.challengeNo || b.challenge_no || '';
        const top = b.entries.slice(0, 10);
        const mine = b.me;
        return `<div class="page">
          <div style="text-align:center">
            <div class="label">${esc(t('game.dailyDone'))}</div>
            <h1 class="serif" style="font-size:40px">${me.score.toLocaleString()}</h1>
            <p style="font-size:22px;letter-spacing:2px;margin:4px 0">${squares()}</p>
            <p class="muted">${esc(t('game.dailyScore', { correct: me.correct, total: st.card_count }))}
              ${mine && mine.rank ? ' · ' + esc(t('game.dailyRank', { rank: mine.rank, players: b.players })) : ''}</p>
          </div>
          ${mine && !mine.ranked ? `<p class="note" style="text-align:center">${esc(t('game.dailyUnranked'))}</p>` : ''}
          ${G.story && de(G.story, 'outro') ? `<section class="panel go-chapter"><span class="eyebrow">${esc(de(G.story, 'title'))}</span>
            <p>${esc(de(G.story, 'outro'))}</p></section>` : ''}
          <button class="btn primary block" data-act="shareDaily">${esc(t('game.dailyShare'))}</button>
          ${top.length ? `<h2 class="label">${esc(t('ranks.today'))}</h2>
            <ol class="go-stand">${top.map(e => `<li class="${e.is_me ? 'me' : ''}"><span class="go-rank" style="width:28px">${e.rank}</span>
              <span class="go-name">${esc(e.username)}</span><span class="go-pts">${e.score.toLocaleString()}</span></li>`).join('')}</ol>` : ''}
          <h2 class="label">${esc(t('game.yourTimeline'))}</h2>
          ${timeline(false)}
          <p class="note" style="text-align:center">${esc(t('game.dailyTomorrow'))}</p>
          ${isPreview() ? `<button class="btn quiet block" data-act="replayDaily">${esc(t('game.replayTest'))}</button>` : ''}
          <button class="btn outline block" data-act="home">${esc(t('game.home'))}</button>
        </div>`;
    }

    // after your first async turn: offer notifications, once per device
    const ASKED = 'circart-push-asked';
    function pushPrompt() {
        const o = O();
        let asked = null;
        try { asked = localStorage.getItem(ASKED); } catch (e) { /* ignore */ }
        if (asked || !o.pushSupported || o.pushPermission() === 'granted' || o.pushPermission() === 'denied') return '';
        const iphone = !o.pushSupported() && /iPhone|iPad/.test(navigator.userAgent);
        if (!o.pushSupported() && !iphone) return '';
        return `<section class="panel strong" style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <b class="serif" style="font-size:19px">${esc(t('push.title'))}</b>
            <p class="muted" style="font-size:14px">${esc(iphone ? t('push.iphone') : t('push.text'))}</p>
            <div class="two">${iphone ? '' : `<button class="btn primary" data-act="pushOn">${esc(t('push.on'))}</button>`}
              <button class="btn quiet" data-act="pushLater">${esc(t('push.later'))}</button></div></section>`;
    }

    function viewPodium() {
        const st = G.st, p = st.players;
        const winner = p[0];
        const block = (pl, i, h) => pl ? `<div class="go-pod">${avatar(pl.name, i, i === 0 ? 56 : 48)}<b>${esc(pl.name)}</b>
            <div class="go-ped" style="height:${h}px"><span class="serif">${i + 1}</span><small>${pl.score.toLocaleString()}</small></div></div>` : '<div></div>';
        const acc = st.me.answered ? Math.round(100 * st.me.correct / st.me.answered) : 0;
        return `<div class="page">
          <div style="text-align:center"><div class="label">${esc(t('game.over', { n: st.card_count }))}</div>
            <h1 class="serif" style="font-size:32px">${esc(!winner ? '' : winner.is_me ? t('game.youWin') : t('game.wins', { name: winner.name }))}</h1></div>
          <div class="go-podium">${block(p[1], 1, 110)}${block(p[0], 0, 150)}${block(p[2], 2, 80)}</div>
          <div class="stats-grid" style="text-align:center">
            <div class="stat"><b>${st.me.score.toLocaleString()}</b><span>${esc(t('game.pointsLabel'))}</span></div>
            <div class="stat"><b>${acc}%</b><span>${esc(t('ranks.accuracy'))}</span></div>
            <div class="stat"><b>${st.me.best_streak}</b><span>${esc(t('ranks.bestStreak'))}</span></div></div>
          ${rematchBox()}
          <button class="btn outline block" data-act="shareGame">${esc(t('game.dailyShare'))}</button>
          <h2 class="label">${esc(t('game.timeline'))}</h2>
          ${timeline(false)}
          <button class="btn outline block" data-act="home">${esc(t('game.home'))}</button>
        </div>`;
    }

    function rematchBox() {
        const r = G.rematch;
        if (r && r.joined) return `<button class="btn primary block" data-act="openRematch">${esc(t('game.rematchOpen'))}</button>`;
        if (r && r.status === 'lobby') return `<section class="panel strong" style="padding:14px;display:flex;flex-direction:column;gap:8px">
            <b>${esc(t('game.rematchBy', { name: r.host }))}</b>
            <button class="btn primary block" data-act="rematch">${esc(t('game.rematchJoin'))}</button></section>`;
        return `<button class="btn primary block" data-act="rematch">${esc(t('game.playAgain'))}</button>`;
    }

    // 🟩 right · 🟥 wrong · ⬜ too slow · 🎨 artist named too
    function squares() {
        return (G.results || []).map(r => r.timed_out ? '⬜' : r.correct ? (r.artist ? '🎨' : '🟩') : '🟥').join('');
    }

    async function shareText(text) {
        const url = location.origin + location.pathname;
        if (navigator.share) await navigator.share({ title: 'CIRCArt', text, url }).catch(() => {});
        else { await navigator.clipboard.writeText(text + '\n' + url); window.CircShell.toast(t('game.copiedResult')); }
    }

    // ─── actions ──────────────────────────────────────────────────────────
    function wire() {
        const body = $('go-body');
        body.querySelectorAll('[data-gap]').forEach(b => b.addEventListener('click', () => place(+b.dataset.gap)));
        body.querySelectorAll('[data-artist]').forEach(b => b.addEventListener('click', () => choose('artist', b.dataset.artist)));
        body.querySelectorAll('[data-movement]').forEach(b => b.addEventListener('click', () => choose('movement', b.dataset.movement)));
        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
        body.querySelectorAll('[data-opt]').forEach(c => c.addEventListener('change', async () => {
            const o = c.dataset.opt === 'artist' ? { artistBonus: c.checked }
                    : c.dataset.opt === 'timer' ? { timer: c.checked } : { movementBonus: c.checked };
            try { G.opts = await O().setGameOptions(G.id, o); } catch (e) { window.CircShell.toast(e.message); }
            draw();
        }));
        body.querySelectorAll('[data-secs]').forEach(b => b.addEventListener('click', async () => {
            try { G.opts = await O().setGameOptions(G.id, { seconds: Number(b.dataset.secs) }); } catch (e) { window.CircShell.toast(e.message); }
            draw();
        }));
    }

    function finalizeSoloCard() {
        const raw = G.local.currentRaw;
        const ok = !!(G.answer && G.answer.res && G.answer.res.correct);
        const aOk = !!(G.bonusRes && G.bonusRes.artist_correct);
        const mOk = !!(G.bonusRes && G.bonusRes.movement_correct);
        G.rev = {
            position: G.card.position,
            card: {
                year: raw.year,
                title: raw.title,
                artist: raw.artist || raw.artistDisplayName || '',
                movement_group: window.CircStyles ? window.CircStyles.groupOf(raw.movement) : null,
                medium: raw.medium,
                location: raw.location,
                image_url: imgUrl(raw),
                trivia: de(raw, 'trivia'),
            },
            mine: { artist_correct: aOk, movement_correct: mOk },
        };
        G.results.push({ correct: ok, timed_out: false, artist: aOk, movement: mOk });
        G.local.logCards.push({ id: soloSourceId(raw, G.local.packId), correct: ok, artist: aOk, title: false, year: false });
    }

    function saveSoloOnce() {
        if (!G || !G.local || G.local.saved) return;
        G.local.saved = true;
        if (window.CircShell && window.CircShell.soloGameFinished) {
            window.CircShell.soloGameFinished({
                mode: G.local.packId ? 'pack' : 'classic',
                startedAt: G.local.startedAt,
                score: G.st.me.score,
                bonusPoints: G.local.bonusPoints,
                bestStreak: G.st.me.best_streak,
                cards: G.local.logCards,
            });
        }
    }

    async function place(slot) {
        if (!G.card || G.answer) return;
        if (G.st.kind === 'solo') {
            const raw = G.local.currentRaw;
            const tl = G.st.timeline;
            const lo = tl[slot - 1], hi = tl[slot];
            const ok = (!lo || raw.year >= lo.year) && (!hi || raw.year <= hi.year);
            if (ok) tl.splice(slot, 0, formatTlCard(raw));
            G.st.me.answered += 1;
            if (ok) {
                G.st.me.correct += 1;
                G.st.me.score += 1;
                G.st.me.streak += 1;
                G.st.me.best_streak = Math.max(G.st.me.best_streak, G.st.me.streak);
            } else {
                G.st.me.streak = 0;
            }
            if (window.CircCollection) window.CircCollection.record(raw.id, ok);
            feel(ok);
            const res = {
                correct: ok,
                timed_out: false,
                points: ok ? 1 : 0,
                streak: G.st.me.streak,
                artist_options: window.CircDealer.artistOptions(raw, G.local.artistPool),
                movement_options: window.CircDealer.movementOptions(raw),
            };
            G.answer = { position: G.card.position, turn: G.st.current_turn, res, bonusEnds: null, bonusTotal: 0 };
            G.picked = !hasBonus(res);
            G.sel = {};
            G.bonusRes = null;
            G.rev = null;
            if (G.picked) finalizeSoloCard();
            $('go-body').scrollTop = 0;
            draw();
            return;
        }
        document.querySelectorAll('[data-gap]').forEach(b => { b.disabled = true; });
        try {
            const res = await O().answer(G.id, G.card.position, slot);
            G.answer = { position: G.card.position, turn: G.st.current_turn, res,
                         bonusEnds: G.st.kind !== 'live' && timed() && hasBonus(res) ? (G.st.kind === 'daily' && G.card.ends_at ? new Date(G.card.ends_at).getTime() : O().serverNow() + 19000) : null,
                         bonusTotal: G.st.kind === 'daily' && G.card.seconds ? G.card.seconds * 1000 : 19000 };
            G.picked = !hasBonus(res);
            G.sel = {}; G.bonusRes = null;
            if (G.st.kind !== 'live') feel(!!res.correct && !res.timed_out);
            G.rev = null;
            if (G.st.kind !== 'live' && G.picked) G.rev = await O().reveal(G.id, G.answer.position);
        } catch (e) {
            window.CircShell.toast(e.message);
        }
        refresh();
    }

    function choose(kind, name) {
        if (!G.answer || G.picked) return;                  // nothing is revealed until lock-in, so changing is fine
        G.sel[kind] = name;
        draw();
    }

    async function pick() {
        if (!G.answer || G.picked) return;
        G.picked = true;
        if (G.st.kind === 'solo') {
            const raw = G.local.currentRaw;
            const realArtist = (raw.artist || raw.artistDisplayName || '').trim();
            const realGroup = window.CircStyles ? window.CircStyles.groupOf(raw.movement) : null;
            const aOk = !!(G.sel.artist && realArtist && G.sel.artist === realArtist);
            const mOk = !!(G.sel.movement && realGroup && G.sel.movement === realGroup);
            const gained = (aOk ? 1 : 0) + (mOk ? 1 : 0);
            G.st.me.score += gained;
            G.local.bonusPoints += gained;
            G.bonusRes = {
                artist_correct: aOk,
                artist: G.sel.artist ? realArtist : null,
                movement_correct: mOk,
                movement: G.sel.movement ? realGroup : null,
            };
            if (G.sel.artist || G.sel.movement) feel((!G.sel.artist || aOk) && (!G.sel.movement || mOk));
            finalizeSoloCard();
            draw();
            return;
        }
        try {
            const r = await O().pickBonus(G.id, G.answer.position, G.sel.artist || null, G.sel.movement || null);
            if (r && ('artist_correct' in r)) {
                G.bonusRes = r;
                if (G.sel.artist || G.sel.movement) feel((!G.sel.artist || r.artist_correct) && (!G.sel.movement || r.movement_correct));
            }
        } catch (e) { if (G.st.kind !== 'live') G.bonusRes = { closed: true }; }   // the window closed: no bonus points
        if (G.st.kind !== 'live') { try { G.rev = await O().reveal(G.id, G.answer.position); } catch (e) { /* ignore */ } }
        if (G.st.kind === 'daily' && G.story) { try { G.story = await O().dailyStory(G.st.challenge_date || null); } catch (e) { /* keep */ } }
        if (G.bonusRes && G.bonusRes.closed && G.rev) {
            G.bonusRes.artist = G.rev.card.artist;
            G.bonusRes.movement = G.rev.card.movement_group;
        }
        refresh();
    }

    async function act(a) {
        try {
            if (a === 'skip' || a === 'lock') return pick();
            if (G.st.kind === 'solo' && a === 'next') {
                G.answer = null; G.card = null; G.rev = null; G.picked = false; G.sel = {}; G.bonusRes = null;
                G.local.index += 1;
                if (G.local.index < G.local.pile.length) {
                    openSoloCard();
                } else {
                    G.local.currentRaw = null;
                    G.st.phase = 'finished';
                    G.st.status = 'finished';
                    saveSoloOnce();
                    $('go-body').scrollTop = 0;
                }
                draw();
                return;
            }
            if (a === 'soloAgain') {
                return openSolo({
                    rounds: G.local.rounds,
                    cards: G.local.packId ? G.local.allCards : null,
                    packId: G.local.packId,
                    packTitle: G.local.packTitle,
                });
            }
            if (a === 'shareSolo') {
                const st = G.st;
                return shareText(t(G.local.packTitle ? 'solo.packShareText' : 'solo.shareText', {
                    pack: G.local.packTitle || '',
                    correct: st.me.correct,
                    total: st.card_count,
                    score: st.me.score.toLocaleString(),
                }) + '\n' + squares());
            }
            if (a === 'next' || a === 'ready') { G.answer = null; G.card = null; G.rev = null; G.wantCard = true; return refresh(); }
            if (a === 'start') { await O().startGame(G.id); return refresh(); }
            if (a === 'leave') { await O().leaveGame(G.id); return close(); }
            if (a === 'home') return close();
            if (a === 'shareDaily') {
                const st = G.st;
                return shareText(t('game.dailyShareText', { no: G.challengeNo || '', correct: st.me.correct, total: st.card_count, score: st.me.score.toLocaleString() }) + '\n' + squares());
            }
            if (a === 'runAgain') {
                const best = Math.max(G.prevBest || 0, G.st.me.score);
                const g = await O().startRun();
                return open(g.id, { prevBest: best });
            }
            if (a === 'shareRun') {
                const st = G.st, month = new Date().toLocaleString(window.CircI18n.lang, { month: 'long' });
                return shareText(t('run.share', { month, score: st.me.score.toLocaleString(), n: st.me.answered }) + '\n' + squares());
            }
            if (a === 'replayDaily') {
                await O().previewResetDaily();
                const g = await O().playDaily();
                return open(g.id, { challengeNo: g.challenge_no });
            }
            if (a === 'shareGame') {
                const st = G.st, rank = st.players.findIndex(p => p.is_me) + 1;
                return shareText(t('game.shareGame', { rank: '#' + rank, players: st.players.length, correct: st.me.correct, total: st.card_count, score: st.me.score.toLocaleString() }) + '\n' + squares());
            }
            if (a === 'rematch') { const r = await O().rematch(G.id); return open(r.id); }
            if (a === 'openRematch') return open(G.rematch.id);
            if (a === 'pushLater' || a === 'pushOn') {
                try { localStorage.setItem('circart-push-asked', '1'); } catch (e) { /* ignore */ }
                if (a === 'pushOn') { await O().enablePush(); window.CircShell.toast(t('push.done')); }
                return draw();
            }
            if (a === 'leaveYes') { await O().leaveGame(G.id); return close(); }
            if (a === 'share') {
                const url = location.origin + location.pathname + '?join=' + G.st.code;
                const text = t('game.shareText', { code: G.st.code });
                if (navigator.share) await navigator.share({ title: 'CIRCArt', text, url }).catch(() => {});
                else { await navigator.clipboard.writeText(text + ' ' + url); window.CircShell.toast(t('game.copied')); }
            }
        } catch (e) { window.CircShell.toast(e.message); }
    }

    // the ✕: an unfinished solo or live game asks first, everything else just goes home
    function leaveAsk() {
        if (!G || !G.st) return close();
        const isSolo = G.st.kind === 'solo' && G.st.phase === 'play';
        const isLive = G.st.kind === 'live' && ['play', 'reveal', 'waiting'].includes(G.st.phase);
        if (!isSolo && !isLive) return close();
        const m = document.createElement('div');
        m.className = 'modal';
        m.innerHTML = `<div class="modal-content" role="dialog" aria-modal="true" style="display:flex;flex-direction:column;gap:12px">
            <h2 class="serif" style="font-size:22px">${esc(t(isSolo ? 'back.leaveTitle' : 'game.leaveTitle'))}</h2>
            <p class="muted" style="font-size:14px">${esc(t(isSolo ? 'back.leaveSolo' : 'game.leaveLive'))}</p>
            <button class="btn primary block" data-x="no">${esc(t(isSolo ? 'back.stay' : 'game.leaveNo'))}</button>
            <button class="btn link" data-x="yes">${esc(t(isSolo ? 'back.leave' : 'game.leaveYes'))}</button></div>`;
        m.addEventListener('click', async e => {
            const x = e.target.closest('[data-x]');
            if (e.target === m || (x && x.dataset.x === 'no')) return m.remove();
            if (x && x.dataset.x === 'yes') {
                m.remove();
                if (!isSolo) { try { await O().leaveGame(G.id); } catch (err) { /* already gone */ } }
                close();
            }
        });
        document.body.appendChild(m);
        const keep = m.querySelector('[data-x="no"]');
        if (keep) keep.focus();
    }

    function reportContext() {
        if (!G || !G.st) return null;
        if (G.st.kind === 'solo') {
            const raw = G.local && G.local.currentRaw;
            return raw ? {
                sourceId: soloSourceId(raw, G.local.packId),
                title: raw.title,
                artist: raw.artist,
                year: raw.year,
                movement: raw.movement,
                medium: raw.medium,
                location: raw.location,
                revealed: !!G.rev,
                round: G.card ? G.card.position : null,
                total: G.st.card_count,
            } : null;
        }
        if (G.rev && G.rev.card) {
            return {
                sourceId: null,
                title: G.rev.card.title,
                artist: G.rev.card.artist,
                year: G.rev.card.year,
                revealed: true,
                round: G.rev.position || (G.card && G.card.position) || null,
                total: G.st.card_count,
            };
        }
        if (G.card) {
            return {
                sourceId: null,
                revealed: false,
                round: G.card.position,
                total: G.st.card_count,
            };
        }
        return null;
    }

    // the ✕ in the game header (no inline onclick: the Content-Security-Policy forbids it)
    document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.go-close')) leaveAsk(); });
    // back from the background (phone locked, other app): catch up at once instead of waiting for the next poll
    document.addEventListener('visibilitychange', () => { if (!document.hidden && G) refresh(); });
    window.CircGame = { open, openSolo, close, refresh, leaveAsk, reportContext };
})();
