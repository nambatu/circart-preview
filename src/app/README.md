# CIRCArt app shell

Unified app UI in `src/app/` — one game screen (`game.js`) runs Solo, Card Packs, Daily challenges, Monthly Runs, and Live/Async games with friends, alongside `shell.js` (tabs, home, ranks, profile, feedback, zoom, theme).

| File | What it does |
|---|---|
| `index.html` | Tabs (`#start-screen`, `#gallery-screen`, `#ranks-screen`, `#profile-screen`), unified `#game-online-screen`, feedback modal, zoom modal. |
| `shell.js` | Navigation, home cards, ranks, profile, dark/light theme, feedback form (DB + copy/Imprint fallback), zoom gestures, Android back handling. |
| `shell.css` | Tokens for light and dark mode, layout, cards, tab bar, and game screen styling. |
| `game.js` | Game engine UI for Solo (`openSolo`), Card Packs, Daily, Monthly Run, Live, and Async modes. |
| `dealer.js` | Standalone solo & pack card dealer (`Dealer`, `readSeen`, `markSeen`, `artistOptions`, `movementOptions`). |
| `collection.js` | Local + server collection state (`record`, `local`, `merged`) and direct Gallery works grid rendering (`renderGallery`). |
| `packs.js` | Card pack loader (`cards`) and solo pack launcher (`play`). |
| `styles.js` | Art movement groups, look-for descriptions, and Gallery → Styles guide (`CircStyles`). |
| `strings.js`, `strings-de.js` | EN and DE UI strings plus shared `esc` and `de` helpers on `window.CircI18n`. |
| `onboarding.js`, `onboarding.css` | First-visit "How to play" walkthrough. |
| `../web/online.js` | Supabase RPC client, auth, offline solo queue, and Web Push registration. |

## Notes

- **Solo & offline play:** Solo games and unlocked packs run locally in `game.js` + `dealer.js` without requiring network calls; finished solo games are queued via `CircOnline.saveSoloGame` when available.
- **CSP:** No inline `<script>` (beyond the theme bootstrap matched by its SHA-256 hash) or `onclick=` attributes.
- **Testing:** End-to-end checks live in `tests/e2e.mjs` (run via `src/tools/test_all.sh`).
