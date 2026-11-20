// CIRCArt — "How to spot a style" (task 39).
// The style groups the style question uses (same as migration 007 + 027), a
// short plain description of each in EN and DE, and the guide shown in
// Gallery → Styles and from the "?" next to the style question.
// dealer.js reads GROUPS from here, so there is one list for the whole app.
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const esc = s => (window.CircI18n && window.CircI18n.esc) ? window.CircI18n.esc(s)
        : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const t = (k, v) => (window.CircI18n ? window.CircI18n.t(k, v) : k);
    const de = () => window.CircI18n && window.CircI18n.lang === 'de';

    // card label → [group the player sees, rough order in time]
    const GROUPS = {"Proto-Renaissance": ["Gothic", 1], "Sienese School": ["Gothic", 1], "International Gothic": ["Gothic", 1], "Late Gothic": ["Gothic", 1], "Early Renaissance": ["Renaissance", 2], "High Renaissance": ["Renaissance", 2], "Venetian Renaissance": ["Renaissance", 2], "Northern Renaissance": ["Northern Renaissance", 3], "Mannerism": ["Mannerism", 4], "Baroque": ["Baroque", 5], "Baroque Classicism": ["Baroque", 5], "Dutch Golden Age": ["Dutch Golden Age", 6], "Rococo": ["Rococo", 7], "Vedutismo": ["Rococo", 7], "Neoclassicism": ["Neoclassicism", 8], "Enlightenment": ["Neoclassicism", 8], "Romanticism": ["Romanticism", 9], "Biedermeier": ["Romanticism", 9], "Ukiyo-e": ["Ukiyo-e", 10], "Pre-Raphaelite": ["Pre-Raphaelites", 11], "Realism": ["Realism", 12], "Academic art": ["Realism", 12], "Impressionism": ["Impressionism", 13], "Post-Impressionism": ["Post-Impressionism", 14], "Neo-Impressionism": ["Post-Impressionism", 14], "Naive art": ["Post-Impressionism", 14], "Symbolism": ["Symbolism", 15], "Art Nouveau": ["Art Nouveau", 16], "Fauvism": ["Fauvism", 17], "Expressionism": ["Expressionism", 18], "Blue Period": ["Expressionism", 18], "New Objectivity": ["Expressionism", 18], "Proto-Cubism": ["Cubism", 19], "Analytic Cubism": ["Cubism", 19], "Cubism": ["Cubism", 19], "Futurism": ["Futurism", 20], "Abstract art": ["Abstract art", 21], "Suprematism": ["Abstract art", 21], "De Stijl": ["Abstract art", 21], "Bauhaus": ["Abstract art", 21], "Modernism": ["Abstract art", 21], "Dada": ["Dada", 22], "Art Deco": ["Art Deco", 23], "Surrealism": ["Surrealism", 24], "Magic Realism": ["Surrealism", 24], "American Realism": ["American Realism", 25], "Regionalism": ["American Realism", 25], "American Modernism": ["American Realism", 25], "American Illustration": ["American Realism", 25], "Abstract Expressionism": ["Abstract Expressionism", 26], "Op art": ["Op art", 27], "Pop art": ["Pop art", 28], "Neo-Dada": ["Pop art", 28], "Nouveau Realisme": ["Pop art", 28], "Neo-Pop": ["Pop art", 28], "Neo-expressionism": ["Neo-Expressionism", 29], "Photorealism": ["Photorealism", 30], "Street art": ["Street art", 31], "Conceptual art": ["Conceptual art", 32], "Installation art": ["Conceptual art", 32], "Young British Artists": ["Conceptual art", 32]};

    // what to look for — plain sentences, no long lists (writing rules in AGENTS.md)
    const LOOK = {
        'Gothic': ['Gold backgrounds and slim, graceful saints. Space looks flat, and the most important figure is often painted the biggest.',
                   'Goldgründe und schlanke, elegante Heilige. Der Raum wirkt flach, und die wichtigste Figur ist oft am größten gemalt.'],
        'Renaissance': ['Calm, balanced pictures with real depth. Lines of floors and buildings run towards one point, and bodies look solid like statues.',
                        'Ruhige, ausgewogene Bilder mit echter Tiefe. Linien von Böden und Gebäuden laufen auf einen Punkt zu, und Körper wirken fest wie Statuen.'],
        'Northern Renaissance': ['Tiny details you could look at with a magnifying glass. Fur and jewels are painted so clearly in oil that they almost shine.',
                                 'Winzige Details, die man mit der Lupe ansehen könnte. Fell und Schmuck sind in Öl so klar gemalt, dass sie fast glänzen.'],
        'Mannerism': ['Bodies that are a little too long and poses that twist. The colours are often cool and unusual, and the scene can feel crowded or uneasy.',
                      'Körper, die etwas zu lang sind, und verdrehte Posen. Die Farben sind oft kühl und ungewöhnlich, und die Szene wirkt gedrängt oder unruhig.'],
        'Baroque': ['Drama and movement, with strong light against deep shadow. Figures twist and reach as if the scene was frozen at its most exciting moment.',
                    'Drama und Bewegung, mit starkem Licht gegen tiefe Schatten. Figuren drehen sich und greifen aus, als wäre der spannendste Moment eingefroren.'],
        'Dutch Golden Age': ['Everyday Dutch life painted with great care. Think of quiet rooms in soft window light, or wide flat landscapes under a big sky.',
                             'Niederländischer Alltag, mit großer Sorgfalt gemalt. Denk an stille Räume in weichem Fensterlicht oder weite, flache Landschaften unter großem Himmel.'],
        'Rococo': ['Light, playful and pretty. Pastel colours and swirling decoration go with elegant people at leisure in gardens.',
                   'Leicht, verspielt und hübsch. Pastellfarben und geschwungene Verzierungen passen zu eleganten Leuten, die sich in Gärten vergnügen.'],
        'Neoclassicism': ['Back to ancient Greece and Rome. Clean outlines and calm, statue-like heroes stand in front of columns, and the colours are sober.',
                          'Zurück zum antiken Griechenland und Rom. Klare Umrisse und ruhige, statuenhafte Helden stehen vor Säulen, und die Farben sind nüchtern.'],
        'Romanticism': ['Big feelings and wild nature. Tiny people stand before storms or mountains, facing something much larger than themselves.',
                        'Große Gefühle und wilde Natur. Winzige Menschen stehen vor Stürmen oder Bergen und damit vor etwas viel Größerem.'],
        'Ukiyo-e': ['Japanese woodblock prints. Look for flat areas of colour with strong outlines, and often a bold, unexpected view of the scene.',
                    'Japanische Farbholzschnitte. Achte auf flache Farbflächen mit kräftigen Umrissen und oft einen kühnen, überraschenden Blick auf die Szene.'],
        'Pre-Raphaelites': ['Very bright, jewel-like colours and every leaf painted sharply. The subjects are often legends or poems with dreamy, long-haired women.',
                            'Sehr leuchtende, edelsteinartige Farben, jedes Blatt scharf gemalt. Die Themen sind oft Sagen oder Gedichte mit verträumten, langhaarigen Frauen.'],
        'Realism': ['Ordinary people as they really are, often at work. Nothing is made prettier, and the colours tend to be earthy and dark.',
                    'Gewöhnliche Menschen, wie sie wirklich sind, oft bei der Arbeit. Nichts wird beschönigt, und die Farben sind eher erdig und dunkel.'],
        'Impressionism': ['Quick, visible brushstrokes that catch a passing moment of light. Up close it looks blurry, but from a distance it shimmers.',
                          'Schnelle, sichtbare Pinselstriche, die einen flüchtigen Lichtmoment einfangen. Von nah wirkt es verschwommen, von weitem flimmert es.'],
        'Post-Impressionism': ['Still bright colours, but with more structure and personality. Some painters use thick swirling strokes, others build the picture from tiny dots.',
                               'Weiterhin helle Farben, aber mit mehr Aufbau und Persönlichkeit. Manche malen mit dicken, wirbelnden Strichen, andere setzen das Bild aus winzigen Punkten zusammen.'],
        'Symbolism': ['Dreams, myths and mysteries instead of everyday life. The mood is strange and quiet, and the picture hints at a hidden meaning.',
                      'Träume, Mythen und Geheimnisse statt Alltag. Die Stimmung ist seltsam und still, und das Bild deutet eine verborgene Bedeutung an.'],
        'Art Nouveau': ['Flowing lines that curl like plants. Decorative patterns and gold often surround elegant figures, almost like a poster or a mosaic.',
                        'Fließende Linien, die sich wie Pflanzen ranken. Dekorative Muster und Gold umgeben oft elegante Figuren, fast wie ein Plakat oder ein Mosaik.'],
        'Fauvism': ['Wild, pure colours straight from the tube. A face can be green and a tree red, because colour shows feeling, not reality.',
                    'Wilde, reine Farben direkt aus der Tube. Ein Gesicht darf grün und ein Baum rot sein, denn Farbe zeigt Gefühl, nicht Wirklichkeit.'],
        'Expressionism': ['Feelings pushed to the extreme. Shapes are distorted and colours clash, so the picture looks raw, tense or anxious.',
                          'Gefühle bis zum Äußersten. Formen sind verzerrt und Farben prallen aufeinander, sodass das Bild roh, gespannt oder ängstlich wirkt.'],
        'Cubism': ['Things broken into angular pieces and seen from several sides at once. Colours are often muted browns and greys.',
                   'Dinge, in eckige Stücke zerlegt und von mehreren Seiten zugleich gezeigt. Die Farben sind oft gedämpfte Braun- und Grautöne.'],
        'Futurism': ['Speed and machines. Repeated lines make trains and people look as if they are rushing past.',
                     'Geschwindigkeit und Maschinen. Wiederholte Linien lassen Züge und Menschen vorbeirasen.'],
        'Abstract art': ['No objects at all, only colour, line and shape. Sometimes it is a strict grid, sometimes free forms floating on the canvas.',
                         'Gar keine Gegenstände, nur Farbe, Linie und Form. Manchmal ein strenges Raster, manchmal freie Formen, die auf der Leinwand schweben.'],
        'Dada': ['Art that mocks art. Everyday objects and pure nonsense are used to provoke the viewer.',
                 'Kunst, die sich über Kunst lustig macht. Alltagsgegenstände und purer Unsinn sollen das Publikum provozieren.'],
        'Art Deco': ['Sleek, streamlined glamour from the 1920s and 30s. Smooth shapes meet bold geometry.',
                     'Schicker, stromlinienförmiger Glamour der 1920er und 30er. Glatte Formen treffen auf kräftige Geometrie.'],
        'Surrealism': ['Dream pictures painted very precisely. Things that can\'t exist together, such as melting clocks, look completely real.',
                       'Traumbilder, sehr genau gemalt. Dinge, die nicht zusammen existieren können, etwa schmelzende Uhren, wirken völlig echt.'],
        'American Realism': ['Everyday America, often lonely or quiet. Small towns and empty streets sit in clear, plain light.',
                             'Amerikanischer Alltag, oft einsam oder still. Kleinstädte und leere Straßen liegen in klarem, schlichtem Licht.'],
        'Abstract Expressionism': ['Huge canvases full of energy. Paint is dripped across the canvas or laid down in big fields of colour.',
                                   'Riesige Leinwände voller Energie. Die Farbe wird auf die Leinwand getropft oder in großen Farbfeldern aufgetragen.'],
        'Op art': ['Patterns that seem to move or flicker. Your eyes do half the work.',
                   'Muster, die sich scheinbar bewegen oder flimmern. Die Augen machen die halbe Arbeit.'],
        'Pop art': ['Pictures borrowed from comics and adverts. Bright flat colours and repeated images look as if a machine printed them.',
                    'Bilder aus Comics und Werbung. Leuchtende flache Farben und wiederholte Motive wirken wie von einer Maschine gedruckt.'],
        'Neo-Expressionism': ['Back to rough, wild painting in the 1980s. Big, messy figures and scribbled signs with lots of raw energy.',
                              'Zurück zur rauen, wilden Malerei in den 1980ern. Große, krakelige Figuren und gekritzelte Zeichen mit viel roher Energie.'],
        'Photorealism': ['Paintings that look exactly like photographs. Even the reflections in shiny cars are painted by hand.',
                         'Gemälde, die genau wie Fotos aussehen. Sogar die Spiegelungen auf glänzenden Autos sind von Hand gemalt.'],
        'Street art': ['Art made on walls in public. Spray paint and stencils deliver short, clever messages.',
                       'Kunst auf Wänden im öffentlichen Raum. Sprühfarbe und Schablonen bringen kurze, clevere Botschaften.'],
        'Conceptual art': ['The idea matters more than the craft. It can be an object or a few words that make you think.',
                           'Die Idee zählt mehr als das Handwerk. Es kann ein Gegenstand sein oder ein paar Worte, die zum Nachdenken bringen.'],
    };

    const groupOf = movement => (GROUPS[movement] || [null])[0];
    const look = g => (LOOK[g] ? LOOK[g][de() ? 1 : 0] : '');
    const ordered = () => [...new Map(Object.values(GROUPS).map(([g, o]) => [g, o])).entries()].sort((a, b) => a[1] - b[1]).map(x => x[0]);

    // up to 3 example cards per style, famous ones first
    function examples(deck, g) {
        const rank = { icon: 0, recognisable: 1, obscure: 2 };
        return (deck || []).filter(c => groupOf(c.movement) === g && (c.image_local || c.image))
            .sort((a, b) => (rank[a.tier_label] ?? 3) - (rank[b.tier_label] ?? 3))
            .slice(0, 3);
    }
    const img = c => String(c.image_local || c.image || '').replace(/\\/g, '/');

    // Gallery → Styles
    let deckP = null;
    async function renderGuide(box) {
        if (!box) return;
        const deck = (window.CircShell && window.CircShell.loadDeck)
            ? await window.CircShell.loadDeck()
            : await (deckP = deckP || fetch('artline.json', { cache: 'no-cache' }).then(r => r.json()).catch(() => []));
        box.innerHTML = `<p class="note st-intro">${esc(t('styles.intro'))}</p>` + ordered().map(g => {
            const ex = examples(deck, g);
            return `<section class="panel st-card" id="st-${esc(g.replace(/\W+/g, '-'))}">
              <h3 class="serif">${esc(g)}</h3>
              <p>${esc(look(g))}</p>
              ${ex.length ? `<div class="st-ex">${ex.map(c => `<figure><img loading="lazy" src="${esc(img(c))}" alt="${esc(c.title)}"><figcaption>${esc(c.title)}</figcaption></figure>`).join('')}</div>` : ''}
            </section>`;
        }).join('');
    }

    // the "?" next to the style question: what to look for in the offered styles
    function explain(options) {
        const m = document.createElement('div');
        m.className = 'modal';
        m.innerHTML = `<div class="modal-content st-sheet" role="dialog" aria-modal="true" aria-labelledby="st-h" style="display:flex;flex-direction:column;gap:12px">
            <h2 id="st-h" class="serif" style="font-size:22px">${esc(t('styles.title'))}</h2>
            ${(options || []).map(g => `<div><b>${esc(g)}</b><p class="muted" style="font-size:14px;margin:2px 0 0">${esc(look(g))}</p></div>`).join('')}
            <button class="btn link" data-close>${esc(t('common.close'))}</button></div>`;
        m.addEventListener('click', e => { if (e.target === m || e.target.hasAttribute('data-close')) m.remove(); });
        document.body.appendChild(m);
        const b = m.querySelector('[data-close]'); if (b) b.focus();
    }
    const helpButton = options => `<button type="button" class="st-help" aria-label="${esc(t('styles.help'))}" data-style-help="${esc(JSON.stringify(options || []))}">?</button>`;
    document.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('[data-style-help]');
        if (!b) return;
        e.preventDefault(); e.stopPropagation();
        try { explain(JSON.parse(b.dataset.styleHelp)); } catch (err) { explain([]); }
    }, true);

    window.CircStyles = { GROUPS, groupOf, look, ordered, renderGuide, explain, helpButton };
})();
