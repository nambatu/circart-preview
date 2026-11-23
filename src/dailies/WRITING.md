# How to write a story daily (Admin, 22 Nov 2026)

`SKILL.md` says how a story is built. This file says how it should read. Admin wasn't happy with the earlier stories: each chapter was a list of facts followed by "The next picture shows…". This is the new way, and it applies to every story from now on.

## The voice: museum guide + detective (Admin, 23 Nov)
Write like a good museum guide who treats every picture as a little case to solve. The guide stands next to the player, points at things in the picture and explains what they mean. Some of those things are clues: they help the player understand the work, and on hard days they may hint at where it belongs.
- **Point first, then explain.** Start with something the player can see right now: "Start with the black shape in front." "Look at the glass on the table." Then say what it is and why it matters.
- **Name the clues.** A colour, a costume, a signature, a style, an object, the way something is drawn. "Remember that bold, flat look." The player should look at the picture again after reading.
- **Present tense**, which also keeps "then", "later" and "in the end" out of the text.
- **Facts only.** No invented narrator, no invented scenes, no guessing at feelings. Every fact needs a source. A clue must be visible in the photo the players see (check it on the contact sheet). Quotes only if a source gives them.
- **Talk to the player** with "you" ("du" in German), the way a guide talks to a visitor. Warm, curious, never lecturing.
- Sentences may be long or short, whatever the moment needs. There is no word count. Read it as a player would and ask whether it flows.

(22 Nov the voice was a nature documentary narrator. Admin compared six styles on 23 Nov and chose this mix.)

## Chapters look back, never forward
Every new story sets `"look_back": true` in the theme.
- **A chapter talks only about the card the player has just placed.** It never leads into the next card. "The next picture…", "Our next…" and "Im nächsten Bild…" are gone (`check_story.py` stops them).
- So a chapter can't give away the order of later cards. On normal days, avoid words that place this card in a life or an era ("his first", "as a young man", "his last", "late in life").
- **Hard days may give gentle hints (Admin, 22 Nov).** When the years sit close together (one artist's life, one decade), a chapter may hint at where its card sits in a life: "as a student", "in the clinic", "by now he is famous". Players who read get a slight advantage, and that's fair. Hints stay gentle: never the year of another card, and never a ranking like "the oldest picture today".
- **The start card has its own chapter too** (card 0). It shows on the start screen under the intro.
- Pick the one or two most interesting things about the card. What is happening in the picture, why it matters, a surprising turn. Leave mundane facts (sizes, materials, which room it hangs in) to the trivia, and don't repeat the trivia.

## The story comes together at the end
On the results screen the game shows every card oldest first, each with its chapter, under "The whole story, in order". **Write the chapters so that, read in year order, they tell one story.** During the game the player collects pieces. At the end the pieces click together.
- Check it: sort the cards by year and read the chapters from top to bottom. Does it flow like one story? Does each chapter make sense on its own as well?
- **The intro** sets the scene and the question in two or three sentences: where we are, whose story it is, what connects the works. It never names a card's year.
- **The outro** closes the story in two or three sentences. It comes after the recap, so it may look back over the whole thing. No life advice and no "Happy X Day".

## Example
See the finished Lautrec story (`2026-11-24-lautrec.json`): every chapter there is written in this voice.

## Before you send a draft
- Read every chapter on its own: does it only talk about its own card?
- Read them again in year order: is it one story?
- Read intro, chapters and outro in EN and DE as a player who doesn't know the years: does any word give away an order?
- The roadmap's writing rules still apply: no comma lists of three or more, at most one art pun per screen, natural German with informal "du".
- Drafts for Admin show the intro, **all** chapters and the outro (not just two samples), so Admin can judge the whole story.
