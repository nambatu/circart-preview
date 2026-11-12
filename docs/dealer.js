// CIRCArt — fairer solo dealer.
// Replaces the dealing of Julian's original app.js (which stays untouched):
// - deal only the cards a game can use (rounds + a few spares), so the
//   obscure→icon ramp happens over the rounds really played;
// - mix tiers like the deck itself, with a gentle ramp, so every card is
//   about equally likely;
// - only cards actually played count as "seen".
// Load after app.js. Simulation: node src/tools/sim_dealer.js docs/app.js docs/artline.json 20000 fresh docs/dealer.js
(function () {
    'use strict';
    if (typeof Dealer === 'undefined') return;
    const P = Dealer.prototype;

    function tierShare(self) {
        const n = { obscure: 0, recognisable: 0, icon: 0 };
        for (const c of self.allCards) if (n[c.tier_label] !== undefined) n[c.tier_label]++;
        const tot = n.obscure + n.recognisable + n.icon || 1;
        return { obscure: n.obscure / tot, recognisable: n.recognisable / tot, icon: n.icon / tot };
    }

    // deck proportions, tilted gently: more obscure early, more icons late (average stays 1)
    P.tierForRound = function (k, total) {
        const t = (k - 1) / Math.max(total - 1, 1);
        const s = this._share || (this._share = tierShare(this));
        return { obscure: s.obscure * (1.5 - t), recognisable: s.recognisable, icon: s.icon * 1.25 * (0.5 + t) };
    };

    // pick tiers in random order, each chance proportional to its weight
    function tierOrder(order, w) {
        const left = [...order], out = [];
        while (left.length) {
            let sum = 0; for (const t of left) sum += w[t];
            let r = Math.random() * sum, i = 0;
            for (; i < left.length - 1; i++) { r -= w[left[i]]; if (r < 0) break; }
            out.push(left.splice(i, 1)[0]);
        }
        return out;
    }

    P.buildPile = function (cards, size, excludeIds) {
        const byTier = { obscure: [], recognisable: [], icon: [] };
        for (const c of cards) if (!excludeIds.includes(c.id) && byTier[c.tier_label]) byTier[c.tier_label].push(c);
        for (const t of this.TIER_ORDER) this.shuffle(byTier[t]);
        const pile = [], recentArtists = [], recentDecades = [];
        for (let i = 0; i < size; i++) {
            const w = this.tierForRound(i + 1, size);
            let chosen = null;
            for (const t of tierOrder(this.TIER_ORDER, w)) {
                chosen = byTier[t].find(c => !recentArtists.includes(c.artist) && !recentDecades.includes(Math.floor(c.year / 10))) || null;
                if (chosen) { byTier[t] = byTier[t].filter(x => x !== chosen); break; }
            }
            if (!chosen) {
                const flat = [].concat(byTier.obscure, byTier.recognisable, byTier.icon);
                if (!flat.length) break;
                chosen = flat[Math.floor(Math.random() * flat.length)];
                byTier[chosen.tier_label] = byTier[chosen.tier_label].filter(x => x !== chosen);
            }
            pile.push(chosen);
            recentArtists.push(chosen.artist); if (recentArtists.length > 8) recentArtists.shift();
            recentDecades.push(Math.floor(chosen.year / 10)); if (recentDecades.length > 4) recentDecades.shift();
        }
        return pile;
    };

    P.deal = function (targetRounds) {
        const cards = this.loadFreshCards();
        const starts = this.startingCards(cards, 1);
        const size = Math.min(targetRounds + 4, cards.length - 1);          // rounds + spares for wrong answers
        const pile = this.buildPile(cards, size, starts.map(c => c.id));
        writeSeen([...starts, ...pile.slice(0, targetRounds)].map(c => c.id));  // spares are not "seen" until played
        return { starting_cards: starts, draw_pile: pile };
    };
})();
