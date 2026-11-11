# Streak + painting of the week — concept (Julian, 11 Nov)

Julian: "A fire emoji streak like Snapchat for things you come back to every day. Instead of or next to the classic streak, you fill in a picture over several days. A reveal over several days."

## The idea in one sentence
Every day you play the daily, you clean one more part of a hidden **painting of the week**. By Sunday the whole picture is visible, and it goes into your collection. Next to it a 🔥 counter shows how many days in a row you've played.

## Two parts that work together

### 1. The 🔥 streak (classic, simple)
- Counts the days in a row on which you **finished** the daily (Berlin time). The score doesn't matter, so beginners keep their streak too.
- Shown on the home screen next to the daily button ("🔥 12") and on the profile. Friends see it on your profile (33).
- **One free day per week:** if you miss a single day, the streak doesn't break; that day's patch stays dirty. A second missed day in the same week resets the streak to 0. (Snapchat-style pressure without punishing one busy day.)
- Push reminder, opt-in, at 19:00 if you haven't played: "Your 🔥 12 goes out tonight" / "Dein 🔥 12 erlischt heute Nacht". At most one per day.

### 2. The painting of the week (the reveal)
- **Look: a restoration, not a puzzle.** The painting starts under a layer of old, yellowed varnish and dirt. Each day you play, one patch is cleaned and the true colours show through. That fits an art game better than puzzle tiles, and it looks beautiful as an animation (a soft wipe across the patch).
- Monday to Sunday = 7 patches. Everyone gets the same painting each week, so people can talk about it ("Have you worked out Thursday's picture?").
- **Guess early:** from the 3rd patch on you may guess the artist once a day (4 choices, like the artist question). Right on day 3 or 4 → badge "Sharp Eye" / "Scharfes Auge" (task 40). A guess never reveals more.
- **Sunday reveal:** after Sunday's daily the full painting is shown, with its title, year and a short story (EN + DE), and goes into **your collection** (Gallery → "My restorations" / "Meine Restaurierungen"). Missed patches stay faintly dirty in your copy — a gentle reminder, not a penalty.
- **A perfect daily** (every card right) cleans its patch with a little extra shine; purely visual.

## Rules that keep it fair and simple
- Only the **daily** counts (not runs, packs or games with friends), so everyone has the same chance per day.
- You can't clean ahead or catch up: one patch per day, on that day.
- The painting of the week is chosen like a story card: public domain, ≥ 1200 px, checked photo. Never a card that is in the daily that week. Never the same painting twice (daily-history rule).
- **No peeking:** the server only hands out the patches you have earned. The full image must not be reachable before Sunday, so the build cuts each painting into 7 patches with random file names and only publishes the full image after the week. (The repo is public, so a determined person could still find it; there is nothing to win, so that's acceptable.)

## What it needs (for the evening builds)
- **Server (new migration):** `weekly_paintings (week_start, card_id, story, story_de)`, a `streak()` RPC (days in a row, free day used this week, today played?), `my_painting()` (this week's patches I have earned + their URLs, guesses), `guess_painting(choice)` with one guess per day. Computed from `answers` of daily games, so there is nothing new to cheat with. Tests: no patch before it's earned, no full image before Sunday, streak across the free day and across the month change.
- **Build:** cut the painting into 7 patches (pack-images Action, Pillow), random names; the full picture after Sunday.
- **App:** 🔥 on home + profile; the painting card on home under the daily (dirty canvas + cleaned patches, wipe animation after finishing the daily); the Sunday reveal screen; Gallery → My restorations. Screenshots 390×844 light + dark.
- **Push:** the 19:00 reminder via the existing push outbox, opt-in setting.
- **Content:** a list of paintings for the coming weeks; the story-daily task can pick and write them (one per week, with the Sunday story).

## Split (one evening build each)
- **45a** Server: streak + weekly painting + patches + guesses, with tests. 🔥 counter on home and profile.
- **45b** The painting card on home with the cleaning animation, the Sunday reveal, the collection in the Gallery. First painting chosen.
- **45c** Push reminder (opt-in), the "Sharp Eye" guess badge (with 40), polish after Julian has played a week.

## For Julian to decide (before 45a)
1. Painting per **week** (7 patches) as proposed, or per **month** (bigger picture, ~30 patches, slower)?
2. **Restoration** look (varnish being cleaned) as proposed, or classic **puzzle pieces**?
3. **One free day per week** OK, or strict like Snapchat (miss a day → 0)?
