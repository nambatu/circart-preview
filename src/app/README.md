# CIRCArt app shell (new home, tabs, profile, dark mode)

These files go into `www/` next to your existing game. `app.js` and `style.css` stay exactly as they are.

| File | What it is |
|---|---|
| `index.html` | Replaces yours: the new Play home, plus Ranks and Profile tabs and a tab bar. The game, gallery, end screen and modals are unchanged. |
| `shell.js` | Tabs, home, ranks, profile, theme. It hooks into `app.js` without editing it (see below). |
| `shell.css` | Styles for the new screens, plus one accent colour (wine) and dark mode for every screen, including the existing ones. |
| `strings.js` | All new text in one place, ready for translations. |
| `../backend/web/online.js` | The connection to the server. Put your Supabase URL and anon key at the top. |

## What it does

- **Tabs:** Play · Ranks · Gallery · Profile. The tab bar hides during a game and on the end screen.
- **Play:** a solo card with a random famous work, a choice of 5/10/15/20 cards, and Start. The daily challenge, "your turn" and play-with-friends sections slot into `#home-online` later (roadmap tasks 9–11).
- **Dark mode:** follows the phone's setting. Profile → Appearance can force Light or Dark, and the choice is remembered and applied before the page paints.
- **Profile:** what it shows depends on the player.
  - Signed out: "Sign in" with Google or an email link. Solo play needs no account.
  - Guest: "Keep your progress", where linking Google or email keeps the same account.
  - Every signed-in player: name in games.
  - Accounts: username, needed for the leaderboards.
  - For everyone: appearance, language, feedback, about & image credits, sign out, and delete account (asks twice).
- **Ranks:** your solo stats for now. Leaderboards come with task 11.
- **Feedback:** the flag in the game header or Profile → Send feedback. Reports are saved to the database. If that fails, your existing email fallback opens. The floating button is gone.
- **Solo games:** each finished game is saved for signed-in players with every card, right/wrong, bonuses and best streak. Games played offline are queued and sent later, including ones played before signing in.
- **Dealer:** cards you've seen on other devices in the last day count as seen.

## How it hooks into app.js

`app.js` declares its functions globally and calls them by name, so `shell.js` wraps three of them: `placeCard` logs each card, `endGame` saves the game, and `readSeen` adds the server's recently-seen cards. If you rename those functions in `app.js`, update `hookSoloGame()` in `shell.js`.

## Two small changes in your other files

1. **`sw.js`:** add the new files to `SHELL_ASSETS` so they work offline:
   ```js
   './strings.js', './shell.css', './shell.js', './game.js', './online.js',
   ```
2. **`build_deploy.py`:** the version in `claude/backend/deck/` already copies them into `docs/`.

The Supabase library loads from jsdelivr. When the phone is offline it simply doesn't load, and everything online quietly switches off while solo play works as always.

## Playing with friends (`game.js`)

One screen handles live and async games, driven by the server's phase: lobby → play → (live: locked in → reveal) / (async: your result → next card → turn done) → podium.
- **Home:** "Your games" lists open and recent games. "Play with friends" lets you choose Live or Over a few days and enter your name. There's also a join-by-code field.
- **Invite links:** `?join=K7Q2` opens the game. A first-time visitor is asked for a name, then joins as a guest.
- **Async:** a "Your turn · Start turn" step comes first, so the 20-second clock only starts when the player taps.
- **Live updates:** realtime through `watchGame`, plus a poll every 4 s (live) or 30 s (async) in case the connection drops. Countdowns use the server clock.
- **Tested:** two browser windows played a full live game and an async turn against the real engine, with 21 checks. To rerun: `tests/e2e.mjs`, which needs `npm i @electric-sql/pglite@0.5.15 playwright` and the stand-in `online.js` in `tests/e2e-online.js`.
