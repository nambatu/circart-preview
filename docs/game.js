// CIRCArt — playing with friends: live rooms and async games.
//
// One screen for both, driven by the server's `phase` (lobby · play ·
// waiting · reveal · finished · dropped). The server owns the clock and the
// answers; this file only shows what get_game / next_card / reveal return.
// Live updates come from watchGame(); timers re-fetch at each deadline.

(function () {
    'use strict';

    const { t } = window.CircI18n;
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const O = () => window.CircOnline;

    let G = null;          // the open game: { id, st, card, answer, picked, rev, ... }
    let unwatch = null;
    let tick = null;       // countdown interval
    let poll = null;       // fallback refresh
    let refreshing = false, again = false;

    // ─── open / close ─────────────────────────────────────────────────────
    function open(id) {
        close(true);
        G = { id, st: null, card: null, answer: null, picked: false, rev: null, revFor: null, wantCard: false };
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        $('game-online-screen').classList.add('active');
        $('go-body').innerHTML = `<p class="muted" style="padding:2rem;text-align:center">…</p>`;
        unwatch = O().watchGame(id, () => refresh());
        refresh();
    }

    function close(silent) {
        if (unwatch) unwatch();
        clearInterval(tick); clearInterval(poll);
        unwatch = tick = poll = null;
        G = null;
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
        if (!G) return;
        if (refreshing) { again = true; return; }
        refreshing = true;
        try {
            const st = G.st = await O().getGame(G.id);
            const live = st.kind === 'live';

            // a new live round or async turn: forget the previous card
            if (G.answer && live && (st.phase === 'play' || st.phase === 'reveal') && G.answer.turn !== st.current_turn) {
                G.answer = null; G.card = null;
            }
            if (live && st.phase === 'reveal' && G.revFor !== st.current_turn) {
                G.answer = null; G.card = null;
                try { G.rev = await O().reveal(G.id, st.current_turn); G.revFor = st.current_turn; } catch (e) { G.rev = null; }
            }
            // live deals the card to everyone at once; async waits for "Ready"
            if (st.phase === 'play' && !G.answer && (!G.card || G.card.wait) && (live || G.wantCard)) {
                G.card = await O().nextCard(G.id);
                G.cardTurn = st.current_turn;
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
        const st = G.st;
        const live = st.kind === 'live';
        let due = null;
        if (st.phase === 'play' && G.card && G.card.ends_at && !G.answer) due = G.card.ends_at;
        else if (st.phase === 'reveal') due = st.next_round_at;
        else if (live && st.phase === 'waiting') due = st.turn_deadline;
        if (due) {
            tick = setInterval(() => {
                const ms = left(due);
                document.querySelectorAll('[data-countdown]').forEach(el => { el.textContent = Math.ceil(ms / 1000); });
                const bar = $('go-bar');
                if (bar && G.card && G.card.seconds) bar.style.width = (100 * ms / (G.card.seconds * 1000)) + '%';
                if (ms <= 0) { clearInterval(tick); setTimeout(refresh, 400); }
            }, 200);
        }
        // realtime is primary; this catches a dropped connection
        if (['lobby', 'play', 'waiting', 'reveal'].includes(st.phase)) poll = setInterval(refresh, live ? 4000 : 30000);
    }

    // ─── drawing ──────────────────────────────────────────────────────────
    function draw() {
        const st = G.st;
        $('go-title').textContent = st.kind === 'live' ? t('game.live') : t('game.async');
        $('go-score').textContent = st.phase === 'lobby' ? '' : t('game.points', { n: st.me.score.toLocaleString() });
        const body = $('go-body');
        if (G.answer) return body.innerHTML = st.kind === 'live' ? viewLocked() : viewResult(), wire();
        const view = {
            lobby: viewLobby, play: viewPlay, waiting: viewWaiting, reveal: viewReveal,
            finished: viewPodium, dropped: () => note(t('game.dropped')), cancelled: () => note(t('game.cancelled')),
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
          ${st.is_host
              ? `<button class="btn primary block" data-act="start" ${st.players.length < 2 ? 'disabled' : ''}>${esc(st.players.length < 2 ? t('game.waitPlayers') : t('game.start'))}</button>`
              : `<p class="muted" style="text-align:center">${esc(t('game.waitHost'))}</p>`}
          <button class="btn link" data-act="leave">${esc(t('game.leave'))}</button>
        </div>`;
    }

    function timeline(clickable) {
        const tl = G.st.timeline;              // oldest first; the gap index is what the server wants
        const gap = i => {
            const lo = tl[i - 1], hi = tl[i];
            const label = !lo ? t('game.before', { y: hi.year }) : !hi ? t('game.after', { y: lo.year }) : t('game.between', { a: lo.year, b: hi.year });
            return clickable ? `<li><button class="go-gap" data-gap="${i}">+ ${esc(label)}</button></li>` : '';
        };
        const card = c => `<li class="go-tl">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : '<span class="go-noimg"></span>'}
            <b class="serif">${c.year}</b><span>${esc(c.title)}<br><small>${esc(c.artist)}</small></span></li>`;
        let out = gap(tl.length);
        for (let i = tl.length - 1; i >= 0; i--) out += card(tl[i]) + gap(i);
        return `<ol class="go-timeline" aria-label="${esc(t('game.timeline'))}">${out}</ol>`;
    }

    function viewReady() {
        const st = G.st;
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
          <div class="row" style="justify-content:space-between">
            <span><b>${esc(t('game.card', { n: c.position, total }))}</b></span>
            <span class="go-timer" aria-live="off"><span data-countdown>${Math.ceil(left(c.ends_at) / 1000)}</span>s</span>
          </div>
          <div class="go-barbox" aria-hidden="true"><div id="go-bar" class="go-bar"></div></div>
          <div class="go-art">${c.image_url ? `<img src="${esc(c.image_url)}" alt="${esc(t('game.artAlt'))}">` : `<div class="go-typo serif">${esc(c.title || '?')}</div>`}</div>
          <div class="row" style="justify-content:space-between"><b>${esc(t('game.tap'))}</b>
            ${G.st.kind === 'live' ? `<span class="note">${esc(t('game.answered', { n: G.st.players.filter(p => p.done_this_turn).length, total: G.st.players.filter(p => !p.dropped).length }))}</span>` : ''}</div>
          ${timeline(true)}
        </div>`;
    }

    function artistPicker() {
        const a = G.answer;
        if (!a.res.artist_options || G.picked) return '';
        return `<section class="panel" style="padding:14px;display:flex;flex-direction:column;gap:8px">
          <b>${esc(t('game.whoPainted'))} <span class="note">+200</span></b>
          <div class="two">${a.res.artist_options.map(n => `<button class="btn quiet" data-artist="${esc(n)}">${esc(n)}</button>`).join('')}</div>
          <button class="btn link" data-act="skip">${esc(t('game.skip'))}</button></section>`;
    }

    // live: you answered; the result comes when the round closes
    function viewLocked() {
        const a = G.answer;
        return `<div class="page">
          <h2 class="serif" style="font-size:26px">${esc(a.res.timed_out ? t('game.tooSlow') : t('game.locked'))}</h2>
          ${a.res.timed_out ? '' : artistPicker()}
          <p class="muted">${esc(t('game.answered', { n: G.st.players.filter(p => p.done_this_turn).length, total: G.st.players.filter(p => !p.dropped).length }))}
            · <span data-countdown>${Math.ceil(left(G.st.turn_deadline) / 1000)}</span>s</p>
          ${standings(5)}
        </div>`;
    }

    // async: your own result right away, then the card's story
    function viewResult() {
        const a = G.answer, r = a.res, rev = G.rev;
        const verdict = r.timed_out ? t('game.tooSlow') : r.correct ? t('game.correct') : t('game.wrong');
        return `<div class="page">
          <div class="row" style="justify-content:space-between">
            <h2 class="serif go-verdict ${r.correct ? 'ok' : 'bad'}">${esc(verdict)}</h2>
            <b class="serif" style="font-size:26px">+${(r.points || 0) + (rev && rev.mine.artist_correct ? 200 : 0)}</b></div>
          ${r.streak > 1 ? `<p class="note">${esc(t('game.streak', { n: r.streak }))}</p>` : ''}
          ${artistPicker()}
          ${rev ? cardStory(rev) : ''}
          ${G.picked || !r.artist_options ? `<button class="btn primary block" data-act="next">${esc(t('game.next'))}</button>` : ''}
        </div>`;
    }

    function cardStory(rev) {
        const c = rev.card;
        return `<section class="panel go-story">
          ${c.image_url ? `<img src="${esc(c.image_url)}" alt="${esc(c.title)}">` : ''}
          <div><b class="serif" style="font-size:26px">${c.year}</b>
            <div class="serif"><i>${esc(c.title)}</i></div>
            <div class="muted">${esc(c.artist)}${rev.mine.artist_choice ? (rev.mine.artist_correct ? ' ✓' : '') : ''}</div>
            ${c.trivia ? `<p class="go-trivia">${esc(c.trivia)}</p>` : ''}</div></section>`;
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
          <h2 class="label">${esc(t('game.standings'))}</h2>
          ${standings(99, true)}
          ${st.timeline.length > 1 ? `<h2 class="label">${esc(t('game.timeline'))} · ${st.timeline.length}</h2>${timeline(false)}` : ''}
        </div>`;
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
          <h2 class="label">${esc(t('game.timeline'))}</h2>
          ${timeline(false)}
          <button class="btn outline block" data-act="home">${esc(t('game.home'))}</button>
        </div>`;
    }

    // ─── actions ──────────────────────────────────────────────────────────
    function wire() {
        const body = $('go-body');
        body.querySelectorAll('[data-gap]').forEach(b => b.addEventListener('click', () => place(+b.dataset.gap)));
        body.querySelectorAll('[data-artist]').forEach(b => b.addEventListener('click', () => pick(b.dataset.artist)));
        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
    }

    async function place(slot) {
        if (!G.card || G.answer) return;
        document.querySelectorAll('[data-gap]').forEach(b => { b.disabled = true; });
        try {
            const res = await O().answer(G.id, G.card.position, slot);
            G.answer = { position: G.card.position, turn: G.st.current_turn, res };
            G.picked = !res.artist_options;
            G.rev = null;
            if (G.st.kind !== 'live' && G.picked) G.rev = await O().reveal(G.id, G.answer.position);
        } catch (e) {
            window.CircShell.toast(e.message);
        }
        refresh();
    }

    async function pick(name) {
        if (!G.answer || G.picked) return;
        G.picked = true;
        try { await O().pickArtist(G.id, G.answer.position, name); } catch (e) { /* the window closed: no bonus */ }
        if (G.st.kind !== 'live') { try { G.rev = await O().reveal(G.id, G.answer.position); } catch (e) { /* ignore */ } }
        refresh();
    }

    async function act(a) {
        try {
            if (a === 'skip') return pick(null);
            if (a === 'next' || a === 'ready') { G.answer = null; G.card = null; G.rev = null; G.wantCard = true; return refresh(); }
            if (a === 'start') { await O().startGame(G.id); return refresh(); }
            if (a === 'leave') { await O().leaveGame(G.id); return close(); }
            if (a === 'home') return close();
            if (a === 'share') {
                const url = location.origin + location.pathname + '?join=' + G.st.code;
                const text = t('game.shareText', { code: G.st.code });
                if (navigator.share) await navigator.share({ title: 'CIRCArt', text, url }).catch(() => {});
                else { await navigator.clipboard.writeText(text + ' ' + url); window.CircShell.toast(t('game.copied')); }
            }
        } catch (e) { window.CircShell.toast(e.message); }
    }

    window.CircGame = { open, close, refresh };
})();
