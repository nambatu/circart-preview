// CIRCArt — simulate the solo dealer:
//   node src/tools/sim_dealer.js src/app/dealer.js docs/artline.json 20000 fresh
// Prints how often each card is SHOWN (first 11 of a deal) per game, by tier and century.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dealerPath = process.argv[2];
const deckPath = process.argv[3];
if (!dealerPath || !deckPath) {
    console.error('Usage: node src/tools/sim_dealer.js <dealer.js> <artline.json> [games=20000] [fresh|session]');
    process.exit(1);
}

// Minimal browser globals expected by standalone dealer.js
let store = {};
global.localStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
};
global.window = global;
global.CircStyles = { GROUPS: {} };

/**
 * Load the Dealer constructor from either standalone dealer.js or legacy app.js.
 */
function loadDealer(scriptPath, patchPath) {
    const resolved = path.resolve(scriptPath);
    const src = fs.readFileSync(resolved, 'utf8');

    // Legacy fallback: docs/app.js + optional docs/dealer.js patch
    if (src.includes('const SEEN_KEY') && src.includes('let hitsterDeck')) {
        const start = src.indexOf('const SEEN_KEY');
        const end = src.indexOf('let hitsterDeck');
        vm.runInThisContext(
            src.slice(start, end).replace('class Dealer', 'global.Dealer = class Dealer'),
            { filename: resolved }
        );
        if (patchPath) {
            const patchResolved = path.resolve(patchPath);
            const fix = fs.readFileSync(patchResolved, 'utf8')
                .replace("typeof Dealer === 'undefined'", 'false')
                .replace('(function () {', '(function () { const Dealer = global.Dealer;');
            vm.runInThisContext(fix, { filename: patchResolved });
        }
    } else {
        // Standalone dealer.js (IIFE exposing window.Dealer / window.CircDealer or top-level class Dealer)
        vm.runInThisContext(
            src + '\n;if (typeof Dealer !== "undefined" && !global.Dealer) global.Dealer = Dealer;',
            { filename: resolved }
        );
    }

    const ctor = global.Dealer
        || (global.CircDealer && (typeof global.CircDealer === 'function' ? global.CircDealer : global.CircDealer.Dealer));
    if (typeof ctor !== 'function') {
        throw new Error(`Could not locate Dealer constructor in ${scriptPath}`);
    }
    return ctor;
}

const Dealer = loadDealer(dealerPath, process.argv[6]);
const deck = JSON.parse(fs.readFileSync(path.resolve(deckPath), 'utf8'));
const N = Number(process.argv[4]) || 20000;
const mode = process.argv[5] || 'fresh';
const SHOWN = 11;

const shown = {};
const dealt = {};
deck.forEach(c => { shown[c.id] = 0; dealt[c.id] = 0; });

for (let i = 0; i < N; i++) {
    // 'session': 5 games in a row keeping seen memory, then a break > 6 h
    if (mode === 'fresh' || i % 5 === 0) store = {};
    // deal(11) marks all 11+1 cards seen by default (markAll defaults to true)
    const d = new Dealer(deck).deal(11);
    const all = [...d.starting_cards, ...d.draw_pile];
    all.forEach(c => { dealt[c.id] = (dealt[c.id] || 0) + 1; });
    all.slice(0, SHOWN).forEach(c => { shown[c.id] = (shown[c.id] || 0) + 1; });
}

const by = deck
    .map(c => ({ t: c.title, a: c.artist, y: c.year, tier: c.tier_label, p: shown[c.id] / N * 100 }))
    .sort((x, y) => x.p - y.p);
const avg = by.reduce((s, x) => s + x.p, 0) / by.length;
console.log(mode, 'avg % of games a card is SHOWN:', avg.toFixed(1));

const grp = k => {
    const g = {};
    by.forEach(x => { const key = k(x); (g[key] = g[key] || []).push(x.p); });
    return Object.entries(g)
        .map(([k, v]) => k + ': ' + (v.reduce((a, b) => a + b) / v.length).toFixed(1) + '%')
        .join(' | ');
};

console.log('by tier:', grp(x => x.tier));
console.log('by century:', grp(x => x.y < 1500 ? '<1500' : x.y < 1600 ? '1500s' : x.y < 1700 ? '1600s' : x.y < 1800 ? '1700s' : x.y < 1900 ? '1800s' : '1900+'));

const pick = ['Mona Lisa', 'The Last Supper', 'David', 'Self-Portrait at Twenty-Eight', 'Melencolia I', 'An Old Man and His Grandson'];
by.filter(x => pick.includes(x.t)).forEach(x => console.log(' ', x.p.toFixed(1) + '%', x.tier, x.y, x.a, '-', x.t));
console.log('lowest 8:');
by.slice(0, 8).forEach(x => console.log(' ', x.p.toFixed(1) + '%', x.tier, x.y, x.a, '-', x.t));
console.log('highest 8:');
by.slice(-8).forEach(x => console.log(' ', x.p.toFixed(1) + '%', x.tier, x.y, x.a, '-', x.t));
