# CIRCArt backend

Accounts, the deck, saved solo games, feedback, live and async multiplayer, daily and monthly challenges, leaderboards and stats.
It all runs on Supabase (Postgres plus sign-in), and every rule is enforced by the server.

## Files and where they go in the repo

| File | Goes to | What it does |
|---|---|---|
| `supabase/migrations/001_foundation.sql` | `supabase/migrations/` | Accounts, deck table, saved solo games, feedback |
| `supabase/migrations/002_games.sql` | `supabase/migrations/` | Game engine: live rooms and async games |
| `supabase/migrations/003_challenges.sql` | `supabase/migrations/` | Daily and monthly challenge, leaderboards, stats |
| `deck/card_keys.py` | project root | Gives each card a random, year-free key, kept in `card_keys.json` |
| `deck/sync_deck.py` | project root | Copies `www/artline.json` into the database |
| `deck/build_deploy.py` | project root (replaces yours) | Same as before, plus it publishes `docs/art/<key>.jpg` |
| `web/online.js` | `www/` | The app's connection to everything above |
| `tests/*.test.mjs` | `tests/` | 113 checks on a real Postgres with a simulated clock |

`card_keys.json` is created on the first run. Commit it, but never put it in `www/` or `docs/`, because it links every year-bearing id to its key.

## Setup

1. **Create a Supabase project** in the Frankfurt region.
2. **Turn on sign-ins:** go to *Authentication → Providers* and turn on **Anonymous sign-ins**, **Email**, **Google**, and **Allow manual linking**. Manual linking lets a guest keep their account when they add Google.
3. **Create the database:** in the *SQL editor*, run `001`, `002` and `003` in that order.
4. **Schedule the turn closer:** go to *Database → Extensions*, turn on **pg_cron**, then run:
   ```sql
   select cron.schedule('circart-close-turns', '*/5 * * * *', 'select public.close_expired_games()');
   ```
   This closes async turns after 24 hours and ends each daily challenge at midnight, even when nobody opens the game.
5. **Put the images online:** run `python build_deploy.py` and commit `docs/`. This publishes the year-free images.
6. **Load the deck:** run `python sync_deck.py www/artline.json --sql deck.sql` and paste `deck.sql` into the SQL editor. Alternatively, run `--push` with the service key.
7. **Connect the app:** put the project URL and anon key into `online.js`.

## The rules the server enforces

- **Shared timeline:** everyone places the same card. Afterwards it goes into its correct spot for everyone.
- **Clock:** 20 s per card on the server clock, plus 2 s for network lag. The phone's clock is never trusted.
- **Points:**
  - A correct card is worth 1000 for an instant answer, down to 500 at 20 s.
  - Streak bonus: +50 per card in a row, starting with the second, up to +200.
  - Artist bonus: +200 for picking the right one of 4 names after placing the card.
- **Live games:** 2–20 players, 10 cards, 1 per round. A round ends at 20 s or when everyone has answered, then there's an 8 s reveal.
- **Async games:** 2–8 players, 12 cards as 4 turns of 3, 24 h per turn.
  - A turn closes as soon as everyone has played.
  - Missing two turns in a row drops you.
  - If one player is left, the game ends.
- **Daily challenge:** 10 cards, the same for everyone, one attempt. It resets at midnight Vienna time and never repeats a card from the last 60 days.
- **Leaderboards:** only accounts with a username are ranked. Guests can play everything and see their own score.

## Monthly challenges

Without an entry for a month, the rule is "most points, your best 20 daily challenges count". To set a month, run in the SQL editor:

```sql
insert into monthly_challenges (month, title, description, metric, deck_filter) values
  ('2026-12-01', 'Baroque December', 'Every daily is 1600–1750. Most points wins.', 'daily_points',
   '{"year_min": 1600, "year_max": 1750}');
```

- **Metrics:**
  - `daily_points`: all daily scores added up
  - `daily_best20`: the best 20 daily scores added up
  - `best_streak`: the longest run of correct cards
  - `accuracy`: % placed right, with at least 50 cards
  - `artists_named`: artist bonuses earned
- **Themed months:** `deck_filter` limits that month's daily challenges by year and/or movement, e.g. `"movements": ["Baroque"]`.

## Notes

- Solo games are scored on the phone, so they only feed your personal stats, not the leaderboards.
- The sync fixes broken characters such as "AbramoviÄ‡" in the database copy and lists them, so you can fix `artline.json` too.
- Tests: `npm i @electric-sql/pglite@0.5.15`, then for example `node tests/games.test.mjs supabase/migrations tests/deck.sql`.
