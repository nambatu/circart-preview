#!/usr/bin/env python3
"""CIRCArt — check a story daily before it goes live.

Usage:
  python3 tools/check_story.py dailies/<date>-<slug>.json [--art <preview>/pack-art] [--sheet out.jpg]

Checks (exit code 1 if any ERROR):
  * structure: theme fields EN + DE, start card + 3..30 cards, every field the build needs
  * the game mechanic: years are not in order (max 2 rising in a row), no two cards share a year
  * no spoilers: chapters and trivia must never compare a card with others ("the oldest",
    "newer than", "centuries later", …) — a chapter is shown after card N and must not
    tell the player anything about the date of card N+1 or any later card
  * no year of another card appears in a card's chapter / trivia
  * sources + photo credit on every card
  * with --art: every image is downloaded; with --sheet: a numbered contact sheet
    (title + year under each picture) to look at, card by card, against the commons page
"""
import json, re, sys, os, argparse

LEAK = re.compile(
    r"\b(old(er|est)|new(er|est)|young(er|est)|earli(er|est)|lat(er|est)|first of|last of|"
    r"before (it|this|that|them)|after (it|this|that|them)|centuries (later|earlier|before|after)|"
    r"years? (later|earlier|before|after|older|younger)|most recent|ancient)\b"
    r"|ältest|älter|jüngst|jünger|neuest|neuer als|früher als|später als|Jahrhunderte (später|früher)|zuletzt",
    re.I)
REQ_THEME = ["date", "slug", "title", "title_de", "intro", "intro_de", "outro", "outro_de"]
REQ_CARD = ["title", "artist", "year", "trivia", "trivia_de", "image_source", "image_source_fallback",
            "commons_page", "sources", "credit", "visual_type"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--art", help="folder with downloaded images (<preview>/pack-art)")
    ap.add_argument("--keys", help="pack_images.json of the preview (maps image URLs to keys)")
    ap.add_argument("--sheet", help="write a contact sheet jpg")
    a = ap.parse_args()
    d = json.load(open(a.file, encoding="utf-8"))
    th, cards = d.get("theme", {}), d.get("cards", [])
    errors, warns = [], []

    for k in REQ_THEME:
        if not th.get(k): errors.append(f"theme.{k} missing")
    if not 4 <= len(cards) <= 31: errors.append(f"{len(cards)} cards: need a start card + 3..30")
    for i, c in enumerate(cards):
        for k in REQ_CARD:
            if not c.get(k): errors.append(f"card {i} ({c.get('title')}): {k} missing")
        if i > 0 and (not c.get("chapter") or not c.get("chapter_de")):
            errors.append(f"card {i} ({c.get('title')}): chapter / chapter_de missing")

    ys = [c.get("year") for c in cards]
    run = best = 1
    for x, y in zip(ys, ys[1:]):
        run = run + 1 if y > x else 1
        best = max(best, run)
    if best > 2: errors.append(f"years rise {best} times in a row {ys}: the order must not be chronological")
    if len(set(ys)) != len(ys): warns.append(f"two cards share a year {ys}: placing them is a coin toss")

    for i, c in enumerate(cards):
        for k in ("chapter", "chapter_de", "trivia", "trivia_de"):
            t = c.get(k) or ""
            # names like "the Younger" / "der Jüngere" / "the Elder" are not date comparisons
            t_ = re.sub(r"\b(the (Younger|Elder)|der (Jüngere|Ältere)|d\. ?(J|Ä)\.)", "", t)
            m = LEAK.search(t_)
            if m:
                # chapters lead to the NEXT card → a comparison there is a spoiler (error);
                # trivia is about the card just placed → only a warning to double-check
                (errors if k.startswith("chapter") else warns).append(
                    f"card {i} {k}: compares dates ('{m.group(0)}'): {t[:110]}")
            for j, o in enumerate(cards):
                if j != i and str(o.get("year")) in t:
                    (errors if j > i else warns).append(
                        f"card {i} {k} mentions {o['year']} (the year of card {j}): {t[:110]}")
    for k in ("intro", "intro_de"):
        m = LEAK.search(th.get(k) or "")
        if m: warns.append(f"theme.{k} compares dates ('{m.group(0)}') — check it gives nothing away")
        for j, o in enumerate(cards):
            if j > 0 and str(o.get("year")) in (th.get(k) or ""):
                errors.append(f"theme.{k} mentions {o['year']} (card {j})")

    if a.art and a.keys:
        imgs = json.load(open(a.keys))
        bysrc = {u: i["key"] for i in imgs for u in i["urls"]}
        missing = []
        for i, c in enumerate(cards):
            key = bysrc.get(c.get("image_source")) or bysrc.get(c.get("image_source_fallback"))
            c["_img"] = key and os.path.join(a.art, key + ".jpg")
            if not c["_img"] or not os.path.exists(c["_img"]): missing.append(f"{i} {c['title']}")
        if missing: errors.append("images not downloaded: " + "; ".join(missing))
        if a.sheet:
            from PIL import Image, ImageDraw
            W, H = 300, 330
            sheet = Image.new("RGB", (5 * W, ((len(cards) + 4) // 5) * H), "white")
            dr = ImageDraw.Draw(sheet)
            for i, c in enumerate(cards):
                x, y = (i % 5) * W, (i // 5) * H
                if c.get("_img") and os.path.exists(c["_img"]):
                    im = Image.open(c["_img"]).convert("RGB"); im.thumbnail((W - 10, H - 50))
                    sheet.paste(im, (x + 5, y + 5))
                dr.text((x + 5, y + H - 42), f"{i}. {c['year']} · {c['artist'][:30]}", fill="black")
                dr.text((x + 5, y + H - 26), c["title"][:44], fill="black")
            sheet.save(a.sheet, quality=85)
            print("contact sheet:", a.sheet)

    for w in warns: print("WARN ", w)
    for e in errors: print("ERROR", e)
    print(f"{len(cards) - 1} cards to place · years {ys} · {len(errors)} errors · {len(warns)} warnings")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
