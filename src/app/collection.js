// CIRCArt — lasting list of the cards this device has met and placed right.
// Julian's original solo game only remembers cards for 6 hours; the Gallery
// needs a list that stays (and also works offline / without an account).
// Solo rounds are caught by wrapping the game's own track() call. Online games
// are already stored on the server (my_collection), merged in by merged().
// Load after app.js. Only card ids are stored, nothing else.
(function () {
    'use strict';
    const KEY = 'circart-collection';

    function read() {
        try {
            const d = JSON.parse(localStorage.getItem(KEY) || 'null');
            if (d && Array.isArray(d.seen) && Array.isArray(d.correct)) return d;
        } catch (e) { /* ignore */ }
        return { seen: [], correct: [] };
    }

    function record(id, correct) {
        if (!id || typeof id !== 'string') return;
        try {
            const d = read();
            if (!d.seen.includes(id)) d.seen.push(id);
            if (correct && !d.correct.includes(id)) d.correct.push(id);
            localStorage.setItem(KEY, JSON.stringify(d));
        } catch (e) { /* storage unavailable: the game plays fine without it */ }
    }

    // local list only, as Sets
    function local() { const d = read(); return { seen: new Set(d.seen), correct: new Set(d.correct) }; }

    // local list + the server's list (when there is one); never throws
    async function merged() {
        const out = local();
        try {
            const O = window.CircOnline;
            const s = O && O.myCollection ? await O.myCollection() : null;
            if (s) {
                (s.seen || []).forEach(x => out.seen.add(x));
                (s.correct || []).forEach(x => out.correct.add(x));
            }
        } catch (e) { /* offline or no session: local list only */ }
        out.correct.forEach(x => out.seen.add(x));
        return out;
    }

    window.CircCollection = { record, local, merged };

    // solo rounds: app.js calls track('round-correct' | 'round-wrong') once the card is placed
    if (typeof track === 'function') {
        const orig = track;
        window.track = function (name) {
            try {
                if ((name === 'round-correct' || name === 'round-wrong') && typeof currentCard !== 'undefined' && currentCard) {
                    record(currentCard.id, name === 'round-correct');
                }
            } catch (e) { /* never break gameplay */ }
            return orig.apply(this, arguments);
        };
    }
})();
