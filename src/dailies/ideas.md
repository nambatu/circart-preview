# Themed daily challenges: idea bank + review workflow

Julian (6 Nov 2026): "A challenge with only those pieces together with a story told along a red string would be amazing. Also daily challenges from museums or single artists together with their story. Give it for me to review every evening. Develop your own ideas."
Julian (6 Nov 2026, later): "if you have the time you can plan days ahead but the most important thing is the next day(s) and not next week or month."

## What a themed daily is
- **A handful of works with one red thread** (3 to 30 cards to place; "sometimes shortness is the sweetest"). Same for everyone that day, like today's dailies.
- **Intro** (2–3 sentences) before the first card: where we are, what connects the works.
- **A chapter after every card** (1–2 sentences, shown with the reveal): what happened next, leading to the next card. Read in order, the chapters tell one story.
- **Outro** on the results screen: how the story ends.
- **The order must not be chronological** (otherwise every card goes to the right end of the timeline): the red thread is a walk, a story or a theme, and the years jump. At most two rising years in a row.
- **At least six cards to place (Julian, 12 Nov):** fewer than six is generally not much fun.
- **The chapter is the only text players read after a card (Julian, 13 Nov):** story dailies hide the card trivia (roadmap task 53), so each chapter carries the story on its own. Make it red-lined and interesting: what happened, why it mattered, a surprising turn, and a lead into the next card. Leave out mundane facts (sizes, materials, which room it hangs in) unless they are part of the story. Still fill `trivia`/`trivia_de` (the Gallery and other modes show them), but never repeat it in the chapter.
- **Uncertain dates need room (Julian, 7 Nov):** a card whose year is only approximate or attributed ("about 1240") is fine, but no other card in the story may be within about ±30 years of it.
- Writing style: the roadmap rules (plain sentences, no comma lists, at most one art pun per screen). EN + DE.

## Hard rules for every draft
- **Images:** public domain for paintings by artists who died before 1956. For **sculptures, tombs and buildings** the *photo* has its own copyright → use photos with a free license (CC0 / CC BY / CC BY-SA from Wikimedia Commons) and show the photographer credit. Modern works: Julian decides himself and handles the rights (6 Nov) — mark them "copyright – artwork by X" so he knows.
- Find photos with the `commons-lookup` workflow in this repo (cloud workspaces can't reach Wikimedia). Look at every downloaded image before the story goes live.
- Every year and fact needs a source (museum page or Wikipedia + one more). Leave out anything you can't source.

## Planning horizon
The next 1–2 days come first: build approved drafts for tomorrow / the day after into JSON and deploy them. Only then write a new draft, for a date in the next few days. Not every day needs a story.

## Build notes (learned 7–8 Nov)
- A story card whose id matches a pack card (same year + artist + title) gets the pack card's key and photo; the story upsert then overwrites that card's title/trivia in the database. Happened with Anguissola "The Chess Game" (Renaissance pack) and Morisot "The Cradle" (Impressionists pack) for 8 Nov. Harmless, but check the pack card's photo on the contact sheet.
- `publish_story.py` rewrites `supabase/dailies.sql` from the stories in `src/dailies/`. Every story stays in that folder, so earlier days stay in the file.
- In scheduled runs the web reader may be blocked (permission prompts nobody answers). Then use Commons descriptions from `commons-lookup` (they carry dates + museums) as one of the two sources.
- (8 Nov) In scheduled runs WebFetch worked for URLs that had come up in a WebSearch result first; other URLs failed with PROVENANCE_REQUIRED. So: search first, then fetch the result URLs.

- (11 Nov) A story card that matches a base-deck card (Mona Lisa, The Scream, Ghent Altarpiece) shares its key too. Copy the deck card's fields, English trivia and Commons photo exactly, so nothing changes for normal games.
- (11 Nov) `check_story.py` counts cards in a rising run: 1432 → 1814 → 1882 is already an error. Check the order of a draft with the tool before sending it to Julian.
- (12 Nov) In scheduled runs musee-orsay.fr pages can't be read (error from the site), and Wikipedia pages only if they came up in a search first. Google Arts & Culture, nga.gov, artic.edu and marmottan.fr worked.
- (11 Nov) `gh` can't start workflows in scheduled runs; start `commons-lookup` with the GitHub connector (run workflow, input `category`).

## Idea bank (pick from here, add new ones)
1. **A place and its centuries** — ✅ done: Würzburg Cathedral (7 Nov). Same pattern: Cologne Cathedral, Aachen, Bamberg, Naumburg, Strasbourg, the Residenz Würzburg. Idea: ask the Museum am Dom / diocese for a partnership.
2. **One museum in a handful of works** — open-access collections: Rijksmuseum, the Met, Cleveland Museum of Art, SMK Copenhagen, National Gallery of Art (Washington), Städel (check licences). Red thread: the museum's own history.
3. **One artist's life** — Dürer, Rembrandt, van Gogh, Artemisia Gentileschi, Hokusai, Monet (approved for his birthday, 14 Nov). Chapters follow the biography. Harder (years close together) → good for a "hard Sunday".
4. **One subject through time** — the Annunciation, the self-portrait, the sea, the city at night, cats, vanitas. ✅ St Martin's cloak → live for Wed 11 Nov.
5. **Teacher and pupil chains** — Verrocchio → Leonardo; Perugino → Raphael; Rubens → van Dyck.
6. **Art crime and lucky escapes** — the Mona Lisa 1911, the Ghent Altarpiece, wartime evacuations. ✅ live for Fri 13 Nov. Spare thefts: Turner "Shade and Darkness" (Frankfurt 1994), Rembrandt "Jacob de Gheyn III" (stolen four times), Vermeer "The Concert" (Gardner 1990).
7. **Lost and rebuilt** — works destroyed in wars or fires and what came back (Dresden, Würzburg 1945).
8. **One city across 500 years** — Venice, Paris, Amsterdam, Nuremberg.
9. **Women who were written out** — ✅ live for Sun 8 Nov. Another round for International Women's Day (8 Mar): Angelica Kauffman, Mary Moser, Clara Peeters, Rachel Ruysch, Marie-Guillemine Benoist.
10. **Calendar days** — an artist's birthday, a famous opening or theft date, holidays and seasons: Advent and Christmas (nativities, winter pictures), Easter, November (vanitas and All Saints), carnival, summer, Halloween (the uncanny), Valentine's Day (lovers in art).
11. **Week arcs** — Monday to Sunday as seven chapters of one bigger story. Good for streaks.
12. **Players' places** (later) — suggestions through the feedback form, via the injection guard and Julian's review.
13. **Julian's own visits** — when Julian mentions a place he visited, turn it into a story soon after, while it's fresh.
14. **Record prices at auction** (Julian, 11 Nov — wanted: 2–3 stories, a little series). Source: Wikipedia "List of most expensive paintings" (and "…sculptures"), which gives the price at sale AND the price in today's money, the date of sale and the auction house; Julian accepts Wikipedia as the source for prices (the year of the WORK still needs two sources as always). Public auctions only, no private sales (their prices are guesses). Players still place each work by the year it was made; the chapters tell the sale stories (who bought, how fast the bidding went, records broken), always with the price in today's money. Possible split: (a) Old Masters and the 19th century — Salvator Mundi, Rubens, Rembrandt, Monet, Cézanne, van Gogh; (b) the modern record breakers — Klimt, Modigliani, Picasso, Munch's Scream; (c) maybe later: sculptures (Giacometti, Brâncuși). Many 20th-century works are still under copyright and lack free photos: Julian decides on copyright, but pick works with a good photo. A good fit for a Mon–Wed or Fri–Sun arc.

## Evening review format (one draft per evening, short)
| | |
|---|---|
| **Theme** | title EN / DE |
| **Red thread** | 1 sentence |
| **Suggested date** | in the next few days (why that day) |
| **Works** | year · artist · title · image status (✅ PD / ✅ CC BY-SA, credit X / ⚠️ copyright) |
| **Intro + 2 sample chapters** | to judge the tone |
| **Open questions** | anything Julian must decide |

Julian answers "approve", "change …" or "drop". Approved drafts are built into `src/dailies/<date>-<slug>.json` (full intro, chapters and outro in EN + DE) and deployed. Drafts waiting for an answer are kept in full in `src/dailies/drafts/`.

## Drafts reviewed so far
<!-- date · theme · Julian's answer -->
- 2026-11-06 (manual) · "One cathedral, many centuries / Ein Dom, viele Jahrhunderte" (Würzburg Cathedral) · built and live for **Sat 7 Nov** (`2026-11-07-wuerzburg-dom.json`)
- 2026-11-06 (evening build) · "Written out of the picture / Aus dem Bild gedrängt" (idea 9) · **approved 6 Nov 18:49 → Sun 8 Nov** · built and **live 7 Nov** (`2026-11-08-written-out.json`)
- 2026-11-07 (story-daily run) · "Half a cloak / Ein halber Mantel" (St Martin) · **Julian 7 Nov evening: change — add one more modern painting; Bassenheim Rider OK if no card within ±30 years; date Wed 11 Nov confirmed** → changed · built early and **live 8 Nov** for **Wed 11 Nov** (`2026-11-11-saint-martin.json`). Wilfred Thompson (1918) had only one source, so the modern card is Gebhard Fugel's ceiling painting in Wangen im Allgäu (1900).
- 2026-11-08 (story-daily run) · "Monet's life in eight pictures / Monets Leben in acht Bildern" (full draft in `drafts/draft-2026-11-08-monet.md`) · **Julian 8 Nov evening: approved as suggested (8 cards) for Sat 14 Nov; repeats from packs are fine in general** → built and **live 12 Nov** for **Sat 14 Nov** (`2026-11-14-monet.json`). Order as in the draft; texts keep only facts found on the museum pages or Wikipedia
- Mon 9 + Tue 10 Nov: no story, normal random daily.
- 2026-11-09 (story-daily run) · "Bad luck, good luck / Pech und Glück" (famous art thefts, 7 cards, suggested Fri 13 Nov; full draft in `drafts/draft-2026-11-09-stolen.md`) · **Julian 9 Nov evening: approved for Fri 13 Nov as suggested; mention the IRA link in the Vermeer chapter** → built and **live 11 Nov** for **Fri 13 Nov** (`2026-11-13-stolen.json`). Vermeer and van Gogh swapped places (the draft order had three rising years in a row), Goya counts as 1814. Monet is next, in the Thu 12 run
- 2026-11-10 (story-daily run) · "The skull on the table / Der Schädel auf dem Tisch" (vanitas and memento mori, 7 cards, suggested Sun 15 Nov; full draft in `drafts/draft-2026-11-10-skull.md`) · **Julian 11 Nov: approved as suggested (7 cards) for Sun 15 Nov** → build in the Fri 13 run (after the thefts and Monet), live before Sat 14 Nov 24:00
- 2026-11-12 (story-daily run) · "Under the hammer / Unter dem Hammer" (record prices at auction, part 1 of the series, 6 cards, suggested Mon 16 Nov; full draft in `drafts/draft-2026-11-12-hammer.md`) · **Julian 12 Nov evening: six cards are enough (keep it), Monet again is fine ("everyone loves Monet"), part two whenever it fits** → taken as approved for **Mon 16 Nov**; build in the Sat 14 run (after the skull on Fri 13), live before Sun 15 Nov 24:00. Prices, sale details and years still to be checked in the build run. Part two (modern record breakers) is planned for Wed 18 Nov, draft in one of the next runs
