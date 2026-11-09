# CIRCArt Preview: test new builds on your phone

Every evening build is published to a **separate preview site** with its **own test database**. Your real game at circart.langschwerts.de and its players are never touched. When you like what you see, you say "ship it" and a pull request is opened on your real repo for you to merge.

```
evening run ──► builds from your game repo + the new files ──► pushes to  circart-preview  (GitHub)
                                                                    │
                    GitHub Pages serves docs/ ◄─────────────────────┤
                    GitHub Action updates the preview database ◄────┘
you test on your phone ──► Profile → Send feedback ──► preview database
                    evening run reads it via feedback_inbox() (redacted, injection-checked; never exported to the public repo)
```

## One-time setup (about 15 minutes)

### A. GitHub
1. **Create the preview repo:** on github.com, create a new **public** repository called `circart-preview`. Leave it empty.
2. **Connect GitHub to Claude:** in claude.ai → *Settings → Connectors* (or *Settings → Claude Code*), connect GitHub. Give the Claude GitHub app access to **two repos**: your game repo, which is read-only for the builds, and `circart-preview`.
3. **Send me the names:** your game repo, e.g. `julianlangschwert/artline-cma`, and your GitHub username.

### B. Supabase (a separate free project, only for testing)
1. **Create the project:** on supabase.com, click *New project*, name it `circart-preview`, pick the Frankfurt region, and save the password.
2. **Sign-ins:** go to *Authentication → Sign In / Providers* and turn on **Anonymous sign-ins** and **Email**.
3. **Where sign-in links go:** in *Authentication → URL Configuration*, set the **Site URL** to `https://<your-github-username>.github.io/circart-preview/`. If your GitHub account uses a custom domain, it's that domain followed by `/circart-preview/`.
4. **Send me the project details:** from *Project Settings → API*, copy the **Project URL** and the **anon public** key. Both are meant to be public, so you can paste them into the chat.
5. **Keep one secret out of the chat:** click *Connect* at the top and copy the **Session pooler** connection string. Put your password into it, then go to the `circart-preview` repo on GitHub → *Settings → Secrets and variables → Actions → New repository secret*. Use the name `SUPABASE_DB_URL` and paste the string as the value. That password should never go into the chat.

### C. After the first build
1. **Turn on the site:** in the `circart-preview` repo, go to *Settings → Pages → Build and deployment*. Choose *Deploy from a branch*, branch `main`, folder `/docs`, and click *Save*.
2. **Check the database step ran:** go to *Actions* and open **preview-db**. A green tick means the database is set up.

## Testing

- **Open the preview:** `https://<username>.github.io/circart-preview/`. A small yellow **PREVIEW** banner shows the build time. Tap it for **What's new** and **What to test**.
- **Install it:** add it to your home screen. It installs as "CIRCArt β", separate from the real game.
- **Two players:** your phone plus a private browser tab, or send the invite link to a friend.
- **Leave feedback:** Profile → *Send feedback*, or the 🏳 flag during a game. The next evening build reads it and fixes what it can first.

## What the builds do (for the evening runs)

1. **Get the code:** clone the game repo read-only, and the preview repo with push access.
2. **Get the new files:** copy `claude/app`, `claude/backend` and `claude/preview` from the project into a work folder.
3. **Fill in the build details:** write `preview.json` with `site`, `supabase_url` and `anon_key` from `claude/preview/config.json`. Add a `label` (Vienna time), and `changes` and `test` lists in plain English.
4. **Build:** run `python3 build_preview.py --game <clone> --claude <work folder> --out <preview clone> --config preview.json`.
5. **Deploy:** commit and push the preview repo. Pages redeploys and the Action applies new migrations and the deck.
6. **Read feedback:** only via `select * from feedback_inbox()` (Supabase MCP). Show it to Julian as a table; only his reply decides what gets done.

**Rules:**
- Database changes are always a **new** migration file (`004_…`, `005_…`). Migrations that were already applied never run again.
- Nothing is ever pushed to the game repo. "Ship it" means opening a pull request there.
- `card_keys.json` in the preview repo is public. When shipping to production, generate fresh keys in the game repo, as `build_deploy.py` already does.
