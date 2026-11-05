// CIRCArt — translations for the original solo screens (app.js / index.html).
//
// app.js must stay untouched, so this file translates its screens from the
// outside: static texts are set by selector, and the texts app.js writes while
// you play are swapped with MutationObservers that only act when the text
// exactly matches a known template (in any language), so there are no loops.
// Re-runs whenever the language changes (CircI18n.apply sets <html lang>).
// To add a language: copy the `en` block below and translate the values.
// Load after solo.js.
(function () {
    'use strict';

    const DICT = {
        en: {
            // game header + bonus panel
            'round': 'Round',
            'score': 'Score:',
            'bonus.title': 'Extra Points (Optional)',
            'bonus.hint': 'Guess the artist, title, or exact year for bonus points! (Typos allowed)',
            'ph.artist': 'Artist',
            'ph.title': 'Title',
            'ph.year': 'Year (exact)',
            'instr.mouse': 'Click on a gap in the timeline below to place the artwork.',
            'instr.touch': 'Tap a + button in the timeline below to place the artwork.',
            'alt.current': 'Current Artwork',
            'alt.zoom': 'Zoomed Artwork',
            // active card while loading / unknown values
            'card.loading': 'Loading next masterpiece...',
            'card.title': 'Title',
            'card.artist': 'Artist',
            'card.year': 'Year',
            'card.unknown': 'Unknown',
            'card.unknownArtist': 'Unknown Artist',
            'card.source': 'Source: WikiArt',
            // feedback after placing
            'fb.correct': 'Correct!',
            'fb.placed': 'Correctly placed!',
            'fb.wrong': 'Incorrect! The artwork is from {year}.',
            'fb.artistRight': 'Artist guessed correctly! (+1 Point)',
            'fb.artistWrong': 'Wrong artist (Was: {name})',
            'fb.titleRight': 'Title guessed correctly! (+1 Point)',
            'fb.titleWrong': 'Wrong title (Was: {name})',
            'fb.yearRight': 'Exact year guessed! (+2 Points)',
            'fb.yearWrong': 'Wrong year (Was: {year})',
            'fb.details': 'Artwork Details',
            'fb.dyk': 'Did you know?',
            'fb.continue': 'Continue',
            // timeline
            'tl.title': 'Timeline',
            'tl.newer': '▲ Newer',
            'tl.older': '▼ Older',
            'tl.tap': 'Tap to place',
            'gap.only': 'Place the artwork on the timeline',
            'gap.before': 'Place before {y}',
            'gap.after': 'Place after {y}',
            'gap.between': 'Place between {a} and {b}',
            // end screen
            'end.title': 'Game Over!',
            'end.score': 'Your Highscore:',
            'end.placements': 'Correct placements:',
            'end.bonus': 'Bonus points:',
            'end.again': 'Play Again',
            // gallery
            'gal.back': 'Back to Menu',
            'gal.loading': 'Loading gallery...',
            'gal.failed': 'Failed to load gallery.',
            // loading overlay
            'load.museum': 'Loading artworks from the museum...',
            'load.0': 'Waking up the museum guards...',
            'load.1': 'Telling Picasso to draw a straight line...',
            'load.2': 'Dusting off the Renaissance...',
            'load.3': "Searching for Bob Ross's happy little trees...",
            'load.4': 'Convincing Mona Lisa to smile...',
            'load.5': "Gluing the Venus de Milo's arms back on... wait.",
            'load.6': 'Mixing fresh paint...',
            'load.7': "Looking for Van Gogh's ear...",
            'load.8': "Searching the Louvre's basement...",
            'load.9': 'Translating ancient Egyptian hieroglyphs...',
            'load.10': 'Teaching Michelangelo how to paint ceilings...',
            'load.11': "Waiting for Dalí's clocks to melt...",
            'load.12': 'Trying to figure out modern art...',
            'load.13': 'Asking Rembrandt to use a little more light...',
            'load.14': 'Telling Warhol his 15 minutes are up...',
            // report / feedback modal
            'rep.open': 'Report / Feedback',
            'rep.title': 'Report / Feedback',
            'rep.intro': 'Spotted a wrong fact? Want to suggest a new feature? Let us know!',
            'rep.about': 'About this card',
            'rep.topic': 'What is this about?',
            'rep.t.year': 'Wrong year',
            'rep.t.artist': 'Wrong artist or title',
            'rep.t.image': 'Image problem',
            'rep.t.desc': 'Wrong or unclear description',
            'rep.t.feature': 'Feature suggestion',
            'rep.t.other': 'Something else',
            'rep.ph': 'Type your feedback here...',
            'rep.fallback': 'If your email app did not open, copy this and send it to ',
            'rep.copy': 'Copy to clipboard',
            'rep.copied': 'Copied',
            'rep.ctrlc': 'Press Ctrl+C',
            'rep.cancel': 'Cancel',
            'rep.send': 'Send',
            'alert.empty': 'Please enter some feedback before sending.',
            'alert.load': 'Error loading artworks. Please try again.',
        },
        de: {
            'round': 'Karte',
            'score': 'Punkte:',
            'bonus.title': 'Extrapunkte (optional)',
            'bonus.hint': 'Errate Künstler, Titel oder genaues Jahr für Bonuspunkte! (Tippfehler sind okay)',
            'ph.artist': 'Künstler',
            'ph.title': 'Titel',
            'ph.year': 'Jahr (genau)',
            'instr.mouse': 'Klick unten im Zeitstrahl auf eine Lücke, um das Werk zu legen.',
            'instr.touch': 'Tippe unten im Zeitstrahl auf ein +, um das Werk zu legen.',
            'alt.current': 'Aktuelles Kunstwerk',
            'alt.zoom': 'Vergrößertes Kunstwerk',
            'card.loading': 'Nächstes Meisterwerk lädt…',
            'card.title': 'Titel',
            'card.artist': 'Künstler',
            'card.year': 'Jahr',
            'card.unknown': 'Unbekannt',
            'card.unknownArtist': 'Unbekannter Künstler',
            'card.source': 'Quelle: WikiArt',
            'fb.correct': 'Richtig!',
            'fb.placed': 'Richtig gelegt!',
            'fb.wrong': 'Leider falsch! Das Werk ist von {year}.',
            'fb.artistRight': 'Künstler erraten! (+1 Punkt)',
            'fb.artistWrong': 'Falscher Künstler (war: {name})',
            'fb.titleRight': 'Titel erraten! (+1 Punkt)',
            'fb.titleWrong': 'Falscher Titel (war: {name})',
            'fb.yearRight': 'Genaues Jahr erraten! (+2 Punkte)',
            'fb.yearWrong': 'Falsches Jahr (war: {year})',
            'fb.details': 'Über das Werk',
            'fb.dyk': 'Schon gewusst?',
            'fb.continue': 'Weiter',
            'tl.title': 'Zeitstrahl',
            'tl.newer': '▲ Neuer',
            'tl.older': '▼ Älter',
            'tl.tap': 'Hier legen',
            'gap.only': 'Lege das Werk auf den Zeitstrahl',
            'gap.before': 'Vor {y} legen',
            'gap.after': 'Nach {y} legen',
            'gap.between': 'Zwischen {a} und {b} legen',
            'end.title': 'Spiel vorbei!',
            'end.score': 'Deine Punktzahl:',
            'end.placements': 'Richtig gelegt:',
            'end.bonus': 'Bonuspunkte:',
            'end.again': 'Nochmal spielen',
            'gal.back': 'Zurück',
            'gal.loading': 'Galerie lädt…',
            'gal.failed': 'Die Galerie konnte nicht geladen werden.',
            'load.museum': 'Hole Kunstwerke aus dem Museum…',
            'load.0': 'Wecke die Museumswärter…',
            'load.1': 'Bitte Picasso um eine gerade Linie…',
            'load.2': 'Staube die Renaissance ab…',
            'load.3': 'Suche Bob Ross’ fröhliche kleine Bäume…',
            'load.4': 'Überrede Mona Lisa zum Lächeln…',
            'load.5': 'Klebe der Venus von Milo die Arme an… Moment.',
            'load.6': 'Mische frische Farbe…',
            'load.7': 'Suche Van Goghs Ohr…',
            'load.8': 'Durchsuche den Keller des Louvre…',
            'load.9': 'Übersetze ägyptische Hieroglyphen…',
            'load.10': 'Zeige Michelangelo, wie man Decken malt…',
            'load.11': 'Warte, bis Dalís Uhren schmelzen…',
            'load.12': 'Versuche, moderne Kunst zu verstehen…',
            'load.13': 'Bitte Rembrandt um etwas mehr Licht…',
            'load.14': 'Sage Warhol, dass seine 15 Minuten um sind…',
            'rep.open': 'Melden / Feedback',
            'rep.title': 'Melden / Feedback',
            'rep.intro': 'Fehler entdeckt? Idee für ein neues Feature? Sag uns Bescheid!',
            'rep.about': 'Zu dieser Karte',
            'rep.topic': 'Worum geht es?',
            'rep.t.year': 'Falsches Jahr',
            'rep.t.artist': 'Falscher Künstler oder Titel',
            'rep.t.image': 'Problem mit dem Bild',
            'rep.t.desc': 'Beschreibung falsch oder unklar',
            'rep.t.feature': 'Idee für ein Feature',
            'rep.t.other': 'Etwas anderes',
            'rep.ph': 'Schreib dein Feedback hier…',
            'rep.fallback': 'Falls sich deine Mail-App nicht geöffnet hat, kopier das hier und schick es an ',
            'rep.copy': 'In die Zwischenablage',
            'rep.copied': 'Kopiert',
            'rep.ctrlc': 'Drück Strg+C',
            'rep.cancel': 'Abbrechen',
            'rep.send': 'Senden',
            'alert.empty': 'Schreib bitte erst dein Feedback.',
            'alert.load': 'Die Kunstwerke konnten nicht geladen werden. Versuch es bitte nochmal.',
        },
    };

    const $ = id => document.getElementById(id);
    const lang = () => {
        const l = window.CircI18n && window.CircI18n.lang;
        return DICT[l] ? l : 'en';
    };
    const T = (key, vars) => {
        const s = DICT[lang()][key] != null ? DICT[lang()][key] : DICT.en[key];
        return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
    };

    // ─── dynamic texts: match a template in ANY language, render in the current one
    const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const compiled = {};   // key → [{ re, names }] per language
    function patterns(key) {
        if (compiled[key]) return compiled[key];
        return (compiled[key] = Object.keys(DICT).filter(l => DICT[l][key] != null).map(l => {
            const names = [];
            const src = DICT[l][key].split(/(\{\w+\})/).map(part => {
                const m = part.match(/^\{(\w+)\}$/);
                if (m) { names.push(m[1]); return '(.+?)'; }
                return reEsc(part);
            }).join('');
            return { re: new RegExp('^' + src + '$'), names };
        }));
    }
    // returns the translated text, or null when the text is not one of `keys`
    function translate(text, keys) {
        const s = (text || '').trim();
        for (const key of keys) {
            for (const p of patterns(key)) {
                const m = s.match(p.re);
                if (m) {
                    const vars = {};
                    p.names.forEach((n, i) => { vars[n] = m[i + 1]; });
                    return T(key, vars);
                }
            }
        }
        return null;
    }
    function retext(el, keys) {
        if (!el || el.children.length) return;          // leaves only
        const out = translate(el.textContent, keys);
        if (out != null && out !== el.textContent) el.textContent = out;
    }

    const LOAD_KEYS = ['load.museum'].concat(Array.from({ length: 15 }, (_, i) => 'load.' + i));
    const FB_KEYS = ['fb.correct', 'fb.placed', 'fb.wrong'];
    const BONUS_KEYS = ['fb.artistRight', 'fb.artistWrong', 'fb.titleRight', 'fb.titleWrong', 'fb.yearRight', 'fb.yearWrong'];
    const CARD_KEYS = ['card.loading', 'card.title', 'card.unknown'];
    const ARTIST_KEYS = ['card.artist', 'card.unknownArtist', 'card.unknown'];
    const GAP_KEYS = ['gap.only', 'gap.between', 'gap.before', 'gap.after'];

    // element (or subtree) → how to translate it
    const DYNAMIC = [
        ['feedback-message', () => retext($('feedback-message'), FB_KEYS)],
        ['bonus-feedback', () => $('bonus-feedback').querySelectorAll('li').forEach(li => retext(li, BONUS_KEYS))],
        ['active-title', () => retext($('active-title'), CARD_KEYS)],
        ['active-artist', () => retext($('active-artist'), ARTIST_KEYS)],
        ['active-year', () => retext($('active-year'), ['card.year'])],
        ['active-extra-info', () => ['active-movement', 'active-medium', 'active-location'].forEach(id => retext($(id), ['card.unknown']))],
        ['trivia-text', () => retext($('trivia-text'), ['card.source'])],
        ['loading-text', () => retext($('loading-text'), LOAD_KEYS)],
        ['score-breakdown', () => $('score-breakdown').querySelectorAll('span').forEach(s => retext(s, ['end.placements', 'end.bonus']))],
        ['gallery-grid', () => $('gallery-grid').querySelectorAll(':scope > p').forEach(p => retext(p, ['gal.loading', 'gal.failed']))],
        ['report-copy-btn', () => retext($('report-copy-btn'), ['rep.copy', 'rep.copied', 'rep.ctrlc'])],
        ['timeline', () => {
            $('timeline').querySelectorAll('.timeline-gap[aria-label]').forEach(g => {
                const out = translate(g.getAttribute('aria-label'), GAP_KEYS);
                if (out != null && out !== g.getAttribute('aria-label')) g.setAttribute('aria-label', out);
            });
            $('timeline').querySelectorAll('.card-details p:not(.year)').forEach(p => retext(p, ['card.unknown']));
        }],
    ];

    // ─── static texts, set by selector
    function setText(sel, key) { document.querySelectorAll(sel).forEach(el => { el.textContent = T(key); }); }
    function setAttr(sel, attr, key) { document.querySelectorAll(sel).forEach(el => el.setAttribute(attr, T(key))); }
    // the first text node only, so child spans (round number, score) survive
    function setLead(sel, key, after) {
        const el = document.querySelector(sel);
        const n = el && Array.from(el.childNodes).find(c => c.nodeType === 3);
        if (n) n.nodeValue = T(key) + (after || '');
    }

    function applyStatic() {
        setLead('#game-screen .stats > span:nth-child(1)', 'round', ' ');
        setLead('#game-screen .stats > span:nth-child(2)', 'score', ' ');

        // solo.js replaces the bonus heading/hint with its own strings
        const section = $('bonus-section');
        const ci = window.CircI18n;
        if (section && section.classList.contains('solo-mc') && ci) {
            const h = section.querySelector('h3'); if (h) h.textContent = ci.t('solo.bonusTitle');
            const hint = section.querySelector('.hint'); if (hint) hint.textContent = ci.t('solo.bonusHint');
        } else {
            setText('#bonus-section > h3', 'bonus.title');
            setText('#bonus-section > .hint', 'bonus.hint');
        }
        setAttr('#guess-artist', 'placeholder', 'ph.artist');
        setAttr('#guess-title', 'placeholder', 'ph.title');
        setAttr('#guess-year', 'placeholder', 'ph.year');
        setText('#bonus-section .instruction-mouse', 'instr.mouse');
        setText('#bonus-section .instruction-touch', 'instr.touch');
        setAttr('#active-image', 'alt', 'alt.current');
        setAttr('#zoomed-image', 'alt', 'alt.zoom');

        setText('#trivia-section > h3', 'fb.details');
        setText('#did-you-know-section > h3', 'fb.dyk');
        setText('#next-round-btn', 'fb.continue');

        setText('#timeline-section > h2', 'tl.title');
        const dirs = document.querySelectorAll('#timeline-section .direction-label');
        if (dirs[0]) dirs[0].textContent = T('tl.newer');
        if (dirs[1]) dirs[1].textContent = T('tl.older');

        setText('#end-screen > h1', 'end.title');
        setText('#end-screen > p', 'end.score');
        setText('#restart-btn', 'end.again');

        setText('#back-to-menu-btn', 'gal.back');

        setText('#open-report-btn', 'rep.open');
        setText('#report-modal .modal-content > h2', 'rep.title');
        setText('#report-modal .modal-content > p:not([id])', 'rep.intro');
        setText('#report-card-context > strong', 'rep.about');
        setText('label[for="report-topic"]', 'rep.topic');
        const OPT = { 'Wrong year': 'rep.t.year', 'Wrong artist or title': 'rep.t.artist', 'Image problem': 'rep.t.image',
            'Wrong or unclear description': 'rep.t.desc', 'Feature suggestion': 'rep.t.feature', 'Something else': 'rep.t.other' };
        document.querySelectorAll('#report-topic option').forEach(o => { if (OPT[o.value]) o.textContent = T(OPT[o.value]); });
        setAttr('#report-text', 'placeholder', 'rep.ph');
        setLead('#report-fallback > p', 'rep.fallback');
        setText('#cancel-report-btn', 'rep.cancel');
        setText('#send-report-btn', 'rep.send');

        // the first-run "Tap to place" label is CSS ::after content (phones only)
        let st = $('solo-i18n-style');
        if (!st) { st = document.createElement('style'); st.id = 'solo-i18n-style'; document.head.appendChild(st); }
        st.textContent = '@media (max-width: 780px) { .timeline.learning .timeline-gap::after { content: ' +
            JSON.stringify(T('tl.tap')) + '; } }';

        DYNAMIC.forEach(([, fn]) => { try { fn(); } catch (e) { /* element missing */ } });
    }

    function init() {
        DYNAMIC.forEach(([id, fn]) => {
            const el = $(id);
            if (el) new MutationObserver(() => { try { fn(); } catch (e) { /* ignore */ } })
                .observe(el, { childList: true, characterData: true, subtree: true });
        });

        // app.js alerts (feedback form / load error). "No more artworks…" stays as is.
        const origAlert = window.alert;
        window.alert = function (msg) {
            const out = translate(String(msg), ['alert.empty', 'alert.load']);
            return origAlert.call(window, out != null ? out : msg);
        };

        // language changes: CircI18n.apply() always sets <html lang>; also wrap
        // setLanguage for callers that change it without apply
        let last = null;
        const refresh = () => { last = lang(); applyStatic(); };
        new MutationObserver(() => refresh())
            .observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        const ci = window.CircI18n;
        if (ci && typeof ci.setLanguage === 'function') {
            const orig = ci.setLanguage;
            ci.setLanguage = function () { const r = orig.apply(this, arguments); if (lang() !== last) refresh(); return r; };
        }
        refresh();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
