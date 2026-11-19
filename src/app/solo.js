// CIRCArt — solo game: tap-to-answer bonus questions instead of typing.
//
// Before placing a card you may answer "Who made it?" and "Which movement?"
// (4 choices each, +1 point each, like before). After placing: a green/red
// flash, a short buzz on Android, and a feedback line per answer.
// app.js stays untouched: its typed artist field is filled in for it (so its
// own scoring counts the artist), the movement is scored here.
// Load after app.js and shell.js.
/* global currentCard, score, bonusPoints, updateScoreUI, addFeedbackItem */
(function () {
    'use strict';
    const { t } = window.CircI18n;
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // same groups as the server (migration 007): label → [movement, rough order]
    const GROUPS = window.CircStyles.GROUPS;   // styles.js (same groups as the server, migrations 007 + 027)

    let deck = null, pick = { artist: null, movement: null }, q = null;
    const load = async () => deck || (deck = await (await fetch('artline.json', { cache: 'no-cache' })).json().catch(() => []));
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

    // 3 other artists, preferably from around the same time (harder, fairer)
    function artistOptions(card) {
        const real = (card.cleanArtist || card.artistDisplayName || '').trim();
        if (!real || /unknown/i.test(real)) return null;
        const byArtist = new Map();
        // app.js scores the pick with a loose fuzzyMatch, so a look-alike name
        // (e.g. "Jan van Eyck" for "Hubert and Jan van Eyck") would count as
        // right: leave those out
        const fm = typeof window.fuzzyMatch === 'function' ? window.fuzzyMatch : (x, y) => x === y;
        (deck || []).forEach(c => {
            const a = (c.artist || '').trim();
            if (a && a !== real && !/unknown/i.test(a) && !fm(a, real) && !fm(real, a)) byArtist.set(a, c.year);
        });
        const others = shuffle([...byArtist.entries()]).sort((x, y) => Math.abs(x[1] - card.objectEndDate) - Math.abs(y[1] - card.objectEndDate));
        const near = shuffle(others.slice(0, 8)).slice(0, 3).map(x => x[0]);
        return near.length === 3 ? shuffle([real, ...near]) : null;
    }
    function movementOptions(card) {
        const g = GROUPS[card.movement];
        if (!g) return null;
        const all = [...new Map(Object.values(GROUPS).map(([n, o]) => [n, o])).entries()].filter(([n]) => n !== g[0]);
        const near = shuffle(all.filter(([, o]) => Math.abs(o - g[1]) <= 5)).slice(0, 3).map(x => x[0]);
        return near.length === 3 ? shuffle([g[0], ...near]) : null;
    }

    function feel(ok) {
        try { if (navigator.vibrate) navigator.vibrate(ok ? 35 : [45, 70, 45]); } catch (e) { /* ignore */ }
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const f = document.createElement('div');
        f.className = 'go-flash ' + (ok ? 'ok' : 'bad');
        f.innerHTML = '<span>' + (ok ? '✓' : '✗') + '</span>';
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 900);
    }

    function render() {
        const box = $('solo-bonus');
        if (!box || !q) return;
        const row = (kind, title, list) => list ? `<div class="solo-q" role="group" aria-label="${esc(title)}"><b>${esc(title)} <span class="note">+1</span>${kind === 'movement' ? ' ' + window.CircStyles.helpButton(list) : ''}</b>
            <div class="two">${list.map(n => `<button type="button" class="go-pick ${pick[kind] === n ? 'chosen' : ''}" data-solo-${kind}="${esc(n)}" aria-pressed="${pick[kind] === n}">${esc(n)}</button>`).join('')}</div></div>` : '';
        box.innerHTML = (q.artist || q.movement)
            ? row('artist', t('game.whoPainted'), q.artist) + row('movement', t('game.whichMovement'), q.movement)
            : '';
        box.querySelectorAll('[data-solo-artist]').forEach(b => b.addEventListener('click', () => { pick.artist = pick.artist === b.dataset.soloArtist ? null : b.dataset.soloArtist; render(); }));
        box.querySelectorAll('[data-solo-movement]').forEach(b => b.addEventListener('click', () => { pick.movement = pick.movement === b.dataset.soloMovement ? null : b.dataset.soloMovement; render(); }));
    }

    async function newCard() {
        await load();
        pick = { artist: null, movement: null };
        q = currentCard ? { artist: artistOptions(currentCard), movement: movementOptions(currentCard) } : null;
        // the info page shows the same style the question uses (the group)
        if (currentCard && $('active-movement')) {
            const g = GROUPS[currentCard.movement];
            $('active-movement').textContent = g ? g[0] : t('card.unknown');
        }
        render();
    }

    function hook() {
        if (typeof window.placeCard !== 'function' || typeof window.prepareNextRound !== 'function') return;
        const section = $('bonus-section');
        section.classList.add('solo-mc');
        const h = section.querySelector('h3'); if (h) h.textContent = t('solo.bonusTitle');
        const hint = section.querySelector('.hint'); if (hint) hint.textContent = t('solo.bonusHint');
        const box = document.createElement('div');
        box.id = 'solo-bonus';
        section.insertBefore(box, section.querySelector('.instruction'));

        // app.js draws each card itself (its Continue button holds its own
        // reference to prepareNextRound), so watch for the new card's title
        let last = null;
        new MutationObserver(() => { if (currentCard && currentCard !== last) { last = currentCard; newCard(); } })
            .observe($('active-title'), { childList: true, characterData: true, subtree: true });

        const origPlace = window.placeCard;
        window.placeCard = function (index) {
            if (!$('feedback-area').classList.contains('hidden')) return origPlace(index);
            const card = currentCard;
            $('guess-artist').value = pick.artist || '';          // app.js scores the artist (+1)
            $('guess-title').value = ''; $('guess-year').value = '';
            const before = score - bonusPoints;
            const r = origPlace(index);
            const placedRight = (score - bonusPoints) > before;   // bonus points don't count here
            if (pick.movement) {
                const g = GROUPS[card.movement];
                if (g && pick.movement === g[0]) {
                    score += 1; bonusPoints += 1;                 // eslint-disable-line no-global-assign
                    addFeedbackItem(t('solo.movementRight', { name: g[0] }), true);
                } else addFeedbackItem(t('solo.movementWrong', { name: g ? g[0] : card.movement }), false);
                updateScoreUI();
            }
            feel(placedRight);
            return r;
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();
})();
