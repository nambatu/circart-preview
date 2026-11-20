# CIRCArt — how the pieces fit together

A map for agents new to the code. Rules are in `AGENTS.md`, the work queue in `notes/roadmap.md`.

## Two repos, one app
- **nambatu/circart** (Admin's game repo, public; never push): Admin's original offline game ("base game"). Its published `docs/` has `app.js` (solo game, timeline, gallery), `style.css`, `artline.json` (the 230-card deck) and `images/`. The tools clone it read-only into `~/circart-game`.
- **nambatu/circart-preview** (this repo, public): everything new — the online modes, the server, and the preview site at https://nambatu.github.io/circart-preview/.

The app = base game assets (`artline.json`, `images/`, `icons/`, `style.css`, `pwa.js`, `manifest.webmanifest`) + the files from `src/app/` laid on top. `src/preview/build_preview.py` does that: it starts from the game repo's `docs/`, strips retired legacy files (`app.js`, `Abstract Painting Loader.json`, `vendor/lottie-player.js`), adds `src/app/*`, points `src/web/online.js` at the preview Supabase project, pins `index.html`'s CSP (`connect-src` to the preview Supabase host, `img-src 'self' data: blob:`), sets manifest `id: "./"`, builds `changes.html` with a strict SHA-256 CSP, republishes every card image under a random year-free key (`docs/art/<key>.jpg`, keys kept in `card_keys.json`), adds packs and story dailies (never emitting `upload.wikimedia.org` URLs into `supabase/dailies.sql`), writes `supabase/` (migrations + `deck.sql`, `packs.sql`, `dailies.sql`), never writes `CNAME`, and copies the workflow files to `.github/workflows/`. `src/tools/deploy_preview.sh` runs the build (cleaning its temp dir via `trap ... EXIT`), commits source + output and pushes. For the real game, `src/ship/stage.py` + `src/deck/build_deploy.py` + `src/ship/SHIP.md` run production preflight guards (rejecting preview project IDs/URLs, unconfigured `config.json`, `zz_preview_*.sql`, raw Wikimedia `www/packs/`, and unfilled legal drafts/placeholders), apply `deck_fixes.py`, pass `--site` to `sync_deck.py`, and stage year-free built packs via `--preview-repo` into a pull request on nambatu/circart.

## The app (`src/app/`, plain JavaScript, no framework)
- `index.html` loads, in order: `strings.js` + `strings-de.js` (all texts, EN/DE, via `t('key')`), `vendor/supabase.js`, `online.js`, `styles.js`, `dealer.js` (fair solo card dealing), `collection.js` (`circart-collection` local progress + `my_collection()`), `packs.js`, `shell.js` (tabs: Play, Ranks, Gallery, Profile; home screen; profile and sign-in; gallery collection; zoom), `game.js` (solo, packs, daily, Monthly Run, story dailies, games with friends — live and async), `onboarding.js`, `pwa.js`.
- Strict Content-Security-Policy: no inline scripts or handlers (one inline theme script is allowed by its sha256 in the CSP meta), `img-src 'self' data: blob:` (zero Wikimedia requests from client or DB), and built `index.html` pins `connect-src` to `'self'` plus the exact Supabase project (`https://<ref>.supabase.co`, `wss://<ref>.supabase.co`). Legal pages (`src/legal/*.html`) use `script-src 'none'` and `no-referrer`.
- `docs/sw.js` (service worker): network-first for preview shell files, precaches the app shell, legal pages (`privacy-en.html`, `privacy-de.html`, `impressum.html`), and `vendor/*` assets, handles offline page navigation fallback, caches `/images/` + `/art/`, strips dead Google Fonts / `unpkg` rules, and appends `sw-push.js` for push notifications.
- Text from the server or players is inserted with `esc()`.

## The server (Supabase: Postgres + sign-in + one Edge Function)
- Everything is SQL in `src/supabase/migrations/` (applied in order; never edit an applied one). Players call `security definer` functions over PostgREST (`sb.rpc(...)` in `online.js`); tables are closed to them via RLS and revoked grants (shared daily/run `game_players` rows are hidden from direct `SELECT`, `daily_story()` is gated by date, and `my_collection()` maps `cards.source_id` only for cards the caller met or answered).
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
- Base deck: `artline.json` from the game repo, synced to `cards` (`src/deck/sync_deck.py` with `--site` validation and hardened SQL escaping); `src/deck/deck_fixes.py` applied in both preview and production builds.
- Packs: `src/packs/*.json` (25 public-domain cards each, own images downloaded by the `pack-images` Action into `pack-art/` and staged year-free for production via `--preview-repo`).
- Story dailies: `src/dailies/<date>-<slug>.json`, built and published by Claude's story-daily task (`src/dailies/SKILL.md`, `src/preview/publish_story.py`, `src/tools/check_story.py`); `dailies.sql` never emits `upload.wikimedia.org` URLs (all images point to `{site}/art/<key>.jpg`), and every finished daily is saved to `src/dailies/history/` by the `daily-history` Action.

## Tests
- `src/tools/test_all.sh`: every `src/tests/*.test.mjs` runs all migrations on PGlite (an embedded Postgres) with a fake `auth` schema and a test clock; `auth.test.mjs` runs `online.js` against a fake Supabase client; then the browser test `src/app/tests/e2e.mjs` (Playwright) serves the built app with `e2e-online.js`, a stand-in for `online.js` that sends every call to a local PGlite server. It also fails on any CSP violation.
- Must end with `ALL GREEN` before deploying.
