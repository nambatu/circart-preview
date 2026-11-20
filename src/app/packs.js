// CIRCArt — card packs in the solo game.
//
// Packs live in docs/packs/<id>.json (built from src/packs/*.json).
// Packs are kept strictly apart from normal games: their cards only ever appear
// when you choose "Play this pack" in the Gallery, which opens one solo game
// with only that pack's cards via CircGame.openSolo().
(function () {
    'use strict';

    const files = {};

    async function packCards(id) {
        if (!files[id]) {
            files[id] = fetch('packs/' + encodeURIComponent(id) + '.json')
                .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
                .then(j => j.cards || [])
                .catch(() => { delete files[id]; return []; });
        }
        const isDe = window.CircI18n && window.CircI18n.lang === 'de';
        return (await files[id]).map(c => (isDe && c.trivia_de ? Object.assign({}, c, { trivia: c.trivia_de }) : c));
    }

    window.CircPacks = {
        setUnlocked() { /* packs are never mixed into normal games */ },
        cards: packCards,
        async play(id, title) {
            const own = await packCards(id);
            if (own.length < 2) {
                if (window.CircShell && window.CircShell.toast && window.CircI18n) {
                    window.CircShell.toast(window.CircI18n.t('common.error'));
                }
                return;
            }
            window.CircGame.openSolo({
                rounds: window.CircShell.soloRounds(),
                cards: own,
                packId: id,
                packTitle: title || null,
            });
        },
    };
})();
