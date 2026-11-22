# How to write a story daily (Admin, 22 Nov 2026)

`SKILL.md` says how a story is built. This file says how it should read. Admin wasn't happy with the earlier stories: each chapter was a list of facts followed by "The next picture shows…". This is the new way, and it applies to every story from now on.

## The voice: a nature documentary
Write like the narrator of a good nature documentary. The narrator is calm and curious, looks closely, explains what is going on, and never pretends to have been there.
- **Present tense.** "Vincent sits at a café table." Present tense also keeps "then", "later" and "in the end" out of the text, so the order stays secret.
- **Start with what the player can see**, then explain it. "A rider stands on a galloping horse. The ringmaster cracks his whip." Then the story behind it.
- **Facts only.** No invented narrator ("I knew him"), no invented scenes, no guessing at feelings. Every fact needs a source as usual. Quotes only if a source gives them, and then with "is said to have said" if the source isn't sure.
- **Trustworthy before clever.** It is fine to be warm and to marvel at something, but never at the cost of accuracy.
- Sentences may be long or short, whatever the moment needs. There is no word count. Read it as a player would and ask whether it flows.

## Chapters look back, never forward
Every new story sets `"look_back": true` in the theme.
- **A chapter talks only about the card the player has just placed.** It never leads into the next card. "The next picture…", "Our next…" and "Im nächsten Bild…" are gone (`check_story.py` stops them).
- So a chapter can't give away the order of later cards. Still avoid words that place this card in a life or an era relative to the others ("his first", "as a young man", "his last", "late in life"). The player hasn't placed the other cards yet, and those words solve the puzzle for them.
- **The start card has its own chapter too** (card 0). It shows on the start screen under the intro.
- Pick the one or two most interesting things about the card. What is happening in the picture, why it matters, a surprising turn. Leave mundane facts (sizes, materials, which room it hangs in) to the trivia, and don't repeat the trivia.

## The story comes together at the end
On the results screen the game shows every card oldest first, each with its chapter, under "The whole story, in order". **Write the chapters so that, read in year order, they tell one story.** During the game the player collects pieces. At the end the pieces click together.
- Check it: sort the cards by year and read the chapters from top to bottom. Does it flow like one story? Does each chapter make sense on its own as well?
- **The intro** sets the scene and the question in two or three sentences: where we are, whose story it is, what connects the works. It never names a card's year.
- **The outro** closes the story in two or three sentences. It comes after the recap, so it may look back over the whole thing. No life advice and no "Happy X Day".

## Example (Toulouse-Lautrec, start card + 2 chapters)
Start card, Moulin Rouge – La Goulue (poster):
> EN: A dancer in mid-kick fills the poster, and a dark figure stands in front of her. This sheet goes up on walls across Paris, and La Goulue becomes the most famous face of the Moulin Rouge.
> DE: Eine Tänzerin wirft das Bein in die Luft, vor ihr steht eine dunkle Gestalt. Dieses Plakat hängt bald an den Mauern von ganz Paris, und La Goulue wird zum bekanntesten Gesicht des Moulin Rouge.

Equestrienne (At the Cirque Fernando):
> EN: A rider balances on a galloping horse while the ringmaster cracks his whip. Henri loves the circus as much as the dance halls. Joseph Oller, who owns the Moulin Rouge, buys this picture and hangs it in his dance hall.
> DE: Eine Reiterin hält sich auf einem galoppierenden Pferd, der Zirkusdirektor lässt die Peitsche knallen. Henri liebt den Zirkus genauso wie die Tanzsäle. Joseph Oller, dem das Moulin Rouge gehört, kauft das Bild und hängt es in seinem Tanzsaal auf.

## Before you send a draft
- Read every chapter on its own: does it only talk about its own card?
- Read them again in year order: is it one story?
- Read intro, chapters and outro in EN and DE as a player who doesn't know the years: does any word give away an order?
- The roadmap's writing rules still apply: no comma lists of three or more, at most one art pun per screen, natural German with informal "du".
- Drafts for Admin show the intro, **all** chapters and the outro (not just two samples), so Admin can judge the whole story.
