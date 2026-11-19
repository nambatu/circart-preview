# CIRCArt — instructions for Gemini

**Read `AGENTS.md` first: all project rules, the repo map and the workflow are there and apply to you.** This file only adds what is specific to Gemini.

@./AGENTS.md

- **Claim every task in `notes/roadmap.md` before you start** (`🔧 Gemini <date>` at the start of the task line, commit + push right away). Claude's story-daily task (17:52 Vienna) and Claude work sessions push to the same `main` branch; `git pull --rebase` before every push.
- **Leave story dailies alone** (`D…` items, `src/dailies/`, `supabase/dailies.sql`, story images): they belong to Claude's story-daily task.
- **No database access needed.** New migrations reach the preview database through the `preview-db` GitHub Action when you deploy. You can't read player feedback (it needs the Supabase connection Claude has) — skip feedback tasks or leave them to Claude.
- **Edge Function changes** (`src/supabase/functions/send-push/`) can't be deployed through Git. If you change it, note "send-push needs deploying" in the roadmap Run log so Claude or Admin deploys it.
- Before finishing: `src/tools/test_all.sh` must end with `ALL GREEN`, the preview must be deployed with `src/tools/deploy_preview.sh`, and the roadmap must be updated (tick, Done entry, Run log line).
- Write Admin a short plain-language summary (3–5 lines) of what changed and what to try on Admin's phone.
