# CIRCArt multiplayer & accounts — design decisions (draft, Nov 2026)

The earlier async-duel draft is discarded. Julian's original game (repo nambatu/circart, live at circart.langschwerts.de) is the base; this repo's `src/` builds on top of it.

## Decided
- Solo games are saved for logged-in players (stats, history, seen cards across devices). Solo stays playable offline. Solo results are personal stats only and don't feed leaderboards.
- Sign-in: guest, email + username, Google. No Apple for now; it becomes mandatory if an iOS app offers Google sign-in.
- Guests can play every mode, including async (asked for a display name on join, then prompted to save their account). Leaderboards need an account and a username.
- Feedback/card reports are stored in the database. No email notifications for now (neither feedback nor turns).
- English and German, with more languages possible: no hard-coded strings in new screens, and a language row in Profile.
- `artline.json` stays the master deck and is synced into the database (`sync_deck.py`). Cards get random year-free keys (`card_keys.json`); images are also published as `docs/art/<key>.jpg`.
- Players rarely used the title/year/artist typing bonuses.
- Party/TV mode: not now.

## One rule set for all competitive modes
- **Shared timeline:** everyone places the same card into the same timeline; after the reveal it is inserted in its correct spot for everyone.
- **Timed scoring:** correct = 500–1000 points by speed, wrong = 0, plus a streak bonus. The answer clock is server-side and starts when the server hands out the card. 20 s per card by default (the lobby can switch the timer off or pick other seconds).
- Optional artist bonus: tap 1 of 4 names. Optional style bonus.
- Classic solo keeps its Hitster rules (wrong cards are dropped).
- Monthly Run: 1 point per correctly placed card, no bonus questions.

## Live room (Kahoot-style)
- Host opens a room with a 4-character code; 2–20 players. Card shown to all at once; the round closes after the timer.
- Reveal: correct spot, how many chose each gap, a line of trivia, standings with movement. Podium after 10 cards.

## Async game ("a day per turn")
- 2–8 players, 12 cards as 4 turns of 3 cards (turn size is a setting).
- 24 h to start each turn. A turn closes early when everyone has played. Missed cards score 0; two missed turns in a row drop the player.
- Your result is shown immediately; everyone's choices when the turn closes.
- Notifications: in-app "Your turn" list; web push (Android/desktop, installed PWA on iPhone). Deadline reminders come from a scheduled job.

## Daily & monthly challenge
- Daily: the same ~10 cards for everyone, one attempt, timed rules; daily leaderboard; streak of days played. On some days a story daily (3–30 cards with one red thread) replaces the random deal.
- Monthly: the rule is stored in the database (metric + optional deck filter) so it can change each month.

## Leaderboards & stats
- Tabs: Today · This month · All time.
- All-time stats: total points, accuracy, games, best streak, daily streak, multiplayer wins and podiums.

## App layout
- Bottom tabs: Play · Ranks · Gallery · Profile.
- Card packs live in Gallery → Packs and are only played via "Play this pack" (never mixed into normal games).

## Open
- What the all-time leaderboard ranks (points vs a skill rating).
