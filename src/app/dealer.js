// CIRCArt — standalone solo & pack dealer, seen-card memory, and bonus options.
// No dependency on app.js. Safe in both browser and Node (sim_dealer.js).
(function () {
    'use strict';

    const SEEN_KEY = 'seenCards';
    const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

    function readSeen(extraSet) {
        let raw = null;
        try {
            raw = localStorage.getItem(SEEN_KEY);
        } catch (e) {
            raw = null;
        }

        const fresh = {};
        if (raw) {
            try {
                const data = JSON.parse(raw);
                if (data && !Array.isArray(data) && typeof data === 'object') {
                    const cutoff = Date.now() - SEEN_TTL_MS;
                    for (const id in data) {
                        if (typeof data[id] === 'number' && data[id] > cutoff) {
                            fresh[id] = data[id];
                        }
                    }
                }
            } catch (e) { /* ignore malformed storage */ }
        }

        if (extraSet) {
            const now = Date.now();
            for (const id of extraSet) {
                if (id && !(id in fresh)) fresh[id] = now;
            }
        }
        return fresh;
    }

    function markSeen(ids) {
        if (!ids) return;
        const seen = readSeen();
        const now = Date.now();
        let any = false;
        for (const id of ids) {
            if (id) {
                seen[id] = now;
                any = true;
            }
        }
        if (!any) return;
        try {
            localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
        } catch (e) { /* storage unavailable */ }
    }

    function shuffleArray(array) {
        let i = array.length;
        while (i !== 0) {
            const j = Math.floor(Math.random() * i);
            i--;
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    function tierShare(allCards) {
        const n = { obscure: 0, recognisable: 0, icon: 0 };
        for (const c of allCards) {
            if (n[c.tier_label] !== undefined) n[c.tier_label]++;
        }
        const tot = n.obscure + n.recognisable + n.icon || 1;
        return { obscure: n.obscure / tot, recognisable: n.recognisable / tot, icon: n.icon / tot };
    }

    function tierOrder(order, w) {
        const left = [...order], out = [];
        while (left.length) {
            let sum = 0;
            for (const t of left) sum += w[t];
            let r = Math.random() * sum, i = 0;
            for (; i < left.length - 1; i++) {
                r -= w[left[i]];
                if (r < 0) break;
            }
            out.push(left.splice(i, 1)[0]);
        }
        return out;
    }

    class Dealer {
        constructor(cards, extraSeen) {
            this.allCards = (cards || []).filter(c => c && (c.image_local || c.image || c.image_source));
            this.TIER_ORDER = ['obscure', 'recognisable', 'icon'];
            this.extraSeen = extraSeen || null;
        }

        loadFreshCards() {
            const seen = readSeen(this.extraSeen);
            const fresh = this.allCards.filter(c => !seen[c.id]);
            if (fresh.length > this.allCards.length / 3) return fresh;
            return this.allCards;
        }

        shuffle(array) {
            return shuffleArray(array);
        }

        startingCards(cards, n) {
            const bands = [[1300, 1600], [1600, 1800], [1800, 1900], [1900, 1960], [1960, 2030]];
            const pool = {};
            for (const [lo, hi] of bands) pool[`${lo}-${hi}`] = [];
            for (const c of cards) {
                for (const [lo, hi] of bands) {
                    if (c.year >= lo && c.year < hi && (c.tier == null || c.tier <= 2)) {
                        pool[`${lo}-${hi}`].push(c);
                    }
                }
            }

            const picked = [];
            const order = this.shuffle([...bands]);
            for (let i = 0; i < n; i++) {
                const band = order[i % order.length];
                const key = `${band[0]}-${band[1]}`;
                let candidates = pool[key].filter(c => !picked.includes(c));
                if (!candidates.length) candidates = cards.filter(c => !picked.includes(c) && (c.tier == null || c.tier <= 2));
                if (!candidates.length) candidates = cards.filter(c => !picked.includes(c));
                if (!candidates.length) break;
                picked.push(candidates[Math.floor(Math.random() * candidates.length)]);
            }
            return picked;
        }

        // deck proportions, tilted gently: more obscure early, more icons late (average stays 1)
        tierForRound(k, total) {
            const t = (k - 1) / Math.max(total - 1, 1);
            const s = this._share || (this._share = tierShare(this.allCards));
            return { obscure: s.obscure * (1.5 - t), recognisable: s.recognisable, icon: s.icon * 1.25 * (0.5 + t) };
        }

        buildPile(cards, size, excludeIds) {
            const byTier = { obscure: [], recognisable: [], icon: [] };
            const tierKey = c => (byTier[c.tier_label] ? c.tier_label : 'recognisable');
            for (const c of cards) {
                if (!excludeIds.includes(c.id)) byTier[tierKey(c)].push(c);
            }
            for (const t of this.TIER_ORDER) this.shuffle(byTier[t]);

            const pile = [], recentArtists = [], recentDecades = [];
            for (let i = 0; i < size; i++) {
                const w = this.tierForRound(i + 1, size);
                let chosen = null;
                for (const t of tierOrder(this.TIER_ORDER, w)) {
                    chosen = byTier[t].find(c => !recentArtists.includes(c.artist) && !recentDecades.includes(Math.floor(c.year / 10))) || null;
                    if (chosen) {
                        byTier[t] = byTier[t].filter(x => x !== chosen);
                        break;
                    }
                }
                if (!chosen) {
                    const flat = [].concat(byTier.obscure, byTier.recognisable, byTier.icon);
                    if (!flat.length) break;
                    chosen = flat[Math.floor(Math.random() * flat.length)];
                    const k = tierKey(chosen);
                    byTier[k] = byTier[k].filter(x => x !== chosen);
                }
                pile.push(chosen);
                recentArtists.push(chosen.artist);
                if (recentArtists.length > 8) recentArtists.shift();
                recentDecades.push(Math.floor(chosen.year / 10));
                if (recentDecades.length > 4) recentDecades.shift();
            }
            return pile;
        }

        deal(targetRounds, opts = {}) {
            const cards = this.loadFreshCards();
            const starts = this.startingCards(cards, 1);
            const size = Math.min(targetRounds, Math.max(0, cards.length - starts.length));
            const pile = this.buildPile(cards, size, starts.map(c => c.id));
            if (opts.markAll !== false) {
                markSeen([...starts, ...pile.slice(0, targetRounds)].map(c => c.id));
            }
            return { starting_cards: starts, draw_pile: pile };
        }
    }

    function artistOptions(card, pool) {
        const real = (card && (card.artist || card.artistDisplayName) || '').trim();
        if (!real || /unknown/i.test(real)) return null;
        const realLower = real.toLowerCase();
        const cardYear = Number(card.year != null ? card.year : card.objectEndDate);
        const byArtist = new Map();
        for (const c of pool || []) {
            const a = (c && (c.artist || c.artistDisplayName) || '').trim();
            if (!a || /unknown/i.test(a)) continue;
            const lower = a.toLowerCase();
            if (lower === realLower) continue;
            const y = Number(c.year != null ? c.year : c.objectEndDate);
            const dist = Number.isFinite(y) && Number.isFinite(cardYear) ? Math.abs(y - cardYear) : 9999;
            const prev = byArtist.get(lower);
            if (!prev || dist < prev.dist) byArtist.set(lower, { name: a, dist });
        }
        const others = shuffleArray([...byArtist.values()]).sort((x, y) => x.dist - y.dist);
        if (others.length < 3) return null;
        const near = shuffleArray(others.slice(0, 8)).slice(0, 3).map(x => x.name);
        return shuffleArray([real, ...near]);
    }

    function movementOptions(card) {
        const GROUPS = (typeof window !== 'undefined' && window.CircStyles && window.CircStyles.GROUPS) || null;
        if (!GROUPS || !card || !card.movement) return null;
        const g = GROUPS[card.movement];
        if (!g) return null;
        const all = [...new Map(Object.values(GROUPS).map(([n, o]) => [n, o])).entries()].filter(([n]) => n !== g[0]);
        let near = shuffleArray(all.filter(([, o]) => Math.abs(o - g[1]) <= 5)).slice(0, 3).map(x => x[0]);
        if (near.length < 3) near = shuffleArray(all).slice(0, 3).map(x => x[0]);
        return near.length === 3 ? shuffleArray([g[0], ...near]) : null;
    }

    const api = { Dealer, readSeen, markSeen, artistOptions, movementOptions };
    if (typeof window !== 'undefined') {
        window.CircDealer = api;
        window.Dealer = Dealer;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
