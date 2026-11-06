// CIRCArt — card packs in the solo game.
//
// Packs live in docs/packs/<id>.json (built from claude/packs/*.json).
// Unlocked packs (server: my_packs) are mixed into solo games; "Play this
// pack" starts one solo game with only that pack's cards. app.js stays
// untouched: when a solo game starts, the next request for artline.json is
// answered with the right deck, and app.js's cached deck is reset.
// Load after app.js. Exposes window.CircPacks.
/* global hitsterDeck */
(function () {
    'use strict';
    const MIX_KEY = 'circart-pack-mix';          // '0' = don't mix unlocked packs into solo games
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    };
    const realFetch = window.fetch.bind(window);
    const files = {};
    let unlocked = [];                           // pack ids this player has
    let armed = null;                            // null | { only: packId | null }

    async function packCards(id) {
        if (!files[id]) files[id] = realFetch('packs/' + id + '.json').then(r => r.json()).then(j => j.cards || []).catch(() => []);
        const de = window.CircI18n && window.CircI18n.lang === 'de';
        return (await files[id]).map(c => (de && c.trivia_de ? Object.assign({}, c, { trivia: c.trivia_de }) : c));
    }

    // The solo deck for the game that is starting.
    async function deckFor(base, only) {
        if (only) {
            const own = await packCards(only);
            return own.length >= 6 ? own : base.concat(own);
        }
        if (store.get(MIX_KEY) === '0' || !unlocked.length) return base;
        const extra = (await Promise.all(unlocked.map(packCards))).flat();
        return base.concat(extra);
    }

    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (armed && /(^|\/)artline\.json(\?|$)/.test(url)) {
            const mode = armed; armed = null;
            const res = await realFetch(input, init);
            const base = await res.clone().json().catch(() => null);
            if (!Array.isArray(base)) return res;
            const deck = await deckFor(base, mode.only);
            return new Response(JSON.stringify(deck), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(input, init);
    };

    // every solo start: fresh deck (app.js caches it in hitsterDeck)
    function arm(only) {
        armed = { only: only || null };
        try { hitsterDeck = null; } catch (e) { /* app.js not loaded */ }   // eslint-disable-line no-global-assign
    }
    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.addEventListener('click', () => { if (!armed) arm(null); }, true);

    window.CircPacks = {
        setUnlocked(ids) { unlocked = ids || []; },
        mixing: () => store.get(MIX_KEY) !== '0',
        setMixing(on) { store.set(MIX_KEY, on ? '1' : '0'); },
        // one solo game with only this pack (uses the round count chosen on the home screen)
        play(id) { arm(id); if (startBtn) startBtn.click(); },
        cards: packCards,
    };
})();
