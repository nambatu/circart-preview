"""Corrections to the base deck (artline.json comes from the game repo, which we never edit).
build_preview.py applies them to the copy in docs/. For the real game, apply the same
function when staging (see notes/roadmap.md, task 37).

STYLE_NONE: cards whose style could not be confirmed by two sources (Wikidata P135 +
Wikipedia, checked 10 Nov 2026, see movement-review.md). They get no style: the info page
shows no style and no style question is offered."""

STYLE_NONE = [
    "1728-jean-simeon-chardin-the-ray",
    "1768-joseph-wright-of-derby-an-experiment-on-a-bird-in-the-a",
    "1917-amedeo-modigliani-reclining-nude",
    "1922-paul-klee-senecio",
    "1964-fernando-botero-pope-leo-x-after-raphael",
    "1944-francis-bacon-three-studies-for-figures-at-the",
    "1953-francis-bacon-study-after-velazquez-s-portrait",
    "1735-william-hogarth-a-rakes-progress-viii",
    "1743-william-hogarth-marriage-a-la-mode-ii",
    "1939-frida-kahlo-the-two-fridas",
    "1940-frida-kahlo-self-portrait-with-thorn-necklac",
    "1948-m-c-escher-drawing-hands",
    "1953-m-c-escher-relativity",
    "1930-elias-garcia-martinez-ecce-homo-borja",
    # artists N-Z (37b, 13 Nov 2026, see movement-review-nz.md)
    "1871-james-mcneill-whistler-arrangement-in-grey-and-black-no",
    "1884-john-singer-sargent-portrait-of-madame-x",
    "1948-andrew-wyeth-christina-s-world",
]

# Wrong or unclear descriptions reported by players and checked (20 Nov 2026).
# "This Is Fine": the card image shows the whole six-panel strip, the old text talked about two panels.
TRIVIA_FIX = {
    "2013-kc-green-this-is-fine": (
        "The strip has six panels: a dog in a hat sits in a burning room with a coffee cup and says "
        "everything is fine. The meme usually shows only the first two, and what it cuts off is the rest "
        "of the strip, in which the dog's face melts and it dies. Green has been openly uneasy about the "
        "crop, partly because the ending is the point and partly because the image gets used by exactly "
        "the institutions it satirises, including a US political party account during the 2016 election, "
        "which prompted him to say publicly that they should stop. He later drew a sequel in which the dog "
        "gets up and puts the fire out. Nobody shares that one."),
}

def apply(cards, fix_text=lambda s: s):
    """Returns how many cards were changed. Also repairs broken characters in names (AbramoviÄ‡)."""
    n = 0
    for c in cards:
        if c.get("id") in STYLE_NONE and c.get("movement"):
            c["movement"] = None
            n += 1
        if c.get("id") in TRIVIA_FIX:
            c["trivia"] = TRIVIA_FIX[c["id"]]
        for f in ("artist", "title"):
            if isinstance(c.get(f), str):
                c[f] = fix_text(c[f])
    return n
