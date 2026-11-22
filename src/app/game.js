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
    const priceSid = raw => String((raw && (raw.source_id || raw.id)) || '');
    const priceVal = raw => Number(raw && raw.price_usd_today) || 0;
    const priceImg = raw => {
        const s = String((raw && (raw.image_local || raw.image)) || '').replace(/\\/g, '/');
        return /^https?:/i.test(s) ? '' : s;
    };

    const REACTIONS = ['🎨', '👏', '😮', '😅', '🔥'];

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
              challengeNo: extra && extra.challengeNo, prevBest: extra ? extra.prevBest : undefined, board: null, results: null, rematch: null, sel: {}, bonusRes: null,
              liveData: null, liveTurn: null, revResults: null, revResultsTurn: null, asyncPrevResults: null, asyncPrevTurn: null, triviaOpen: true, triviaTurn: null };
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
        if (window.CircCollection) window.CircCollection.record(soloSourceId(startCard, packId), false);

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

    function shuffleCopy(list) {
        const arr = (list || []).slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    function pickPriceChallenger(refCard, remaining, avoidSid) {
        if (!remaining.length) return null;
        const refP = priceVal(refCard);
        const fits = c => {
            const p = priceVal(c);
            return Math.abs(p - refP) / Math.max(1, Math.min(p, refP)) >= 0.10;
        };
        let idx = remaining.findIndex(c => fits(c) && (!avoidSid || priceSid(c) !== avoidSid));
        if (idx < 0) idx = remaining.findIndex(fits);
        if (idx < 0 && avoidSid) idx = remaining.findIndex(c => priceSid(c) !== avoidSid);
        if (idx < 0) idx = 0;
        return remaining.splice(idx, 1)[0] || null;
    }

    function openPrice(cards, { prevBest } = {}) {
        close(true);
        const valid = (cards || []).filter(c => c && priceImg(c) && priceVal(c) > 0);
        if (valid.length < 2) {
            if (window.CircShell && window.CircShell.toast) window.CircShell.toast(t('price.noCards'));
            close();
            return;
        }
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        $('game-online-screen').classList.add('active');

        const pool = shuffleCopy(valid);
        let lastPair = null;
        try { lastPair = JSON.parse(sessionStorage.getItem('circart-price-last-start') || 'null'); } catch (e) { lastPair = null; }
        if (Array.isArray(lastPair) && lastPair[0] && pool.length > 2 && priceSid(pool[0]) === lastPair[0]) {
            const swapIdx = pool.findIndex((c, i) => i > 0 && priceSid(c) !== lastPair[0]);
            if (swapIdx > 0) [pool[0], pool[swapIdx]] = [pool[swapIdx], pool[0]];
        }
        const ref = pool[0];
        const remaining = pool.slice(1);
        const firstChal = pickPriceChallenger(ref, remaining, Array.isArray(lastPair) ? lastPair[1] : null);
        try {
            sessionStorage.setItem('circart-price-last-start', JSON.stringify([priceSid(ref), firstChal ? priceSid(firstChal) : null]));
        } catch (e) { /* ignore */ }

        if (window.CircCollection && priceSid(ref) && !priceSid(ref).startsWith('price:')) {
            window.CircCollection.record(priceSid(ref), false);
        }

        G = {
            id: null,
            st: {
                kind: 'price',
                phase: 'play',
                status: 'playing',
                card_count: pool.length - 1,
                current_turn: 1,
                me: { score: 0, answered: 0, correct: 0, streak: 0, best_streak: 0 },
            },
            prevBest: prevBest === undefined ? null : prevBest,
            results: [],
            priceRev: null,
            price: {
                allCards: cards,
                ref,
                chal: firstChal,
                remaining,
                lives: 3,
                round: 1,
                startedAt: new Date().toISOString(),
                logCards: [{ id: priceSid(ref) }],
                ledger: [{ card: ref, start: true }],
                saved: false,
            },
        };
        $('go-body').scrollTop = 0;
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
        const cur = G;
        if (!cur || (cur.st && (cur.st.kind === 'solo' || cur.st.kind === 'price')) || !cur.id) return;
        if (refreshing) { again = true; return; }
        refreshing = true;
        try {
            const st = await O().getGame(cur.id);
            if (G !== cur) return;
            cur.st = st;
            if (unwatch && (st.kind === 'daily' || st.kind === 'run')) {
                unwatch();
                unwatch = null;
            }
            const live = st.kind === 'live';
            if (st.kind === 'daily' && O().dailyStory && (cur.story === undefined || cur.storyAt !== st.me.answered)) {
                try {
                    const story = await O().dailyStory(st.challenge_date || null);
                    if (G !== cur) return;
                    cur.story = story;
                } catch (e) {
                    if (G !== cur) return;
                    cur.story = null;
                }
                cur.storyAt = st.me.answered;
            }

            // a new live round or async turn: forget the previous card and any stale reveal
            if (live && st.phase !== 'reveal') {
                cur.rev = null; cur.revFor = null; cur.revResults = null; cur.revResultsTurn = null;
            }
            if (live && cur.card && cur.cardTurn !== st.current_turn) {
                cur.card = null;
            }
            if (live && cur.liveTurn != null && cur.liveTurn !== st.current_turn) {
                cur.liveData = null; cur.liveTurn = null;
            }
            if (cur.answer && live && (st.phase === 'play' || st.phase === 'waiting' || st.phase === 'reveal') && cur.answer.turn !== st.current_turn) {
                cur.answer = null; cur.card = null; cur.picked = false; cur.sel = {}; cur.bonusRes = null; cur.liveData = null; cur.liveTurn = null;
            }
            if (live && st.phase === 'reveal' && cur.revFor !== st.current_turn) {
                cur.answer = null; cur.card = null;
                try {
                    const rev = await O().reveal(cur.id, st.current_turn);
                    if (G !== cur) return;
                    cur.rev = rev; cur.revFor = st.current_turn;
                    if (!cur.rev.mine.timed_out || cur.rev.mine.slot != null) feel(liveGrade(cur.rev.mine).level, !!cur.rev.mine.correct);
                } catch (e) {
                    if (G !== cur) return;
                    cur.rev = null;
                }
            }
            if (live && st.phase === 'reveal') cur.answer = null;
            if (live && st.phase === 'reveal' && cur.rev && typeof O().roundResults === 'function') {
                try {
                    const rr = await O().roundResults(cur.id, st.current_turn);
                    if (G !== cur) return;
                    if (rr) { cur.revResults = rr; cur.revResultsTurn = st.current_turn; }
                } catch (e) {
                    if (G !== cur) return;
                }
            }
            // live deals the card to everyone at once; async waits for "Ready"
            if (st.phase === 'play' && !cur.answer && (!cur.card || cur.card.wait) && (live || cur.wantCard)) {
                const card = await O().nextCard(cur.id);
                if (G !== cur) return;
                cur.card = card;
                cur.cardTurn = st.current_turn;
            }
            // live waiting room data: only fetched after lock-in (or on reload in waiting phase)
            if (live && ((st.phase === 'waiting' && (!cur.answer || cur.picked)) || (st.phase === 'play' && cur.answer && cur.picked)) && typeof O().roundLive === 'function') {
                try {
                    const ld = await O().roundLive(cur.id);
                    if (G !== cur) return;
                    if (ld && (ld.turn == null || ld.turn === st.current_turn)) {
                        cur.liveData = ld;
                        cur.liveTurn = st.current_turn;
                    }
                } catch (e) {
                    if (G !== cur) return;
                }
            }
            // async: lazily load previous closed turn results for ready/waiting screens
            if (st.kind === 'async' && (st.current_turn > 1 || st.phase === 'waiting')) {
                const asyncPrevTurn = st.phase === 'waiting' && st.turn_closed ? st.current_turn : st.current_turn - 1;
                if (asyncPrevTurn >= 1 && typeof O().roundResults === 'function' && cur.asyncPrevTurn !== asyncPrevTurn) {
                    cur.asyncPrevTurn = asyncPrevTurn;
                    cur.asyncPrevResults = null;
                    try {
                        const prev = await O().roundResults(cur.id, asyncPrevTurn);
                        if (G !== cur) return;
                        cur.asyncPrevResults = prev || null;
                    } catch (e) {
                        if (G !== cur) return;
                        cur.asyncPrevResults = null;
                    }
                }
            }
            if ((st.kind === 'live' || st.kind === 'async') && (st.phase === 'lobby' || !cur.opts)) {
                try {
                    const opts = await O().gameOptions(cur.id);
                    if (G !== cur) return;
                    cur.opts = opts;
                } catch (e) {
                    if (G !== cur) return;
                    cur.opts = null;
                }
            }
            if ((st.phase === 'finished' || st.phase === 'done') && !cur.answer && !cur.results) {
                try {
                    const results = await O().myResults(cur.id);
                    if (G !== cur) return;
                    cur.results = results;
                } catch (e) {
                    if (G !== cur) return;
                    cur.results = [];
                }
            }
            if (st.phase === 'finished' && st.kind !== 'daily' && st.kind !== 'run') {
                try {
                    const rematch = await O().rematchInfo(cur.id);
                    if (G !== cur) return;
                    cur.rematch = rematch;
                } catch (e) {
                    if (G !== cur) return;
                    cur.rematch = null;
                }
            }
            if (st.kind === 'run' && st.phase === 'finished' && !cur.answer && !cur.board) {
                try {
                    const board = await O().monthlyLeaderboard();
                    if (G !== cur) return;
                    cur.board = board;
                } catch (e) {
                    if (G !== cur) return;
                    cur.board = { entries: [] };
                }
            }
            if (st.kind === 'daily' && st.phase === 'done' && !cur.answer && !cur.board) {
                try {
                    const board = await O().dailyLeaderboard();
                    if (G !== cur) return;
                    cur.board = board;
                    cur.challengeNo = cur.board.challenge_no;
                } catch (e) {
                    if (G !== cur) return;
                    cur.board = { entries: [] };
                }
            }
            if (G !== cur) return;
            draw();
            schedule();
        } catch (e) {
            if (G !== cur) return;
            $('go-body').innerHTML = `<p class="muted" style="padding:2rem">${esc(e.message)}</p>`;
        } finally {
            refreshing = false;
            if (again) { again = false; if (G) refresh(); }
        }
    }

    // timers: countdown redraws, and a re-fetch when a deadline passes
    function schedule() {
        clearInterval(tick); clearInterval(poll);
        const cur = G;
        if (!cur || !cur.st || cur.st.kind === 'solo' || cur.st.kind === 'price') return;
        const st = cur.st;
        const live = st.kind === 'live';
        let due = null, bonusDue = false;
        if (st.phase === 'play' && cur.card && cur.card.ends_at && !cur.answer && timed()) due = cur.card.ends_at;
        else if (cur.answer && !cur.picked && cur.answer.bonusEnds && st.kind !== 'live') { due = new Date(cur.answer.bonusEnds).toISOString(); bonusDue = true; }
        else if (st.phase === 'reveal') due = st.next_round_at;
        else if (live && (st.phase === 'waiting' || (st.phase === 'play' && cur.answer))) due = st.turn_deadline;
        if (due) {
            tick = setInterval(() => {
                if (G !== cur) { clearInterval(tick); return; }
                const ms = left(due);
                document.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = Math.ceil(ms / 1000); });
                const bar = $('go-bar');
                const total = bonusDue ? (cur.answer && cur.answer.bonusTotal) : (cur.card && cur.card.seconds ? cur.card.seconds * 1000 : 0);
                if (bar && total) bar.style.width = Math.max(0, Math.min(100, 100 * ms / total)) + '%';
                if (ms <= 0) { clearInterval(tick); if (bonusDue) pick(); else setTimeout(() => { if (G === cur) refresh(); }, 400); }   // bonus time up: send what's picked
            }, 200);
        }
        // realtime is primary; this catches a dropped connection (2.5s while on the live waiting room)
        const liveWaiting = live && (st.phase === 'waiting' || (st.phase === 'play' && !!cur.answer));
        const pollIfVisible = () => { if (G === cur && !document.hidden) refresh(); };    // no requests while the app is in the background
        if (['lobby', 'play', 'waiting', 'reveal'].includes(st.phase)) poll = setInterval(pollIfVisible, liveWaiting ? 2500 : live ? 4000 : 30000);
        else if (st.phase === 'finished' && st.kind !== 'daily' && st.kind !== 'run') poll = setInterval(pollIfVisible, 10000);   // a rematch may appear
    }

    // ─── drawing ──────────────────────────────────────────────────────────
    function draw() {
        const st = G.st;
        $('go-title').textContent = st.kind === 'solo' ? (G.local.packTitle || t('solo.title'))
            : st.kind === 'price' ? t('price.title')
            : st.kind === 'live' ? t('game.live')
            : st.kind === 'daily' ? (G.challengeNo ? t('game.daily', { no: G.challengeNo }) : t('game.dailyShort'))
            : st.kind === 'run' ? t('run.short')
            : t('game.async');
        const shown = G.answer && !G.picked && G.answer.scoreBefore != null ? G.answer.scoreBefore : st.me.score;   // no hint before lock-in
        $('go-score').textContent = (st.phase === 'lobby' || ((st.kind === 'solo' || st.kind === 'price') && st.phase === 'finished')) ? '' : t('game.points', { n: shown.toLocaleString() });
        const body = $('go-body');
        const stepKey = [
            st.kind,
            st.phase,
            st.current_turn,
            G.card ? G.card.position : '',
            G.answer ? (G.picked ? 'picked' : 'pick') : '',
            G.revFor || '',
            G.price ? G.price.round : '',
            G.priceRev ? 'prev' : '',
        ].join(':');
        const resetScroll = G._stepKey !== stepKey;
        const prevScroll = body.scrollTop;
        if (st.kind === 'price') {
            delete body.dataset.pickFor;
            G._stepKey = stepKey;
            body.innerHTML = st.phase === 'finished' ? viewPriceDone() : G.priceRev ? viewPriceReveal() : viewPricePlay();
            wire();
            body.scrollTop = resetScroll ? 0 : prevScroll;
            return;
        }
        if (G.answer) {
            // while picking, polls and live updates must not rebuild the picker (it flickered on every update)
            const key = G.answer.key || (G.answer.key = String(Math.random()).slice(2));   // one key per card answer
            if (!G.picked && body.dataset.pickFor === key) {
                const n = $('go-answered');
                if (n && st.kind === 'live') n.textContent = answeredLine();
                const lp = st.kind === 'live' ? body.querySelector('.lw-players') : null;
                if (lp) lp.innerHTML = livePlayersInner(false);
                return;
            }
            G._stepKey = stepKey;
            body.innerHTML = st.kind === 'live' ? viewLocked() : viewResult();
            if (G.picked) delete body.dataset.pickFor; else body.dataset.pickFor = key;
            wire();
            body.scrollTop = resetScroll ? 0 : prevScroll;
            return;
        }
        delete body.dataset.pickFor;
        G._stepKey = stepKey;
        const view = {
            lobby: viewLobby, play: viewPlay, waiting: viewWaiting, reveal: viewReveal, done: viewDailyDone,
            finished: () => (st.kind === 'solo' ? viewSoloDone() : st.kind === 'run' ? viewRunDone() : viewPodium()), dropped: () => note(t('game.dropped')), cancelled: () => note(t('game.cancelled')),
        }[st.phase] || (() => '');
        body.innerHTML = view();
        wire();
        body.scrollTop = resetScroll ? 0 : prevScroll;
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

    // ─── feedback you can feel: a colour flash, a mark, a short buzz ──────
    // Android buzzes; iPhone browsers don't allow vibration, so it's visual there.
    // level: 'ok' (all right), 'part' (some right), 'bad' (none); true/false work too.
    // The mark shows the year (✓ / ✗), the colour how the whole card went.
    function feel(level, yearOk) {
        const lv = level === true ? 'ok' : level === false ? 'bad' : level;
        try { if (navigator.vibrate) navigator.vibrate(lv === 'ok' ? 35 : lv === 'part' ? [35, 60, 35] : [45, 70, 45]); } catch (e) { /* ignore */ }
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const f = document.createElement('div');
        f.className = 'go-flash ' + lv;
        f.innerHTML = `<span>${(yearOk == null ? lv !== 'bad' : yearOk) ? '✓' : '✗'}</span>`;
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
                ${G.story ? `<p class="note">${esc(t(lookBack() ? 'story.howToLook' : 'story.howTo'))}</p>` : ''}
                ${startChapter()}
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
            <p class="muted" style="font-size:14px">${esc(timed() ? t('game.readyTextTimed', { n: st.cards_per_turn, s: st.answer_seconds || 20 }) : t('game.readyText', { n: st.cards_per_turn }))}</p>
            <button class="btn primary block" data-act="ready">${esc(t('game.startTurn', { n: st.current_turn }))}</button></section>
          <h2 class="label">${esc(t('game.standings'))}</h2>
          ${standings(99, true)}
          ${G.asyncPrevResults ? lastTurnPanel(G.asyncPrevResults) : ''}
        </div>`;
    }

    function stickyArt(src, title, extraImgCls) {
        const cls = ['zoomable-img', extraImgCls].filter(Boolean).join(' ');
        if (src) return `<div class="go-art"><img class="${cls}" src="${esc(src)}" alt="${esc(t('game.artAlt'))}"></div>`;
        return `<div class="go-art"><div class="go-typo serif">${esc(title || '?')}</div></div>`;
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
            ${stickyArt(c.image_url, c.title)}
          </div>
          <div class="row" style="justify-content:space-between"><b>${esc(t('game.tap'))}</b>
            ${G.st.kind === 'live' ? `<span class="note">${esc(t('game.answered', { n: G.st.players.filter(p => p.done_this_turn).length, total: G.st.players.filter(p => !p.dropped).length }))}</span>` : ''}</div>
          ${timeline(true)}
        </div>`;
    }

    // ─── grading one card: year, artist and style together ───────────────
    // Nothing is judged before lock-in; then every part gets its own ✓ / ✗ and
    // the headline says how it went overall (all, most, some or none right).
    function grade(r, b, asked) {
        if (r.timed_out) return { key: 'tooSlow', level: 'bad', parts: [] };
        const parts = [{ k: 'year', ok: !!r.correct }];
        if (asked.artist) parts.push({ k: 'artist', ok: !!(b && b.artist_correct) });
        if (asked.movement) parts.push({ k: 'style', ok: !!(b && b.movement_correct) });
        const n = parts.filter(x => x.ok).length;
        const key = n === parts.length ? 'perfect' : n === 0 ? 'none' : n === parts.length - 1 ? 'almost' : 'sketch';
        return { key, level: n === parts.length ? 'ok' : n ? 'part' : 'bad', parts };
    }
    const verdictText = g => g.key === 'tooSlow' ? t('game.tooSlow') : t('game.v.' + g.key);
    const verdictCls = g => g.level === 'ok' ? 'ok' : g.level === 'part' ? 'part' : 'bad';
    function gradeNow() {
        const r = G.answer.res;
        return grade(r, G.bonusRes, { artist: !!opts(r, 'artist'), movement: !!opts(r, 'movement') });
    }

    // the year: right → one calm line; wrong → where I put it and where it belongs,
    // on a short strip of my timeline (often it's only one card off)
    function yearBox(ok, year, ys, mine, right) {
        const y = `<b class="serif go-yb-year">${esc(year)}</b>`;
        if (ok) return `<section class="go-yearbox ok">${y}<span>${esc(t('game.rightSpot'))}</span></section>`;
        if (!Array.isArray(ys) || mine == null || right == null || mine === right) return year != null ? `<section class="go-yearbox bad">${y}</section>` : '';
        const n = ys.length, d = Math.abs(mine - right);
        const from = Math.max(0, Math.min(mine, right) - 1), to = Math.min(n, Math.max(mine, right) + 1);
        let strip = from > 0 ? '<li class="go-ob-more">…</li>' : '';
        for (let i = from; i <= to; i++) {
            if (i === mine) strip += `<li class="go-ob-gap bad">${esc(t('game.yourGuess'))}</li>`;
            if (i === right) strip += `<li class="go-ob-gap ok">${esc(year)}</li>`;
            if (i < to) strip += `<li class="go-ob-year">${esc(ys[i])}</li>`;
        }
        if (to < n) strip += '<li class="go-ob-more">…</li>';
        return `<section class="go-yearbox bad">
          <div class="go-yb-top">${y}<span>${esc(d === 1 ? t('game.offByOne') : t('game.offBy', { n: d }))}</span></div>
          <ol class="go-ob-strip" aria-hidden="true">${strip}</ol></section>`;
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

    function readyToLock() {
        const r = G.answer && G.answer.res;
        return !!r && (!opts(r, 'artist') || !!G.sel.artist) && (!opts(r, 'movement') || !!G.sel.movement);
    }

    function bonusSticky(leadHtml) {
        const ends = G.answer && !G.picked && G.answer.bonusEnds && G.st.kind !== 'live';
        const total = (G.answer && G.answer.bonusTotal) || 19000;
        const hasArt = !!(G.card && (G.card.image_url || G.card.title));
        const pct = ends ? Math.max(0, Math.min(100, 100 * (G.answer.bonusEnds - O().serverNow()) / total)) : 0;
        const secs = ends ? Math.max(0, Math.ceil((G.answer.bonusEnds - O().serverNow()) / 1000)) : 0;
        return `<div class="go-sticky">
          ${leadHtml || ends ? `<div class="row" style="justify-content:space-between">${leadHtml || '<span></span>'}${ends ? `<span class="go-timer" aria-live="off"><span data-countdown>${secs}</span>s</span>` : ''}</div>` : ''}
          ${ends ? `<div class="go-barbox" aria-hidden="true"><div id="go-bar" class="go-bar" style="width:${pct}%"></div></div>` : ''}
          ${hasArt ? stickyArt(G.card.image_url, G.card.title, 'go-bonus-art') : ''}
        </div>`;
    }

    function artistPicker() {
        const r = G.answer.res, a = opts(r, 'artist'), m = opts(r, 'movement');
        if (!a && !m) return '';
        if (G.picked && !G.sel.artist && !G.sel.movement) return '';
        const res = G.bonusRes;
        const solo = G.st.kind === 'solo';
        return `<section class="panel" style="padding:14px;display:flex;flex-direction:column;gap:14px">
          ${res && res.closed ? `<p class="note">${esc(t('game.bonusClosed'))}</p>` : ''}
          ${a ? bonusRow('artist', t('game.whoPainted'), solo ? 1 : 200, a) : ''}
          ${m ? bonusRow('movement', t('game.whichMovement'), solo ? 1 : 100, m) : ''}
          ${G.picked ? '' : `<button class="btn primary block" data-act="lock"${readyToLock() ? '' : ' style="display:none"'}>${esc(t('game.lockIn'))}</button><button class="btn link" data-act="skip">${esc(t('game.skip'))}</button>`}</section>`;
    }

    const answeredLine = () => t('game.answered', { n: G.st.players.filter(p => p.done_this_turn).length, total: G.st.players.filter(p => !p.dropped).length });

    function liveWaitingArt(ld) {
        const src = (G.card && G.card.image_url) || (ld && ld.card && ld.card.image_url) || (ld && ld.image_url) || '';
        const title = (G.card && G.card.title) || (ld && ld.card && ld.card.title) || '';
        if (src) return `<div class="go-art lw-art"><img class="zoomable-img" src="${esc(src)}" alt="${esc(t('game.artAlt'))}"></div>`;
        if (title) return `<div class="go-art lw-art"><div class="go-typo serif">${esc(title)}</div></div>`;
        return '';
    }

    function livePlayersInner(allowCall) {
        const ld = allowCall ? G.liveData : null;
        const list = (ld && Array.isArray(ld.players) && ld.players.length ? ld.players : (G.st.players || [])).filter(p => !p.dropped);
        const myCalls = (ld && ld.my_calls) || {};
        const endIso = G.st.turn_deadline;
        const secs = (timed() && endIso) ? Math.max(0, Math.ceil(left(endIso) / 1000)) : null;
        const rawLm = t('live.lockedMark');
        const rawTh = t('live.thinking');
        return list.map(p => {
            const isLocked = !!(p.locked || p.done_this_turn || (p.is_me && (G.picked || allowCall)));
            if (isLocked) {
                const lmText = rawLm.includes('{name}') ? t('live.lockedMark', { name: p.name }) : `✓ ${p.name}`;
                const lmAria = rawLm.includes('{name}') ? lmText : `${p.name} · ${rawLm}`;
                return `<span class="lw-pill locked" aria-label="${esc(lmAria)}">${esc(lmText)}</span>`;
            }
            const thText = rawTh.includes('{name}') ? t('live.thinking', { name: p.name }) : `${p.name} · ${rawTh}`;
            const cd = secs != null ? ` <span class="lw-cd"><span data-countdown>${secs}</span>s</span>` : '';
            const pill = `<span class="lw-pill thinking"><span class="lw-dot" aria-hidden="true"></span><span>${esc(thText)}</span>${cd}</span>`;
            if (!allowCall || p.is_me || p.seat == null || typeof O().callIt !== 'function') return pill;
            const saved = myCalls[String(p.seat)];
            const hasSaved = saved !== undefined && saved !== null;
            const pressedOk = hasSaved && (saved === true || saved === 1 || saved === '1');
            const pressedBad = hasSaved && (saved === false || saved === 0 || saved === '0');
            const prompt = t('live.callPrompt', { name: p.name });
            return `<div class="lw-player">${pill}<span class="lw-call" role="group" aria-label="${esc(prompt)}">
              <span class="lw-call-label note">${esc(prompt)}</span>
              <button type="button" class="chip lw-call-btn" data-call-seat="${esc(p.seat)}" data-call-ok="1" aria-pressed="${pressedOk}">${esc(t('live.callRight'))}</button>
              <button type="button" class="chip lw-call-btn" data-call-seat="${esc(p.seat)}" data-call-ok="0" aria-pressed="${pressedBad}">${esc(t('live.callWrong'))}</button>
            </span></div>`;
        }).join('');
    }

    function livePlayersBlock(allowCall) {
        const inner = livePlayersInner(allowCall);
        return inner ? `<div class="lw-players">${inner}</div>` : '';
    }

    function slotInitials(ld, slotIdx) {
        if (ld.slot_players && Array.isArray(ld.slot_players[String(slotIdx)])) {
            return ld.slot_players[String(slotIdx)].map(x => typeof x === 'string' ? x : (x.initials || (x.name || '?').trim().slice(0, 1).toUpperCase()));
        }
        return (ld.players || [])
            .filter(p => (p.locked || p.done_this_turn) && p.slot != null && Number(p.slot) === slotIdx)
            .map(p => p.initials || (p.name || '?').trim().slice(0, 1).toUpperCase());
    }

    function crowdHeatBlock(ld, picked) {
        if (!picked || !ld || !Array.isArray(ld.timeline_years) || !ld.timeline_years.length) return '';
        const lockedCount = ld.locked_count != null ? ld.locked_count : (Array.isArray(ld.players) ? ld.players.filter(p => p.locked).length : 0);
        if (!(lockedCount >= 1)) return '';
        const ys = ld.timeline_years, n = ys.length;
        const counts = ld.slot_counts || {};
        const activeTotal = (ld.players || G.st.players || []).filter(p => !p.dropped).length || lockedCount;
        const slotTotal = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
        const denom = Math.max(1, slotTotal || lockedCount);
        const mySlot = ld.my_slot != null ? Number(ld.my_slot) : (G.answer && G.answer.slot != null ? Number(G.answer.slot) : null);
        let rows = '';
        for (let i = n; i >= 0; i--) {
            const label = i === 0 ? t('game.before', { y: ys[0] }) : i === n ? t('game.after', { y: ys[n - 1] }) : `${ys[i - 1]} – ${ys[i]}`;
            const k = Number(counts[String(i)] || 0);
            const pct = Math.round(100 * k / denom);
            const badges = slotInitials(ld, i);
            rows += `<div class="lw-crowd-row${mySlot === i ? ' mine' : ''}">
              <span class="lw-crowd-label">${esc(label)}</span>
              <span class="go-dbar lw-bar"><span style="width:${pct}%"></span></span>
              <span class="lw-initials">${badges.map(b => `<span class="lw-init">${esc(b)}</span>`).join('')}</span>
            </div>`;
        }
        return `<section class="panel lw-crowd">
          <div class="row" style="justify-content:space-between;align-items:baseline">
            <b class="label" style="margin:0">${esc(t('live.crowdTitle'))}</b>
            <span class="note">${esc(t('live.crowdCount', { n: lockedCount, total: activeTotal, count: lockedCount, locked: lockedCount }))}</span>
          </div>
          <div class="lw-crowd-rows">${rows}</div>
        </section>`;
    }

    function lookCloserBlock(ld, picked) {
        const trivia = picked && ld ? de(ld, 'trivia') : '';
        if (!trivia) return '';
        if (G.triviaTurn !== G.st.current_turn) { G.triviaTurn = G.st.current_turn; G.triviaOpen = true; }
        return `<details class="panel lw-trivia"${G.triviaOpen !== false ? ' open' : ''}><summary>${esc(t('live.lookCloser'))}</summary><p>${esc(trivia)}</p></details>`;
    }

    function reactionsBlock(data) {
        if (!G.st || G.st.kind !== 'live' || typeof O().sendReaction !== 'function') return '';
        const rawList = (data && Array.isArray(data.reactions)) ? data.reactions : [];
        const opts = rawList.filter(r => r._opt);
        const srv = rawList.filter(r => !r._opt);
        const srvOrdered = (srv.length > 1 && srv[0].id == null) ? srv.slice().reverse() : srv;
        const list = [...opts, ...srvOrdered].slice(0, 8);
        const feed = list.length ? `<div class="lw-feed">${list.map(r => {
            const sender = r.name || r.player_name || r.display_name || r.from || '';
            return `<span class="lw-feed-item${r.is_me ? ' me' : ''}">${esc(r.emoji || '')}${sender ? ` <small>${esc(sender)}</small>` : ''}</span>`;
        }).join('')}</div>` : '';
        return `<div class="lw-react-wrap">
          <div class="lw-react-bar" role="group" aria-label="${esc(t('live.reactLabel'))}">
            <span class="note lw-react-label">${esc(t('live.reactLabel'))}</span>
            <div class="lw-react-btns">${REACTIONS.map(em => `<button type="button" class="lw-react-btn" data-react-emoji="${esc(em)}" aria-label="${esc(em)}">${esc(em)}</button>`).join('')}</div>
          </div>
          ${feed}
        </div>`;
    }

    function bonusState(p, kind) {
        const choiceKey = kind + '_choice', pickedKey = kind + '_picked', okKey = kind + '_correct';
        if (choiceKey in p) return p[choiceKey] != null ? (p[okKey] ? 'ok' : 'bad') : null;
        if (pickedKey in p) return p[pickedKey] ? (p[okKey] ? 'ok' : 'bad') : null;
        if (typeof p[okKey] === 'boolean') {
            if (p[okKey]) return 'ok';
            const optOn = kind === 'artist' ? (!G.opts || G.opts.artist_bonus !== false) : (!G.opts || G.opts.movement_bonus !== false);
            return (!p.timed_out && optOn) ? 'bad' : null;
        }
        return null;
    }

    function roundResultsBlock(rr, isAsync) {
        if (!rr) return '';
        const cards = (Array.isArray(rr.cards) && rr.cards.length) ? rr.cards
            : (Array.isArray(rr.players) && rr.players.length) ? [{ card: rr.card || null, title: rr.title, year: rr.year, players: rr.players }]
            : (Array.isArray(rr.results) && rr.results.length) ? [{ card: rr.card || null, title: rr.title, year: rr.year, players: rr.results }]
            : [];
        if (!cards.length) return '';
        const cbRaw = t('live.callBonus');
        const body = cards.map(c => {
            const rows = Array.isArray(c.players) ? c.players : Array.isArray(c.answers) ? c.answers : Array.isArray(c.results) ? c.results : (Array.isArray(rr.players) ? rr.players : []);
            if (!rows.length) return '';
            const info = c.card || c;
            const cTitle = info.title || '';
            const cYear = info.year != null ? info.year : '';
            const head = (isAsync || cards.length > 1) && (cTitle || cYear !== '')
                ? `<div class="rr-card-head">${cYear !== '' ? `<b class="serif">${esc(cYear)}</b>` : ''}<span>${esc(cTitle)}</span></div>`
                : '';
            const listHtml = rows.map(p => {
                const name = p.name || p.display_name || '?';
                const topP = (!isAsync && Array.isArray(rr.players))
                    ? rr.players.find(x => (p.seat != null && x.seat === p.seat) || (p.is_me && x.is_me) || (p.name && x.name === p.name))
                    : null;
                const callBonus = Number((p.call_bonus != null ? p.call_bonus : topP && topP.call_bonus) || 0);
                const pts = Number(p.points || 0);
                const aSt = bonusState(p, 'artist');
                const mSt = bonusState(p, 'movement');
                const placeMark = p.timed_out
                    ? `<span class="rr-mark bad">${esc(t('live.timedOutShort'))}</span>`
                    : p.correct
                        ? `<span class="rr-mark ok">✓</span>`
                        : `<span class="rr-mark bad">✗</span>`;
                const cbText = cbRaw.includes('{')
                    ? t('live.callBonus', { n: callBonus, pts: callBonus, points: callBonus })
                    : (!/\d/.test(cbRaw) ? `+${callBonus} ${cbRaw}` : cbRaw);
                return `<div class="rr-row${p.is_me ? ' me' : ''}">
                  <span class="rr-name">${esc(name)}</span>
                  <span class="rr-marks">${placeMark}${aSt ? `<span class="rr-mini ${aSt}" title="${esc(t('game.artistBonus'))}">🎨${aSt === 'ok' ? '✓' : '✗'}</span>` : ''}${mSt ? `<span class="rr-mini ${mSt}" title="${esc(t('game.movementBonus'))}">🖌️${mSt === 'ok' ? '✓' : '✗'}</span>` : ''}${callBonus > 0 ? `<span class="rr-call-pill">${esc(cbText)}</span>` : ''}</span>
                  <span class="rr-pts">+${pts.toLocaleString()}</span>
                </div>`;
            }).join('');
            return `<div class="rr-card">${head}<div class="rr-list">${listHtml}</div></div>`;
        }).filter(Boolean).join('');
        if (!body) return '';
        if (isAsync) return body;
        return `<section class="rr-section"><h2 class="label">${esc(t('live.roundBreakdown'))}</h2>${body}</section>`;
    }

    function lastTurnPanel(rr) {
        const inner = roundResultsBlock(rr, true);
        if (!inner) return '';
        return `<details class="panel rr-prev"><summary>${esc(t('live.lastTurnBreakdown'))}</summary>${inner}</details>`;
    }

    // live: you answered; the result comes when the round closes
    function viewLocked() {
        const a = G.answer;
        const timedOut = !!(a && a.res && a.res.timed_out);
        const picked = !!(G.picked || timedOut || (!a && G.st.phase === 'waiting' && G.liveData && G.liveData.me_locked !== false));
        const ld = picked ? G.liveData : null;
        const deadline = G.st.turn_deadline;
        const art = picked ? liveWaitingArt(ld) : (G.card && (G.card.image_url || G.card.title) ? stickyArt(G.card.image_url, G.card.title, 'go-bonus-art') : '');
        return `<div class="page">
          <div class="go-sticky">
            <div class="row" style="justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
              <h2 class="serif" style="font-size:24px">${esc(timedOut ? t('game.tooSlow') : t('game.locked'))}</h2>
              <p class="muted" style="font-size:13px"><span id="go-answered">${esc(answeredLine())}</span>${timed() && deadline ? ` · <span data-countdown>${Math.max(0, Math.ceil(left(deadline) / 1000))}</span>s` : ''}</p>
            </div>
            ${art}
          </div>
          ${!picked && a && !timedOut ? artistPicker() : ''}
          ${livePlayersBlock(picked)}
          ${picked ? crowdHeatBlock(ld, picked) : ''}
          ${picked ? lookCloserBlock(ld, picked) : ''}
          ${picked ? reactionsBlock(ld) : ''}
          ${picked && a && !timedOut ? artistPicker() : ''}
          ${standings(5)}
        </div>`;
    }

    // async / daily / run / solo: your own result right away, then the card's story
    function viewResult() {
        const a = G.answer, r = a.res, rev = G.rev, solo = G.st.kind === 'solo';
        if (!G.picked) {
            // still choosing: no verdict, no points, no flash until lock-in
            return `<div class="page">
              ${bonusSticky(`<span class="muted">${esc(t('game.placedWait'))}</span>`)}
              ${artistPicker()}
            </div>`;
        }
        const g = gradeNow();
        const aPts = solo ? 1 : 200, mPts = solo ? 1 : 100;
        const gained = (r.points || 0) + (rev && rev.mine.artist_correct ? aPts : 0) + (rev && rev.mine.movement_correct ? mPts : 0);
        const ys = rev && rev.timeline_years, mine = rev && rev.mine && rev.mine.slot != null ? rev.mine.slot : a.slot;
        return `<div class="page">
          <div class="go-vhead">
            <h2 class="serif go-verdict ${verdictCls(g)}">${esc(verdictText(g))}</h2>
            <b class="serif" style="font-size:26px">+${gained}</b></div>
          ${r.streak > 1 ? `<p class="note">${esc(t(solo ? 'solo.streak' : 'game.streak', { n: r.streak }))}</p>` : ''}
          ${rev && !r.timed_out ? yearBox(!!r.correct, rev.card && rev.card.year, ys, mine, rev.correct_slot) : ''}
          ${solo && !r.correct ? `<p class="note">${esc(t('solo.droppedNote'))}</p>` : ''}
          ${G.st.kind === 'run' ? `<p class="note">${hearts(G.st)} ${!r.correct ? esc(G.st.status === 'finished' ? t('run.over') : t('run.lifeLost')) : ''}</p>` : ''}
          ${artistPicker()}
          ${rev ? cardStory(rev) : ''}
          ${rev && G.story ? chapterFor(a.position) : ''}
          <button class="btn primary block" data-act="next">${esc(((G.st.kind === 'daily' || solo) && a.position >= G.st.card_count) || (G.st.kind === 'run' && G.st.status === 'finished') ? t('game.results') : t('game.next'))}</button>
        </div>`;
    }

    // ─── story dailies (019) ─────────────────────────────────────────────
    function chapterFor(pos) {
        const s = G.story;
        const ch = s && s.chapters && s.chapters.find(c => c.position === pos);
        if (!ch || !de(ch, 'chapter')) return '';
        return `<section class="panel go-chapter"><span class="eyebrow">${esc(t(lookBack() ? 'story.about' : 'story.next'))}</span>
          <p>${esc(de(ch, 'chapter'))}</p></section>`;
    }
    // 033: stories that look back — each chapter is about the card just placed;
    // the start card has its own chapter, and the results show the story in order
    const lookBack = () => !!(G.story && G.story.look_back);
    const chapterText = pos => {
        const s = G.story;
        if (!s) return '';
        if (pos === 0) return de(s, 'start_chapter') || '';
        const ch = s.chapters && s.chapters.find(c => c.position === pos);
        return ch ? de(ch, 'chapter') || '' : '';
    };
    function startChapter() {
        if (!lookBack() || !chapterText(0) || G.st.me.answered > 0) return '';
        const c = (G.st.timeline || []).find(x => x.position === 0);
        return `<div class="go-chapter go-start-chapter"><span class="eyebrow">${esc(t('story.startCard'))}${c ? ' · ' + esc(c.title) : ''}</span>
          <p>${esc(chapterText(0))}</p></div>`;
    }
    function storyRecap() {
        const tl = G.st.timeline || [];          // oldest first
        const item = c => `<li class="go-tl go-recap-item">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : '<span class="go-noimg"></span>'}
            <span><b class="serif">${esc(c.year)}</b> · <i>${esc(c.title)}</i><br><small>${esc(c.artist)}</small>
            ${chapterText(c.position) ? `<p class="go-recap-text">${esc(chapterText(c.position))}</p>` : ''}</span></li>`;
        return `<h2 class="label">${esc(t('story.whole'))}</h2>
          <ol class="go-timeline go-recap" aria-label="${esc(t('story.whole'))}">${tl.map(item).join('')}</ol>`;
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

    // live: a skipped question can't be told apart from one that wasn't asked, so only answered ones count
    const liveGrade = m => grade(m, m, { artist: !!m.artist_choice, movement: !!m.movement_choice });

    function viewReveal() {
        const rev = G.rev;
        if (!rev) return `<div class="page"><p class="muted">…</p></div>`;
        const m = rev.mine;
        const g = liveGrade(m);
        return `<div class="page">
          <div class="go-vhead">
            <h2 class="serif go-verdict ${verdictCls(g)}">${esc(verdictText(g))}</h2>
            <b class="serif" style="font-size:26px">+${m.points}</b></div>
          ${m.artist_choice ? `<p class="go-artline ${m.artist_correct ? 'ok' : 'bad'}">${esc(t('game.artistWas', { name: m.artist_choice }))} ${m.artist_correct ? '✓ +200' : '✗ · ' + esc(rev.card.artist)}</p>` : ''}
          ${m.movement_choice ? `<p class="go-artline ${m.movement_correct ? 'ok' : 'bad'}">${esc(t('game.movementWas', { name: m.movement_choice }))} ${m.movement_correct ? '✓ +100' : '✗ · ' + esc(rev.card.movement_group || '')}</p>` : ''}
          ${m.timed_out && m.slot == null ? '' : yearBox(!!m.correct, rev.card && rev.card.year, rev.timeline_years, m.slot, rev.correct_slot)}
          ${cardStory(rev)}
          ${distribution(rev)}
          ${roundResultsBlock(G.revResults, false)}
          ${reactionsBlock(G.revResults)}
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
          ${G.asyncPrevResults ? lastTurnPanel(G.asyncPrevResults) : ''}
          <h2 class="label">${esc(t('game.standings'))}</h2>
          ${standings(99, true)}
          ${st.timeline.length > 1 ? `<h2 class="label">${esc(t('game.timeline'))} · ${st.timeline.length}</h2>${timeline(false)}` : ''}
        </div>`;
    }

    function fmtUsd(n) {
        const v = Number(n);
        if (!Number.isFinite(v) || v <= 0) return '';
        const isDe = window.CircI18n && window.CircI18n.lang === 'de';
        if (v >= 1e9) {
            const b = Math.round(v / 1e8) / 10;
            return isDe ? `${String(b).replace('.', ',')} Mrd. $` : `$${b}B`;
        }
        if (v >= 1e6) {
            const m = Math.round(v / 100000) / 10;
            return isDe ? `${String(m).replace('.', ',')} Mio. $` : `$${m}M`;
        }
        if (v >= 1000) {
            return isDe ? `${Math.round(v).toLocaleString('de-DE')} $` : `$${Math.round(v).toLocaleString('en-US')}`;
        }
        return isDe ? `${v} $` : `$${v}`;
    }

    function fmtOrigSale(c) {
        const usd = fmtUsd(c && (c.price_usd ?? c.sale_price_usd ?? c.price_original_usd));
        const raw = String((c && c.sale_price_display) || '').trim();
        if (!raw || raw.startsWith('$')) return usd || raw;
        const isDe = window.CircI18n && window.CircI18n.lang === 'de';
        let localDisp = raw;
        const m = raw.match(/^([£€¥])\s*([\d.,]+)\s*([MBK])$/i);
        if (isDe && m) {
            const unit = m[3].toUpperCase() === 'M' ? 'Mio.' : m[3].toUpperCase() === 'B' ? 'Mrd.' : 'Tsd.';
            localDisp = `${m[2].replace('.', ',')} ${unit} ${m[1]}`;
        }
        return usd ? `${usd} (${localDisp})` : localDisp;
    }

    function priceRefLine(c) {
        const todayStr = t('price.todayAmount', { amount: fmtUsd(priceVal(c)) });
        const origAmt = fmtOrigSale(c);
        const saleYr = c && (c.sale_year ?? c.auction_year);
        if (origAmt && saleYr) return todayStr + ' · ' + t('price.inYear', { amount: origAmt, year: saleYr });
        if (saleYr) return todayStr + ' · ' + t('price.soldIn', { year: saleYr });
        return todayStr;
    }

    function priceRevLine(c) {
        const parts = [t('price.todayAmount', { amount: fmtUsd(priceVal(c)) })];
        const origAmt = fmtOrigSale(c);
        const saleYr = c && (c.sale_year ?? c.auction_year);
        const house = c && (c.auction_house ?? c.house ?? c.venue ?? '');
        if (origAmt && saleYr) parts.push(t('price.soldForIn', { amount: origAmt, year: saleYr }));
        else if (saleYr) parts.push(t('price.soldIn', { year: saleYr }));
        if (house) parts.push(house);
        return parts.join(' · ');
    }

    function priceStatusRow() {
        const pr = G.price;
        const h = `<span class="run-hearts" aria-label="${esc(t('run.lives'))}: ${pr.lives}">${'❤️'.repeat(pr.lives)}${'🤍'.repeat(3 - pr.lives)}</span>`;
        return `<div class="row price-bar">
          <span>${h} <b>${esc(t('price.round', { n: pr.round }))}</b></span>
          <span class="pill price-streak-pill">🔥 ${esc(t('price.bestStreakPill', { n: G.st.me.best_streak }))}</span>
        </div>`;
    }

    function viewPricePlay() {
        const pr = G.price, ref = pr.ref, chal = pr.chal;
        const refTitle = de(ref, 'title') || ref.title || '';
        const refMeta = [ref.artist || ref.artistDisplayName || '', ref.year].filter(Boolean).join(' · ');
        const chalTitle = de(chal, 'title') || chal.title || '';
        const chalMeta = [chal.artist || chal.artistDisplayName || '', chal.year].filter(Boolean).join(' · ');
        return `<div class="page">
          ${priceStatusRow()}
          <section class="panel price-ref">
            <img class="zoomable-img" src="${esc(priceImg(ref))}" alt="${esc(refTitle)}">
            <div class="price-ref-body">
              <span class="eyebrow">${esc(t('price.reference'))}</span>
              <b class="serif price-ref-title">${esc(refTitle)}</b>
              ${refMeta ? `<div class="note">${esc(refMeta)}</div>` : ''}
              <div class="price-ref-amt">${esc(priceRefLine(ref))}</div>
            </div>
          </section>
          <section class="panel strong price-chal">
            <div class="hcard-top">
              <span class="eyebrow">${esc(t('price.challenger'))}</span>
              <span class="price-q" aria-hidden="true">?</span>
            </div>
            <div class="go-art"><img class="zoomable-img" src="${esc(priceImg(chal))}" alt="${esc(chalTitle)}"></div>
            <div>
              <h2 class="serif price-chal-title">${esc(chalTitle)}</h2>
              ${chalMeta ? `<div class="muted">${esc(chalMeta)}</div>` : ''}
            </div>
            <div class="price-choices">
              <button class="btn primary block" data-price-dir="higher">${esc(t('price.higher'))}</button>
              <button class="btn outline block" data-price-dir="lower">${esc(t('price.lower'))}</button>
            </div>
          </section>
        </div>`;
    }

    function viewPriceReveal() {
        const pr = G.price, r = G.priceRev, c = r.card;
        const title = de(c, 'title') || c.title || '';
        const meta = [c.artist || c.artistDisplayName || '', c.year].filter(Boolean).join(' · ');
        const story = de(c, 'story') || de(c, 'trivia') || '';
        const isEnd = pr.lives <= 0 || pr.remaining.length === 0;
        return `<div class="page">
          ${priceStatusRow()}
          <div class="go-vhead">
            <h2 class="serif go-verdict ${r.ok ? 'ok' : 'bad'}">${esc(t(r.ok ? 'price.verdictOk' : 'price.verdictBad'))}</h2>
            <b class="serif" style="font-size:26px">${r.ok ? '+1' : '+0'}</b>
          </div>
          <section class="go-yearbox ${r.ok ? 'ok' : 'bad'} price-res-badge">
            <span>${esc(priceRevLine(c))}</span>
          </section>
          <section class="panel go-story">
            <img class="zoomable-img" src="${esc(priceImg(c))}" alt="${esc(title)}">
            <div>
              <div class="serif"><b>${esc(title)}</b></div>
              ${meta ? `<div class="muted">${esc(meta)}</div>` : ''}
              ${story ? `<p class="go-trivia">${esc(story)}</p>` : ''}
              ${c.credit ? `<p class="note go-credit">${esc(c.credit)}</p>` : ''}
            </div>
          </section>
          <button class="btn primary block" data-act="priceNext">${esc(t(isEnd ? 'game.results' : 'price.next'))}</button>
        </div>`;
    }

    function viewPriceDone() {
        const st = G.st, me = st.me, pr = G.price;
        const newBest = G.prevBest === null || (G.prevBest !== undefined && me.score > G.prevBest);
        return `<div class="page">
          <div style="text-align:center">
            <div class="label">${esc(t('price.done'))}</div>
            <h1 class="serif" style="font-size:40px">${me.score.toLocaleString()}</h1>
            <p class="note" style="margin-top:-6px">${esc(t('price.rightLabel'))}</p>
            ${newBest && me.score > 0 ? `<p class="run-best">🏆 ${esc(t('price.newBest'))}</p>` : ''}
            <p style="font-size:20px;letter-spacing:2px;margin:4px 0;word-break:break-all">${squares()}</p>
            <p class="muted">${esc(t('ranks.bestStreak'))} ${me.best_streak}</p>
          </div>
          <button class="btn primary block" data-act="priceAgain">${esc(t('game.playAgain'))}</button>
          <button class="btn outline block" data-act="sharePrice">${esc(t('game.dailyShare'))}</button>
          <h2 class="label">${esc(t('price.ledger'))}</h2>
          <ol class="go-timeline price-ledger">${pr.ledger.map(item => {
              const c = item.card;
              const title = de(c, 'title') || c.title || '';
              const mark = item.start ? esc(t('price.startLot')) : item.ok ? '✓' : '✗';
              const markCls = item.start ? 'start' : item.ok ? 'ok' : 'bad';
              return `<li class="go-tl price-ledger-row">
                <img class="zoomable-img" src="${esc(priceImg(c))}" alt="${esc(title)}">
                <span class="price-ledger-info">
                  <b>${esc(title)}</b>
                  <small>${esc([c.artist || c.artistDisplayName || '', c.year].filter(Boolean).join(' · '))}</small>
                  <small class="price-ledger-val">${esc(priceRevLine(c))}</small>
                </span>
                <span class="price-mark ${markCls}">${mark}</span>
              </li>`;
          }).join('')}</ol>
          <button class="btn outline block" data-act="home">${esc(t('game.home'))}</button>
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
          ${lookBack() ? storyRecap() : ''}
          ${G.story && de(G.story, 'outro') ? `<section class="panel go-chapter"><span class="eyebrow">${esc(de(G.story, 'title'))}</span>
            <p>${esc(de(G.story, 'outro'))}</p></section>` : ''}
          <button class="btn primary block" data-act="shareDaily">${esc(t('game.dailyShare'))}</button>
          ${top.length ? `<h2 class="label">${esc(t('ranks.today'))}</h2>
            <ol class="go-stand">${top.map(e => `<li class="${e.is_me ? 'me' : ''}"><span class="go-rank" style="width:28px">${e.rank}</span>
              <span class="go-name">${esc(e.username)}</span><span class="go-pts">${e.score.toLocaleString()}</span></li>`).join('')}</ol>` : ''}
          ${lookBack() ? '' : `<h2 class="label">${esc(t('game.yourTimeline'))}</h2>
          ${timeline(false)}`}
          <p class="note" style="text-align:center">${esc(t('game.dailyTomorrow'))}</p>
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

    async function sendCall(seat, ok) {
        const cur = G;
        if (!cur || !cur.st || cur.st.kind !== 'live' || !O().callIt) return;
        if (!(cur.picked || (!cur.answer && cur.st.phase === 'waiting'))) return;
        const turn = cur.st.current_turn;
        const pos = (cur.liveData && cur.liveData.position) || (cur.answer && cur.answer.position) || turn;
        const key = String(seat);
        const prevCalls = cur.liveData && cur.liveData.my_calls ? Object.assign({}, cur.liveData.my_calls) : {};
        if (!cur.liveData) cur.liveData = {};
        cur.liveData.my_calls = Object.assign({}, prevCalls, { [key]: ok });
        draw();
        try {
            const res = await O().callIt(cur.id, pos, seat, ok);
            if (G !== cur || !cur.st || cur.st.current_turn !== turn || !['play', 'waiting'].includes(cur.st.phase)) return;
            if (res && res.my_calls && cur.liveData) cur.liveData.my_calls = res.my_calls;
            refresh();
        } catch (e) {
            if (G !== cur) return;
            if (cur.liveData) cur.liveData.my_calls = prevCalls;
            draw();
            window.CircShell.toast(e.message);
        }
    }

    async function sendReact(emoji) {
        const cur = G;
        if (!cur || !cur.st || cur.st.kind !== 'live' || !O().sendReaction || !emoji) return;
        if (cur.st.phase !== 'reveal' && !(cur.picked || (!cur.answer && cur.st.phase === 'waiting'))) return;
        const turn = cur.st.current_turn;
        const mePlayer = (cur.st.players || []).find(p => p.is_me);
        const meName = (mePlayer && mePlayer.name) || '';
        const targetKey = cur.st.phase === 'reveal' ? 'revResults' : 'liveData';
        const hadObj = !!cur[targetKey];
        const prevList = hadObj && Array.isArray(cur[targetKey].reactions) ? cur[targetKey].reactions.slice() : null;
        if (!cur[targetKey]) cur[targetKey] = {};
        cur[targetKey].reactions = [{ emoji, name: meName, is_me: true, _opt: true }, ...(prevList || [])].slice(0, 8);
        draw();
        try {
            const res = await O().sendReaction(cur.id, emoji);
            if (G !== cur || !cur.st || cur.st.current_turn !== turn) return;
            if (res && Array.isArray(res.reactions) && cur[targetKey]) cur[targetKey].reactions = res.reactions;
            refresh();
        } catch (e) {
            if (G !== cur) return;
            if (cur[targetKey]) {
                if (prevList) cur[targetKey].reactions = prevList;
                else delete cur[targetKey].reactions;
            }
            draw();
            window.CircShell.toast(e.message);
        }
    }

    // ─── actions ──────────────────────────────────────────────────────────
    function wire() {
        const body = $('go-body');
        body.querySelectorAll('[data-gap]').forEach(b => b.addEventListener('click', () => place(+b.dataset.gap)));
        body.querySelectorAll('[data-price-dir]').forEach(b => b.addEventListener('click', () => guessPrice(b.dataset.priceDir)));
        body.querySelectorAll('[data-artist]').forEach(b => b.addEventListener('click', () => choose('artist', b.dataset.artist)));
        body.querySelectorAll('[data-movement]').forEach(b => b.addEventListener('click', () => choose('movement', b.dataset.movement)));
        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
        body.querySelectorAll('[data-call-seat][data-call-ok]').forEach(b => b.addEventListener('click', () => sendCall(Number(b.dataset.callSeat), b.dataset.callOk === '1')));
        body.querySelectorAll('[data-react-emoji]').forEach(b => b.addEventListener('click', () => sendReact(b.dataset.reactEmoji)));
        body.querySelectorAll('.lw-trivia').forEach(d => d.addEventListener('toggle', () => { if (G) G.triviaOpen = d.open; }));
        body.querySelectorAll('[data-opt]').forEach(c => c.addEventListener('change', async () => {
            const cur = G;
            if (!cur) return;
            const o = c.dataset.opt === 'artist' ? { artistBonus: c.checked }
                    : c.dataset.opt === 'timer' ? { timer: c.checked } : { movementBonus: c.checked };
            try {
                const opts = await O().setGameOptions(cur.id, o);
                if (G !== cur) return;
                cur.opts = opts;
            } catch (e) {
                if (G !== cur) return;
                window.CircShell.toast(e.message);
            }
            if (G === cur) draw();
        }));
        body.querySelectorAll('[data-secs]').forEach(b => b.addEventListener('click', async () => {
            const cur = G;
            if (!cur) return;
            try {
                const opts = await O().setGameOptions(cur.id, { seconds: Number(b.dataset.secs) });
                if (G !== cur) return;
                cur.opts = opts;
            } catch (e) {
                if (G !== cur) return;
                window.CircShell.toast(e.message);
            }
            if (G === cur) draw();
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
            mine: { artist_correct: aOk, movement_correct: mOk, slot: G.answer ? G.answer.slot : null },
            timeline_years: G.st.timeline.map(c => c.year),
            correct_slot: G.st.timeline.filter(c => c.year < raw.year).length,
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
                packTitle: G.local.packTitle || null,
                startedAt: G.local.startedAt,
                score: G.st.me.score,
                bonusPoints: G.local.bonusPoints,
                bestStreak: G.st.me.best_streak,
                cards: G.local.logCards,
            });
        }
    }

    async function place(slot) {
        const cur = G;
        if (!cur || !cur.card || cur.answer) return;
        if (cur.st.kind === 'solo') {
            const raw = cur.local.currentRaw;
            const tl = cur.st.timeline;
            const lo = tl[slot - 1], hi = tl[slot];
            const ok = (!lo || raw.year >= lo.year) && (!hi || raw.year <= hi.year);
            if (ok) tl.splice(slot, 0, formatTlCard(raw));
            cur.st.me.answered += 1;
            if (ok) {
                cur.st.me.correct += 1;
                cur.st.me.score += 1;
                cur.st.me.streak += 1;
                cur.st.me.best_streak = Math.max(cur.st.me.best_streak, cur.st.me.streak);
            } else {
                cur.st.me.streak = 0;
            }
            if (window.CircCollection) window.CircCollection.record(soloSourceId(raw, cur.local.packId), ok);
            const scoreBefore = cur.st.me.score - (ok ? 1 : 0);
            const res = {
                correct: ok,
                timed_out: false,
                points: ok ? 1 : 0,
                streak: cur.st.me.streak,
                artist_options: window.CircDealer.artistOptions(raw, cur.local.artistPool),
                movement_options: window.CircDealer.movementOptions(raw),
            };
            cur.answer = { position: cur.card.position, turn: cur.st.current_turn, res, slot, scoreBefore, bonusEnds: null, bonusTotal: 0 };
            cur.picked = !hasBonus(res) || !!res.timed_out;
            cur.sel = {};
            cur.bonusRes = null;
            cur.rev = null;
            if (cur.picked) { finalizeSoloCard(); feel(gradeNow().level, !!cur.answer.res.correct); }
            $('go-body').scrollTop = 0;
            draw();
            return;
        }
        const cardPos = cur.card.position;
        const turn = cur.st.current_turn;
        const kind = cur.st.kind;
        const cardEndsAt = cur.card.ends_at;
        const cardSeconds = cur.card.seconds;
        document.querySelectorAll('[data-gap]').forEach(b => { b.disabled = true; });
        const scoreBefore = G.st.me.score;
        try {
            const res = await O().answer(cur.id, cardPos, slot);
            if (G !== cur) return;
            if (kind === 'live' && cur.st && cur.st.current_turn !== turn) {
                refresh();
                return;
            }
            cur.answer = { position: cardPos, turn, res, slot, scoreBefore,
                         bonusEnds: kind !== 'live' && timed() && hasBonus(res) ? (kind === 'daily' && cardEndsAt ? new Date(cardEndsAt).getTime() : O().serverNow() + 19000) : null,
                         bonusTotal: kind === 'daily' && cardSeconds ? cardSeconds * 1000 : 19000 };
            cur.picked = !hasBonus(res) || !!res.timed_out;
            cur.sel = {}; cur.bonusRes = null;
            cur.rev = null;
            if (kind !== 'live' && cur.picked) {
                const rev = await O().reveal(cur.id, cur.answer.position);
                if (G !== cur) return;
                cur.rev = rev;
                feel(gradeNow().level, !!cur.answer.res.correct);                     // no questions to answer: judge right away
            }
        } catch (e) {
            if (G !== cur) return;
            window.CircShell.toast(e.message);
        }
        if (G === cur) refresh();
    }

    function choose(kind, name) {
        if (!G || !G.answer || G.picked) return;                  // nothing is revealed until lock-in, so changing is fine
        G.sel[kind] = name;
        // only the buttons change: no redraw, so nothing flickers or re-animates
        document.querySelectorAll(`#go-body [data-${kind}]`).forEach(b => {
            const on = b.dataset[kind] === name;
            b.classList.toggle('chosen', on);
            b.setAttribute('aria-pressed', String(on));
        });
        const lock = document.querySelector('#go-body [data-act="lock"]');
        if (lock) lock.style.display = readyToLock() ? '' : 'none';
    }

    async function pick() {
        const cur = G;
        if (!cur || !cur.answer || cur.picked) return;
        cur.picked = true;
        if (cur.st.kind === 'solo') {
            const raw = cur.local.currentRaw;
            const realArtist = (raw.artist || raw.artistDisplayName || '').trim();
            const realGroup = window.CircStyles ? window.CircStyles.groupOf(raw.movement) : null;
            const aOk = !!(cur.sel.artist && realArtist && cur.sel.artist === realArtist);
            const mOk = !!(cur.sel.movement && realGroup && cur.sel.movement === realGroup);
            const gained = (aOk ? 1 : 0) + (mOk ? 1 : 0);
            cur.st.me.score += gained;
            cur.local.bonusPoints += gained;
            cur.bonusRes = {
                artist_correct: aOk,
                artist: cur.sel.artist ? realArtist : null,
                movement_correct: mOk,
                movement: cur.sel.movement ? realGroup : null,
            };
            finalizeSoloCard();
            feel(gradeNow().level, !!cur.answer.res.correct);
            draw();
            return;
        }
        const ansPos = cur.answer.position;
        const kind = cur.st.kind;
        try {
            const r = await O().pickBonus(cur.id, ansPos, cur.sel.artist || null, cur.sel.movement || null);
            if (G !== cur) return;
            if (r && ('artist_correct' in r)) cur.bonusRes = r;
        } catch (e) {
            if (G !== cur) return;
            if (kind !== 'live') cur.bonusRes = { closed: true };
        }   // the window closed: no bonus points
        if (kind !== 'live') {
            try {
                const rev = await O().reveal(cur.id, ansPos);
                if (G !== cur) return;
                cur.rev = rev;
            } catch (e) { if (G !== cur) return; /* ignore */ }
        }
        if (kind === 'daily' && cur.story) {
            try {
                const story = await O().dailyStory(cur.st.challenge_date || null);
                if (G !== cur) return;
                cur.story = story;
            } catch (e) { if (G !== cur) return; /* keep */ }
        }
        if (G !== cur) return;
        if (cur.bonusRes && cur.bonusRes.closed && cur.rev) {
            cur.bonusRes.artist = cur.rev.card.artist;
            cur.bonusRes.movement = cur.rev.card.movement_group;
        }
        if (G.st.kind !== 'live') feel(gradeNow().level, !!G.answer.res.correct);   // the one and only verdict for this card
        refresh();
    }

    function savePriceOnce() {
        if (!G || !G.price || G.price.saved) return;
        G.price.saved = true;
        const payload = {
            mode: 'price',
            startedAt: G.price.startedAt,
            score: G.st.me.score,
            bonusPoints: 0,
            bestStreak: G.st.me.best_streak,
            cards: G.price.logCards,
        };
        if (window.CircShell && window.CircShell.soloGameFinished) {
            window.CircShell.soloGameFinished(payload);
        } else if (O() && O().saveSoloGame) {
            O().saveSoloGame(payload);
        }
    }

    function guessPrice(dir) {
        const cur = G;
        if (!cur || !cur.st || cur.st.kind !== 'price' || cur.st.phase !== 'play' || cur.priceRev) return;
        const pr = cur.price;
        const refP = priceVal(pr.ref), chalP = priceVal(pr.chal);
        const ok = dir === 'higher' ? chalP >= refP : chalP <= refP;
        cur.st.me.answered += 1;
        if (ok) {
            cur.st.me.score += 1;
            cur.st.me.correct += 1;
            cur.st.me.streak += 1;
            cur.st.me.best_streak = Math.max(cur.st.me.best_streak, cur.st.me.streak);
        } else {
            pr.lives = Math.max(0, pr.lives - 1);
            cur.st.me.streak = 0;
        }
        const sid = priceSid(pr.chal);
        if (window.CircCollection && sid && !sid.startsWith('price:')) {
            window.CircCollection.record(sid, ok);
        }
        cur.results.push({ correct: ok, timed_out: false, artist: false });
        pr.logCards.push({ id: sid, correct: ok, artist: false, title: false, year: false });
        pr.ledger.push({ card: pr.chal, ok, guessDir: dir });
        cur.priceRev = { ok, dir, card: pr.chal };
        feel(ok);
        $('go-body').scrollTop = 0;
        draw();
    }

    function priceNext() {
        const cur = G;
        if (!cur || !cur.st || cur.st.kind !== 'price' || !cur.priceRev) return;
        const pr = cur.price;
        if (pr.lives <= 0 || pr.remaining.length === 0) {
            cur.priceRev = null;
            cur.st.phase = 'finished';
            cur.st.status = 'finished';
            savePriceOnce();
            $('go-body').scrollTop = 0;
            draw();
            return;
        }
        pr.ref = pr.chal;
        pr.chal = pickPriceChallenger(pr.ref, pr.remaining, null);
        pr.round += 1;
        cur.st.current_turn = pr.round;
        cur.priceRev = null;
        $('go-body').scrollTop = 0;
        draw();
    }

    async function act(a) {
        const cur = G;
        if (!cur || !cur.st) return;
        try {
            if (a === 'skip' || a === 'lock') return pick();
            if (a === 'priceNext') return priceNext();
            if (a === 'priceAgain') {
                return openPrice(cur.price.allCards, { prevBest: Math.max(cur.prevBest || 0, cur.st.me.score) });
            }
            if (a === 'sharePrice') {
                const st = cur.st;
                return shareText(t('price.shareText', {
                    score: st.me.score.toLocaleString(),
                    streak: st.me.best_streak,
                }) + '\n' + squares());
            }
            if (cur.st.kind === 'solo' && a === 'next') {
                cur.answer = null; cur.card = null; cur.rev = null; cur.picked = false; cur.sel = {}; cur.bonusRes = null;
                cur.local.index += 1;
                if (cur.local.index < cur.local.pile.length) {
                    openSoloCard();
                } else {
                    cur.local.currentRaw = null;
                    cur.st.phase = 'finished';
                    cur.st.status = 'finished';
                    saveSoloOnce();
                    $('go-body').scrollTop = 0;
                }
                draw();
                return;
            }
            if (a === 'soloAgain') {
                return openSolo({
                    rounds: cur.local.rounds,
                    cards: cur.local.packId ? cur.local.allCards : null,
                    packId: cur.local.packId,
                    packTitle: cur.local.packTitle,
                });
            }
            if (a === 'shareSolo') {
                const st = cur.st;
                return shareText(t(cur.local.packTitle ? 'solo.packShareText' : 'solo.shareText', {
                    pack: cur.local.packTitle || '',
                    correct: st.me.correct,
                    total: st.card_count,
                    score: st.me.score.toLocaleString(),
                }) + '\n' + squares());
            }
            if (a === 'next' || a === 'ready') { cur.answer = null; cur.card = null; cur.rev = null; cur.wantCard = true; return refresh(); }
            if (a === 'start') { await O().startGame(cur.id); if (G !== cur) return; return refresh(); }
            if (a === 'leave') { await O().leaveGame(cur.id); if (G !== cur) return; return close(); }
            if (a === 'home') return close();
            if (a === 'shareDaily') {
                const st = cur.st;
                return shareText(t('game.dailyShareText', { no: cur.challengeNo || '', correct: st.me.correct, total: st.card_count, score: st.me.score.toLocaleString() }) + '\n' + squares());
            }
            if (a === 'runAgain') {
                const best = Math.max(cur.prevBest || 0, cur.st.me.score);
                const g = await O().startRun();
                if (G !== cur) return;
                return open(g.id, { prevBest: best });
            }
            if (a === 'shareRun') {
                const st = cur.st, month = new Date().toLocaleString(window.CircI18n.lang, { month: 'long' });
                return shareText(t('run.share', { month, score: st.me.score.toLocaleString(), n: st.me.answered }) + '\n' + squares());
            }
            if (a === 'shareGame') {
                const st = cur.st, rank = st.players.findIndex(p => p.is_me) + 1;
                return shareText(t('game.shareGame', { rank: '#' + rank, players: st.players.length, correct: st.me.correct, total: st.card_count, score: st.me.score.toLocaleString() }) + '\n' + squares());
            }
            if (a === 'rematch') { const r = await O().rematch(cur.id); if (G !== cur) return; return open(r.id); }
            if (a === 'openRematch') return open(cur.rematch.id);
            if (a === 'pushLater' || a === 'pushOn') {
                try { localStorage.setItem('circart-push-asked', '1'); } catch (e) { /* ignore */ }
                if (a === 'pushOn') {
                    await O().enablePush();
                    if (G !== cur) return;
                    window.CircShell.toast(t('push.done'));
                }
                if (G === cur) return draw();
                return;
            }
            if (a === 'leaveYes') { await O().leaveGame(cur.id); if (G !== cur) return; return close(); }
            if (a === 'share') {
                const url = location.origin + location.pathname + '?join=' + cur.st.code;
                const text = t('game.shareText', { code: cur.st.code });
                if (navigator.share) await navigator.share({ title: 'CIRCArt', text, url }).catch(() => {});
                else { await navigator.clipboard.writeText(text + ' ' + url); window.CircShell.toast(t('game.copied')); }
            }
        } catch (e) {
            if (G === cur) window.CircShell.toast(e.message);
        }
    }

    // the ✕: an unfinished solo or live game asks first, everything else just goes home
    function leaveAsk() {
        const cur = G;
        if (!cur || !cur.st) return close();
        const isSolo = (cur.st.kind === 'solo' || cur.st.kind === 'price') && cur.st.phase === 'play';
        const isLive = cur.st.kind === 'live' && ['play', 'reveal', 'waiting'].includes(cur.st.phase);
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
                if (!isSolo) { try { await O().leaveGame(cur.id); } catch (err) { /* already gone */ } }
                if (G === cur) close();
            }
        });
        document.body.appendChild(m);
        const keep = m.querySelector('[data-x="no"]');
        if (keep) keep.focus();
    }

    function reportContext() {
        if (!G || !G.st) return null;
        if (G.st.kind === 'price') {
            const rev = G.priceRev;
            const c = rev ? rev.card : (G.price && G.price.chal);
            if (!c) return null;
            const sid = priceSid(c);
            if (rev) {
                return {
                    sourceId: sid && !sid.startsWith('price:') ? sid : null,
                    title: c.title,
                    artist: c.artist || c.artistDisplayName || '',
                    year: c.year,
                    revealed: true,
                    round: G.price ? G.price.round : null,
                    total: G.st.card_count,
                };
            }
            return {
                sourceId: null,
                title: c.title,
                artist: c.artist || c.artistDisplayName || '',
                year: c.year,
                revealed: false,
                round: G.price ? G.price.round : null,
                total: G.st.card_count,
            };
        }
        if (G.st.kind === 'solo') {
            const raw = G.local && G.local.currentRaw;
            if (!raw) return null;
            if (G.rev && G.rev.card) {
                return {
                    sourceId: soloSourceId(raw, G.local.packId),
                    title: G.rev.card.title,
                    artist: G.rev.card.artist,
                    year: G.rev.card.year,
                    movement: raw.movement,
                    medium: raw.medium,
                    location: raw.location,
                    revealed: true,
                    round: G.card ? G.card.position : null,
                    total: G.st.card_count,
                };
            }
            return {
                sourceId: null,
                revealed: false,
                round: G.card ? G.card.position : null,
                total: G.st.card_count,
            };
        }
        if (G.rev && G.rev.card && !(G.st.kind === 'live' && G.st.phase !== 'reveal')) {
            return {
                sourceId: null,
                title: G.rev.card.title,
                artist: G.rev.card.artist,
                year: G.rev.card.year,
                movement: G.rev.card.movement_group || null,
                medium: G.rev.card.medium || null,
                location: G.rev.card.location || null,
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
    window.CircGame = { open, openSolo, openPrice, close, refresh, leaveAsk, reportContext };
})();
