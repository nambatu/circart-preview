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

    // ─── Gallery look: cards you haven't met are grey and blurred, placed-right ones get a gold mark ───
    const tr = (k, v) => (window.CircI18n ? window.CircI18n.t(k, v) : k);
    let deckIds = null, busy = false;

    async function deckOrder() {
        if (deckIds) return deckIds;
        const res = await fetch('artline.json', { cache: 'no-cache' });
        const data = await res.json();
        data.sort((a, b) => (a.year || 0) - (b.year || 0));      // same order and filter as app.js's gallery
        deckIds = data.filter(i => (i.image_local || i.image || '')).map(i => i.id);
        return deckIds;
    }

    async function decorate() {
        const grid = document.getElementById('gallery-grid');
        if (!grid || busy) return;
        const cards = [...grid.querySelectorAll(':scope > .gallery-card')];
        if (!cards.length || cards[0].dataset.cid) return;
        busy = true;
        try {
            const [ids, col] = await Promise.all([deckOrder(), merged()]);
            if (cards.length !== ids.length || cards[0].dataset.cid) return;
            let found = 0;
            cards.forEach((el, i) => {
                const id = ids[i];
                el.dataset.cid = id;
                if (col.seen.has(id)) {
                    found++;
                    if (col.correct.has(id)) {
                        el.classList.add('mastered');
                        const m = document.createElement('span');
                        m.className = 'gc-gold'; m.textContent = '★'; m.title = tr('gallery.mastered');
                        el.appendChild(m);
                    }
                } else {
                    el.classList.add('undiscovered');
                    el.setAttribute('aria-label', tr('gallery.undiscovered'));
                    const img = el.querySelector('img');
                    if (img) { img.classList.remove('zoomable-img'); img.alt = ''; }
                    const d = el.querySelector('.gallery-details');
                    if (d) d.innerHTML = '<h3>?</h3>';
                }
            });
            let bar = document.getElementById('gallery-count');
            if (!bar) {
                bar = document.createElement('p');
                bar.id = 'gallery-count'; bar.className = 'note gallery-count';
                grid.parentNode.insertBefore(bar, grid);
            }
            bar.textContent = tr('gallery.count', { n: found, total: ids.length });
        } catch (e) { /* gallery stays as app.js drew it */ }
        finally { busy = false; }
    }

    function watchGallery() {
        const grid = document.getElementById('gallery-grid');
        if (!grid) return;
        new MutationObserver(decorate).observe(grid, { childList: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchGallery); else watchGallery();

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
