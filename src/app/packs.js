// CIRCArt — card packs in the solo game.
//
// Packs live in docs/packs/<id>.json (built from claude/packs/*.json).
// Packs are kept strictly apart from the normal game (Julian, 6 Nov): their
// cards only ever appear when you choose "Play this pack" in the Gallery,
// which starts one solo game with only that pack's cards. Normal solo games,
// dailies, runs and games with friends use the base deck only. app.js stays
// untouched: when a solo game starts, the next request for artline.json is
// answered with the right deck, and app.js's cached deck is reset.
// Load after app.js. Exposes window.CircPacks.
/* global hitsterDeck */
(function () {
    'use strict';
    const realFetch = window.fetch.bind(window);
    const files = {};
    let armed = null;                            // null | { only: packId }

    async function packCards(id) {
        if (!files[id]) files[id] = realFetch('packs/' + id + '.json').then(r => r.json()).then(j => j.cards || []).catch(() => []);
        const de = window.CircI18n && window.CircI18n.lang === 'de';
        return (await files[id]).map(c => (de && c.trivia_de ? Object.assign({}, c, { trivia: c.trivia_de }) : c));
    }

    // The solo deck for "Play this pack": only that pack's cards
    async function deckFor(base, only) {
        const own = await packCards(only);
        return own.length >= 6 ? own : base;
    }

    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (armed && armed.only && /(^|\/)artline\.json(\?|$)/.test(url)) {
            const mode = armed; armed = null;
            const res = await realFetch(input, init);
            const base = await res.clone().json().catch(() => null);
            if (!Array.isArray(base)) return res;
            const deck = await deckFor(base, mode.only);
            return new Response(JSON.stringify(deck), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(input, init);
    };

    // fresh deck for the next start (app.js caches it in hitsterDeck)
    function reset() { try { hitsterDeck = null; } catch (e) { /* app.js not loaded */ } }   // eslint-disable-line no-global-assign
    function arm(only) { armed = { only }; reset(); }
    const startBtn = document.getElementById('start-btn');
    // a normal solo start after a pack game: back to the base deck
    let lastWasPack = false;
    if (startBtn) startBtn.addEventListener('click', () => {
        if (armed) { lastWasPack = true; return; }
        if (lastWasPack) { reset(); lastWasPack = false; }
    }, true);

    window.CircPacks = {
        setUnlocked() { /* packs are never mixed into normal games */ },
        // one solo game with only this pack (uses the round count chosen on the home screen)
        // one solo game with only this pack (uses the round count chosen on the home screen)
        // app.js's start only swaps the start screen for the game screen, so any
        // other open screen (the Gallery) is closed here first. Otherwise the
        // game opened in the bottom half, under the pack page (task 35).
        play(id) {
            arm(id);
            document.querySelectorAll('.screen.active').forEach(s => s.classList.remove('active'));
            const start = document.getElementById('start-screen');
            if (start) start.classList.add('active');
            window.scrollTo(0, 0);
            if (startBtn) startBtn.click();
        },
        cards: packCards,
    };
})();
