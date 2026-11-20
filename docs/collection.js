// CIRCArt — lasting list of the cards this device has met and placed right,
// plus direct rendering of the Gallery works grid.
// Only card ids are stored locally, nothing else.
(function () {
    'use strict';

    const KEY = 'circart-collection';
    const tr = (k, v) => (window.CircI18n ? window.CircI18n.t(k, v) : k);
    const esc = s => (window.CircI18n && window.CircI18n.esc)
        ? window.CircI18n.esc(s)
        : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

    function local() {
        const d = read();
        return { seen: new Set(d.seen), correct: new Set(d.correct) };
    }

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

    let renderSeq = 0;

    async function renderGallery(gridEl) {
        if (!gridEl) return;
        const seq = ++renderSeq;
        gridEl.innerHTML = `<p class="muted" style="padding:1rem;text-align:center">${esc(tr('gallery.loading'))}</p>`;
        try {
            const [deck, col] = await Promise.all([window.CircShell.loadDeck(), merged()]);
            if (seq !== renderSeq) return;
            const list = (deck || [])
                .filter(c => c && (c.image_local || c.image))
                .slice()
                .sort((a, b) => (a.year || 0) - (b.year || 0));
            if (!list.length) {
                gridEl.innerHTML = `<p class="muted" style="padding:1rem;text-align:center">${esc(tr('gallery.failed'))}</p>`;
                return;
            }

            let found = 0;
            const cardsHtml = list.map(c => {
                const imgSrc = String(c.image_local || c.image || '').replace(/\\/g, '/');
                const seen = col.seen.has(c.id);
                if (seen) {
                    found++;
                    const mastered = col.correct.has(c.id);
                    return `<div class="gallery-card${mastered ? ' mastered' : ''}" data-cid="${esc(c.id)}">`
                        + `<img src="${esc(imgSrc)}" class="zoomable-img" alt="${esc(c.title)}" loading="lazy">`
                        + `<div class="gallery-details"><h3>${esc(c.title)}</h3><p>${esc(c.artist)}</p><p class="year">${esc(c.year)}</p></div>`
                        + `${mastered ? `<span class="gc-gold" title="${esc(tr('gallery.mastered'))}">★</span>` : ''}`
                        + `</div>`;
                }
                return `<div class="gallery-card undiscovered" data-cid="${esc(c.id)}" aria-label="${esc(tr('gallery.undiscovered'))}">`
                    + `<img src="${esc(imgSrc)}" alt="" loading="lazy">`
                    + `<div class="gallery-details"><h3>?</h3></div>`
                    + `</div>`;
            }).join('');

            let bar = document.getElementById('gallery-count');
            if (!bar && gridEl.parentNode) {
                bar = document.createElement('p');
                bar.id = 'gallery-count';
                bar.className = 'note gallery-count';
                gridEl.parentNode.insertBefore(bar, gridEl);
            }
            if (bar) {
                bar.textContent = tr('gallery.count', { n: found, total: list.length });
                bar.classList.toggle('hidden', gridEl.classList.contains('hidden'));
            }
            gridEl.innerHTML = cardsHtml;
        } catch (e) {
            if (seq !== renderSeq) return;
            gridEl.innerHTML = `<p class="muted" style="padding:1rem;text-align:center">${esc(tr('gallery.failed'))}</p>`;
        }
    }

    window.CircCollection = { record, local, merged, renderGallery };
})();
