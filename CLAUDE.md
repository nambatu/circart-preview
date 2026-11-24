# CIRCArt — instructions for Claude

**Read `AGENTS.md` first: all project rules, the repo map and the workflow are there and apply to you.** This file only adds what is specific to Claude.

@AGENTS.md

## Usage limits
Admin is on **Claude Pro**: a 5-hour limit plus a weekly limit that resets **Thursday 18:00** (Vienna time). There are no extra credits, so a session that hits the limit just stops in the middle. Claude Code sessions, the two scheduled tasks and other work all share this one allowance. Admin also uses Gemini for faster development (see `GEMINI.md`).
- One focused task per session; say the size before anything big. Thursday afternoon, just before the reset, is the time for bigger sessions.
- Never redo finished work. Read only the files a task needs. Don't run the full test suite more often than necessary (it takes a few minutes).
- **Subagents:** only when Admin asks. Four parallel reviewers on a strong model emptied the 5-hour limit within minutes (13 Nov). If Admin wants them: use a cheaper model (Sonnet) for reading and implementing from an exact spec, let them save findings to a file as they go, run at most two at a time, and review their work yourself before deploying.

## Scheduled tasks (they run on their own in the cloud)
- **"CIRCArt story daily"**, every evening at 17:52 Vienna time: builds approved story dailies for the next 1–2 days, writes one new draft and sends Admin a short report. It follows `src/dailies/SKILL.md` and pushes to this repo. Work sessions leave story work (`D…` items, `src/dailies/`) to it unless Admin asks otherwise.
- **"CIRCArt evening build"** — **switched off (19 Nov 2026, Admin)**; the work sessions do the to-do list. When on: every day at 16:41 Vienna time: one roadmap task per day (up to three on Thursdays), tested and deployed to the preview, then a short report. It runs in the "CircART" cloud environment, which has this repo attached, pushes to `main` and has the Supabase connector for feedback. It must respect task claims by other agents (`🔧` marks in the roadmap, see AGENTS.md).
- Both run in the cloud; Admin's PC doesn't need to be on.

## Supabase connector
- Preview project id `rzptvdlejmdeaanhbbtd`. Schema changes go through migration files + the `preview-db` Action, not through ad-hoc SQL.
- SQL queries on the connector run without a permission prompt (`.claude/settings.json`). Use them to read. Never run UPDATE, DELETE, INSERT into existing tables' data or TRUNCATE without Admin's explicit yes first (AGENTS.md rule 10); new tables and columns go through migration files and need no permission.
- With the connector you may read data (e.g. `feedback_inbox()`), check logs and advisors, and deploy the `send-push` Edge Function (verify_jwt false). Use `apply_migration` only as a fallback when Actions are down, and then record it: `insert into public._preview_migrations (name) values ('<file>.sql')`.
- Email templates and other Auth settings can't be changed with the connector (and rule 5 forbids it anyway): give Admin the files in `src/email/`.
