# CIRCArt — how the pieces fit together

A map for agents new to the code. Rules are in `AGENTS.md`, the work queue in `notes/roadmap.md`.

## Two repos, one app
- **nambatu/circart** (Admin's game repo, public; never push): Admin's original offline game ("base game"). Its published `docs/` has `app.js` (solo game, timeline, gallery), `style.css`, `artline.json` (the 230-card deck) and `images/`. The tools clone it read-only into `~/circart-game`.
- **nambatu/circart-preview** (this repo, public): everything new — the online modes, the server, and the preview site at https://nambatu.github.io/circart-preview/.

The app = base game files + the files from `src/app/` laid on top. `src/preview/build_preview.py` does that: it starts from the game repo's `docs/`, adds `src/app/*`, points `src/web/online.js` at the preview Supabase project, republishes every card image under a random year-free key (`docs/art/<key>.jpg`, keys kept in `card_keys.json`), adds packs and story dailies, writes `supabase/` (migrations + `deck.sql`, `packs.sql`, `dailies.sql`) and copies the workflow files to `.github/workflows/`. `src/tools/deploy_preview.sh` runs the build, commits source + output and pushes. For the real game, `src/ship/stage.py` + `src/ship/SHIP.md` do the same into a pull request on nambatu/circart.

## The app (`src/app/`, plain JavaScript, no framework)
- `index.html` loads, in order: `strings.js` + `strings-de.js` (all texts, EN/DE, via `t('key')`), `vendor/supabase.js`, `online.js`, the base `app.js`, then `shell.js` (tabs: Play, Ranks, Gallery, Profile; home screen; profile and sign-in; gallery collection; zoom), `game.js` (daily, Monthly Run, story dailies, games with friends — live and async), `solo.js` + `dealer.js` (solo game on top of the base game, fair card dealing), `packs.js`, `onboarding.js`.
- Strict Content-Security-Policy: no inline scripts or handlers (one inline theme script is allowed by its sha256 in the CSP meta), only our own host and `*.supabase.co`.
- `docs/sw.js` (service worker): network-first for app files, caches images; `sw-push.js` shows push notifications.
- Text from the server or players is inserted with `esc()`.

## The server (Supabase: Postgres + sign-in + one Edge Function)
- Everything is SQL in `src/supabase/migrations/` (001–026, applied in order; never edit an applied one). Players call `security definer` functions over PostgREST (`sb.rpc(...)` in `online.js`); tables are closed to them (RLS, no grants).
- Main tables: `profiles`, `cards`, `solo_games` + `solo_game_cards`, `games` (kind `live` / `async` / `daily` / `run`) + `game_cards` + `game_players` + `answers`, `daily_themes` + `daily_theme_cards` (story dailies), `packs` + `player_packs`, `feedback`, `push_subscriptions` + `push_outbox`, `join_failures`, `guest_transfers`; `private.settings` holds the VAPID keys and the cron secret.
- Game flow: `play_daily` / `start_run` / `create_game` + `join_game` + `start_game` → `next_card` (opens a card, starts its clock) → `answer(slot)` → `pick_bonus(artist, style)` → `reveal`. `_tick()` advances turns; `get_game` is the state the app polls. Times come from `_now()` (tests can set `circart.test_now`).
- The daily: `_ensure_daily(date)` deals it once for everyone (a story theme if one exists for that day, else random cards not used in the last 60 days). Day boundaries are Vienna time (`_today()`).
- Scheduled database jobs (pg_cron): close expired turns, queue turn reminders, call the Edge Function to send pushes, nightly `privacy_cleanup()`.
- Push: game events insert into `push_outbox`; the cron job calls `send-push` (Edge Function, `src/supabase/functions/send-push/`) with the secret header; it fetches a batch with `push_batch(secret)`, sends Web Push with the VAPID keys, reports back with `push_done`.

## Sign-in (`src/web/online.js`, migration 026)
- Playing online without an account silently creates a **guest** (Supabase anonymous sign-in).
- **Email sign-in** sends an email with a 6-digit code and a link (`src/email/` templates). `signInWithEmail()` → mode `attach` (guest + new email: the email is added to the guest, nothing is lost), `existing` (guest + email that already has an account: the guest takes a one-time transfer ticket, then signs in to that account; after the code, `finish_guest_transfer` moves solo games, packs, games with friends, devices and feedback — never daily/run results — and deletes the guest) or `signin` (signed out). `verifyEmailCode()` checks the code.
- Google sign-in exists in the code but isn't configured yet (roadmap task 25).
- Usernames (for leaderboards) only for real accounts; guests have a display name.

## Content
- Base deck: `artline.json` from the game repo, synced to `cards` (`src/deck/sync_deck.py`); style fixes in the build.
- Packs: `src/packs/*.json` (25 public-domain cards each, own images downloaded by the `pack-images` Action).
- Story dailies: `src/dailies/<date>-<slug>.json`, built and published by Claude's story-daily task (`src/dailies/SKILL.md`, `src/preview/publish_story.py`, `src/tools/check_story.py`); every finished daily is saved to `src/dailies/history/` by the `daily-history` Action.

## Tests
- `src/tools/test_all.sh`: every `src/tests/*.test.mjs` runs all migrations on PGlite (an embedded Postgres) with a fake `auth` schema and a test clock; `auth.test.mjs` runs `online.js` against a fake Supabase client; then the browser test `src/app/tests/e2e.mjs` (Playwright) serves the built app with `e2e-online.js`, a stand-in for `online.js` that sends every call to a local PGlite server. It also fails on any CSP violation.
- Must end with `ALL GREEN` before deploying.
