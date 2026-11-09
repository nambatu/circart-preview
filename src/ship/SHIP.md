# Shipping CIRCArt to production

"Ship it" moves what you tested on the preview to the real game at **circart.langschwerts.de**.
The real game gets its **own** database, separate from the preview, so test players and test scores never mix with real ones.

Who does what:
- **You (Julian):** steps 1, 4 (one copy-paste), 7 (merge) and 8 (phone test).
- **Claude:** everything else. Claude never pushes to the game repo. It prepares a branch and you merge the pull request.

## 1. Create the production Supabase project (you, about 10 minutes, once)

1. **New project:** on supabase.com, create a project called `circart`. Pick the Frankfurt region and save the database password somewhere safe.
2. **Sign-ins:** go to *Authentication → Sign In / Providers*. Turn on **Anonymous sign-ins** and **Email**. Google comes later, and when you add it, also turn on **Allow manual linking**.
3. **Where sign-in links go:** go to *Authentication → URL Configuration*. Set **Site URL** to `https://circart.langschwerts.de/` and add `https://circart.langschwerts.de/**` under Redirect URLs.
4. **Send Claude the project details:** from *Project Settings → API*, copy the **Project URL** and the **anon public** key. Both are public, so you can paste them into the chat. Never paste the service_role key or the database password.

## 2. Create the database (Claude, or you in the SQL editor)

- **Run the migrations:** run `supabase/migrations/001` → `007` **in order**, once each.
- **Don't run the preview files:** `zz_preview_cron.sql` and `zz_preview_push.sql` are preview-only. Use `ship/prod_cron.sql` instead (step 3).

## 3. Notifications and scheduled jobs (Claude)

1. **Deploy the Edge Function:** deploy `supabase/functions/send-push` with JWT verification **off** (`supabase functions deploy send-push --no-verify-jwt`).
2. **Fresh VAPID keys for production:** create them with `npx web-push generate-vapid-keys`. Never reuse the preview's keys. Then run in the SQL editor:
   ```sql
   insert into private.settings values
     ('vapid_public', '<public>'), ('vapid_private', '<private>'),
     ('vapid_subject', 'https://circart.langschwerts.de'), ('site', 'https://circart.langschwerts.de');
   ```
   The private key only goes there, never into a file or the chat log.
3. **Turn on the scheduled jobs:** replace `PROJECT-REF` in `ship/prod_cron.sql` with the project's reference and run it. Check with `select jobname from cron.job;`, which should list 3 jobs.

## 4. Build the site (Claude)

1. **Prepare the branch:** clone `nambatu/circart` and create a branch `ship-online`.
2. **Write the settings:** put the production settings in `prod.json`:
   `{"supabase_url": "...", "anon_key": "...", "vapid_public": "<public VAPID key>"}`
3. **Build:**
   ```
   python3 ship/stage.py --game <clone> --backend <folder with app/ web/ deck/ supabase/> \
       --config prod.json --preview-config preview/config.json --deck-sql /tmp/deck.sql
   ```
   This copies the new app files into `www/` and the build scripts and `supabase/` into the repo. It writes `deploy_config.json` (public values only) and runs `build_deploy.py`, which:
   - fills in `online.js`
   - adds the new files and push handlers to `sw.js`
   - keeps `CNAME`
   - publishes `docs/art/<key>.jpg` with **new** keys in the repo's own `card_keys.json`

   It stops if anything looks wrong, for example the preview database, a placeholder key, or preview files in `docs/`.
4. **Load the deck:** paste `deck.sql` into the production SQL editor, or run `sync_deck.py www/artline.json --push` with the service key set on your computer only. Use the `card_keys.json` from this same build, or the images and the database won't match.

## 5. Pull request (Claude prepares, you merge)

1. **Commit:** commit on `ship-online`: `www/` files, `docs/`, `card_keys.json`, `deploy_config.json`, the build scripts and `supabase/`.
2. **Open the PR:** open a pull request on `nambatu/circart` with a plain-English summary.
3. **Merge:** you merge it. GitHub Pages redeploys in about a minute.

## 6. Phone smoke test (you, about 10 minutes)

Open circart.langschwerts.de and pull to refresh twice so the new version loads.

- [ ] **Solo game:** the home screen shows Play · Ranks · Gallery · Profile, and a solo game starts and finishes.
- [ ] **Sign in:** Profile → sign in with an email link. The link opens circart.langschwerts.de, not the preview.
- [ ] **Saved game:** after a solo game, Ranks shows your stats.
- [ ] **Daily challenge:** it plays, and the images load.
- [ ] **Live game:** start one with a friend or a private tab, and the invite link works.
- [ ] **Async game:** start one. "Your turn" notifications arrive once you allow them.
- [ ] **Feedback:** Profile → Send feedback, and the report appears in the production `feedback` table.
- [ ] **Installed app:** the home-screen app still opens and works offline for solo play.

## 7. If something is wrong: roll back

- **Website:** on GitHub, open the merged PR and click **Revert**, then merge the revert. The old game is back within minutes, and solo play never needed the database.
- **Database:** nothing to undo. Every change is additive and the old game doesn't use it. Fix forward with a new migration (`008_…`) and ship again.
- **Notifications:** to pause them, run `select cron.unschedule('circart-push');`.
