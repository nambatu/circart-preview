# Security and privacy — rules for every change

Distilled from the reviews of 13 Nov 2026 (server security, GDPR, plus Supabase's own advisors). Exploit details of open issues are deliberately not written here (the repo is public). Julian is the controller, a private individual in **Austria**: Austrian law (DSG, TKG 2021 § 165, ECG/MedienG for the Impressum) and the Austrian data protection authority apply.

## What is already in place (don't undo it)
- Players never touch tables directly: RLS is on for every table, `anon`/`authenticated` have no table rights except a few own-row SELECTs, and everything goes through `security definer` RPCs.
- Every function has a fixed `search_path`; every migration revokes `execute` from `public, anon, authenticated` and grants only the RPCs the app calls (`_helpers` are never granted).
- The server deals, times and scores every online game. A card's year, artist and style are only returned after the player has answered; live games hide results until the round closes; the timer is checked server-side (`_now()`, 2 s grace). Points count any answer faster than 2 s as 2 s (024).
- Player text (display names, feedback) goes through `clean_player_text` + `injection_scan` (013, strengthened in 024: NFKC folding, variation selectors, quarantine from score 2). AI agents read feedback only through `feedback_inbox()`.
- Rate limits: feedback (10/h per player), wrong join codes (8 per 10 min), open lobbies (5) and new games (30/h) per host, solo games (120/h, max 101 cards, 60 kB), runs (5/min).
- Push: only endpoints of the real push services (Google, Mozilla, Apple, Microsoft) are accepted and called (022); the Edge Function needs the cron secret (017) and has per-device timeouts (024).
- Guests can't reserve usernames (024). Leaderboards show usernames only, never guests, emails or ids.
- Account deletion removes everything incl. feedback (024); data export covers all tables; guests idle 6 months, stale lobbies, old push messages and old feedback are cleaned nightly (`privacy_cleanup`).
- No analytics or tracking service, no cookies, no third-party scripts or fonts; strict Content-Security-Policy in `src/app/index.html`.
- Guest → existing account transfer only with a one-time ticket from the guest itself (026); daily and Monthly Run results never move.

## Accepted risks (Julian's decisions — don't re-propose)
- Card years can be looked up by a determined cheater (public repo, Gallery). Not worth hiding.
- Shared daily: two accounts can scout each other's answers. Inherent to a daily that is the same for everyone.
- The all-time board counts games with friends too.

## Checklist for every server change (new migration)
1. New table: `enable row level security`, `revoke all ... from anon, authenticated`; add it to `export_my_data()`, make sure `delete_my_account()` removes it (FK `on delete cascade` to `profiles`/`auth.users` is enough) and, if it holds personal data, to `privacy_cleanup()` with a retention period.
2. New column with player-typed text: length limit (`check`), `clean_player_text`, and the `_guard_*` trigger from 013 so `injection_scan` runs.
3. New function: `set search_path = public`, `security definer` only when needed, `_me()` for the caller (never trust a player id parameter), check membership for any game id, `revoke` + `grant ... to authenticated` only if the app calls it. Never return a card's year/artist/movement before the caller has answered that card.
4. Anything a player can call repeatedly that creates rows or sends things (emails, pushes, invites, friend requests): a per-player rate limit.
5. A test in `src/tests/` for the security property (not only the happy path).
6. Run `get_advisors` (security + performance) on the preview project after deploying, if you have the Supabase connection.

## Checklist for every app change
- Insert player-controlled or server text only through `esc()` (shell.js/game.js); no `innerHTML` with raw strings.
- No inline scripts, `onclick=` or external hosts: the CSP blocks them and the e2e test fails.
- Push notifications: one switch per kind (your turn, invitations, streak reminders …), each off until the player turns it on.

## Privacy texts (`src/legal/privacy-en.html` + `privacy-de.html`) must change when …
- a new kind of personal data is stored (friends lists, invitations, streaks …): what, why, how long, who sees it;
- a new recipient gets data (email provider, Google sign-in, app stores): name, purpose, country and safeguard (EU-US Data Privacy Framework / SCCs);
- a new push kind or anything stored on the device is added (list it in section 2, all must be strictly necessary or opt-in);
- retention or deletion behaviour changes.
Always change EN and DE together, plain full sentences, informal "du".

Planned features already known to need text: friends (who sees your username, stats and badges; friendships are deleted with the account), invitations by push (inviter's name goes through the push service, encrypted), streak reminders (separate opt-in), app stores (Google/Apple as recipients, store privacy labels, trader details shown publicly in the EU), email provider + Google login (task 25).

## Open items (see the roadmap)
- Task 54: client + build-pipeline security review (the reviewer of 13 Nov didn't finish).
- Task 55: bugs / performance / UX review (didn't finish either).
- Task 56: privacy text and app gaps found in the GDPR review that need no decision from Julian.
- Before release, Julian has to fill in his contact details and sign off the legal pages (his own checklist is kept privately).
