# Shipping CIRCArt to production

"Ship it" moves what you tested on the preview to the real game at **YOUR-GAME-DOMAIN**.
The real game gets its **own** database, separate from the preview, so test players and test scores never mix with real ones.

Who does what:
- **You (Admin):** step 1, filling in your local legal pages, step 5 (merge), and step 6 (phone test).
- **Build agent:** everything else. Never push directly to the game repo; prepare a branch and let Admin merge the pull request.

## 1. Create the production Supabase project (you, about 10 minutes, once)

1. **New project:** on supabase.com, create a project called `circart`. Pick the Frankfurt region and save the database password somewhere safe.
2. **Sign-ins:** go to *Authentication → Sign In / Providers*. Turn on **Anonymous sign-ins** and **Email**. Google comes later, and when you add it, also turn on **Allow manual linking**.
3. **Where sign-in links go:** go to *Authentication → URL Configuration*. Set **Site URL** to `https://YOUR-GAME-DOMAIN/` and add `https://YOUR-GAME-DOMAIN/**` under Redirect URLs.
4. **Sign-in email templates (`src/email/`):** go to *Authentication → Emails → Templates* and paste `confirm-signup.html`, `magic-link.html`, and `change-email.html` with the subjects from `src/email/README.md`. Keep both `{{ .Token }}` (6-digit code) and `{{ .ConfirmationURL }}` (magic link), and change the logo image URL in all three templates from the preview URL to `https://YOUR-GAME-DOMAIN/icons/icon-192.png`.
5. **Send the public project details:** from *Project Settings → API*, copy the **Project URL** and the **anon public** key. Both are public, so you can share them in chat. Never paste the service_role key or the database password.

## 2. Create the database (in the production SQL editor)

- **Run the migrations:** run every file in `supabase/migrations/` (`001` up to the newest) **in order**, once each.
- **Never run any `zz_preview_*.sql` file:** all `zz_preview_*.sql` files (`zz_preview_cron.sql`, `zz_preview_push.sql`, `zz_preview_push_secret.sql`, `zz_preview_privacy.sql`, `zz_preview_replay.sql`, `zz_preview_test_push.sql`) are preview-only and must never exist in `supabase/` or run on production. Use `ship/prod_cron.sql` instead (step 3).
- **Check `supabase/config.toml`:** if present in the game repo, verify it is linked to the production project and never contains the preview project ID (`rzptvdlejmdeaanhbbtd`).

## 3. Notifications and scheduled jobs

1. **Deploy the Edge Function:** link the CLI to the **production** project (never the preview project) and deploy `supabase/functions/send-push` with JWT verification **off**:
   `supabase functions deploy send-push --no-verify-jwt`
2. **Fresh VAPID keys for production:** create them with `npx web-push generate-vapid-keys`. Never reuse the preview's keys. Then run in the SQL editor:
   ```sql
   insert into private.settings values
     ('vapid_public', '<public>'), ('vapid_private', '<private>'),
     ('vapid_subject', 'https://YOUR-GAME-DOMAIN'), ('site', 'https://YOUR-GAME-DOMAIN');
   ```
   The private key only goes there, never into a file or the chat log.
3. **Turn on the scheduled jobs:** replace `PROJECT-REF` in `ship/prod_cron.sql` with the production project's reference and run it in the production SQL editor. Check with `select jobname, schedule, active from cron.job order by jobname;`, which should list 4 jobs (`circart-close-turns`, `circart-privacy-cleanup`, `circart-push`, `circart-push-reminders`).

## 4. Prepare legal pages and build the site

1. **Fill legal pages locally (outside the repo):** copy `src/legal/privacy-en.html`, `src/legal/privacy-de.html`, and `src/legal/impressum-template.html` (renamed to `impressum.html`) to a local folder outside git (never commit personal details to `circart-preview`). Replace every `[PLACEHOLDER]` / `[PLATZHALTER]`, fill in your contact details, email provider, and backup retention days, and delete the `.draft` notice boxes.
2. **Prepare the branch:** clone `nambatu/circart` and create a branch `ship-online`.
3. **Write the settings:** put the production settings in `prod.json` (outside the repo):
   `{"supabase_url": "...", "anon_key": "...", "vapid_public": "<public VAPID key>", "site": "https://YOUR-GAME-DOMAIN"}`
4. **Build:**
   ```
   python3 ship/stage.py --game <clone> --backend <folder with app/ web/ deck/ supabase/ legal/> \
       --config prod.json --site https://YOUR-GAME-DOMAIN --legal <local legal folder> \
       --preview-config src/preview/preview.json --deck-sql /tmp/deck.sql \
       --preview-repo <clone of circart-preview> --packs-sql /tmp/packs.sql
   ```
   Always pass `src/preview/preview.json` (not the unconfigured template `config.json`). This copies the new app files into `www/`, the build scripts (`build_deploy.py`, `card_keys.py`, `sync_deck.py`, `deck_fixes.py`) and `supabase/` into the repo, writes `deploy_config.json`, and runs `build_deploy.py` + `sync_deck.py --site ...`, which:
   - fills in `online.js` and pins `index.html`'s CSP (`connect-src` to the exact production Supabase host, `img-src 'self' data: blob:`)
   - sets manifest `id: "./"`, updates `sw.js` (precaching legal pages + `vendor/*`, stripping dead Google Fonts / `unpkg` rules, adding push handlers)
   - keeps `CNAME` for the target domain
   - applies `deck_fixes.py` to `docs/artline.json` and `deck.sql`, and publishes `docs/art/<key>.jpg` with **new** keys in the repo's own `card_keys.json`
   - with `--preview-repo`: copies the year-free built packs and the 100 pack photos from `pack-art/` into `docs/` (without leaving raw Wikimedia pack JSONs in `www/packs/`) and writes `packs.sql` for the production database

   Preflight stops if anything looks wrong: preview Supabase project (`rzptvdlejmdeaanhbbtd`) or preview domain, placeholder `YOUR-GAME-DOMAIN` / keys, unconfigured `--preview-config`, `zz_preview_*.sql`, raw Wikimedia URLs in packs, preview/legacy files in `docs/`, or unfilled placeholders / draft banners in `privacy-*.html` or `impressum.html`.
5. **Load the deck:** paste `deck.sql` into the production SQL editor, or run `sync_deck.py docs/artline.json --site https://YOUR-GAME-DOMAIN --push` with the service key set on your computer only. Use the `card_keys.json` from this same build, or the images and the database won't match. Then paste `packs.sql` (from `--packs-sql`) the same way.

## 5. Pull request (Claude prepares, you merge)

1. **Commit:** commit on `ship-online`: `www/` files, `docs/`, `card_keys.json`, `deploy_config.json`, the build scripts and `supabase/`.
2. **Open the PR:** open a pull request on `nambatu/circart` with a plain-English summary.
3. **Merge:** you merge it. GitHub Pages redeploys in about a minute.

4. **Daily history for the real game:** before the preview database is reset or retired, run the `daily-history` Action in nambatu/circart-preview by hand once, so `src/dailies/history/preview.json` holds every preview-era daily. These may be reused in the real game, each one once, with `"reuse_of": "<old date>"` in the story's theme. Then set up the same nightly export for production (a copy of `src/preview/daily-history.yml` writing `src/dailies/history/production.json`, with a production secret Admin adds), so the real game never repeats a daily.

## 6. Phone smoke test (you, about 10 minutes)

Open YOUR-GAME-DOMAIN and pull to refresh twice so the new version loads.

- [ ] **Solo game:** the home screen shows Play · Ranks · Gallery · Profile, and a solo game starts and finishes.
- [ ] **Sign in:** Profile → sign in with an email link. The link opens YOUR-GAME-DOMAIN, not the preview.
- [ ] **Saved game:** after a solo game, Ranks shows your stats.
- [ ] **Daily challenge:** it plays, and the images load.
- [ ] **Live game:** start one with a friend or a private tab, and the invite link works.
- [ ] **Async game:** start one. "Your turn" notifications arrive once you allow them.
- [ ] **Feedback:** Profile → Send feedback, and the report appears in the production `feedback` table.
- [ ] **Installed app:** the home-screen app still opens and works offline for solo play.

## 7. If something is wrong: roll back

- **Website:** on GitHub, open the merged PR and click **Revert**, then merge the revert. The old game is back within minutes, and solo play never needed the database.
- **Database:** nothing to undo. Every change is additive and the old game doesn't use it. Fix forward with a new migration (next free number, e.g. `031_…`) and ship again.
- **Notifications:** to pause them, run `select cron.unschedule('circart-push');`.
