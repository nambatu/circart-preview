#!/usr/bin/env python3
"""
CIRCArt -- build an upload-ready web version.

Run this from the artline-cma project folder:

    pip install pillow
    python build_deploy.py

It creates a folder called "docs" next to this script containing everything
that needs to go onto the web, with the artwork images resized down to a
sensible size for the web. Nothing in www/ is modified.

"docs" is the folder GitHub Pages publishes from (repo Settings -> Pages ->
Source: main branch, /docs folder), so committing it is all that is needed to
update the live game.

Online modes: every image is also published a second time under a year-free
name, docs/art/<key>.jpg, using the keys in card_keys.json (created on
first run, see card_keys.py). The multiplayer and daily-challenge screens load
these, so the file name never gives the answer away. Run sync_deck.py after
this so the database points at the same keys.
"""

import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is not installed. Run:  pip install pillow")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from card_keys import load_keys, image_name  # noqa: E402

# --- settings ---------------------------------------------------------------
MAX_EDGE = 1600      # longest side, in pixels
QUALITY = 82         # JPEG quality (82 is visually lossless for photos)
# GitHub Pages serves the site at this hostname. The CNAME file is what makes
# the custom domain survive a rebuild, and this script recreates docs/ from
# scratch each run, so the file has to be written here rather than committed by
# hand. Set to None if you ever go back to a plain github.io URL.
CUSTOM_DOMAIN = "circart.langschwerts.de"
# ----------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "www"
DST = ROOT / "docs"

STATIC_FILES = [
    "index.html",
    "app.js",
    "pwa.js",
    "style.css",
    "artline.json",
    "Abstract Painting Loader.json",
    "manifest.webmanifest",
    "sw.js",
]

# Copied wholesale (app icons).
STATIC_DIRS = ["icons"]


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def main():
    if not SRC.is_dir():
        sys.exit(f"Could not find {SRC}. Run this from the artline-cma folder.")

    if DST.exists():
        shutil.rmtree(DST)
    (DST / "images").mkdir(parents=True)
    (DST / "art").mkdir()

    # 1. copy the static files
    print("Copying static files...")
    for name in STATIC_FILES:
        src = SRC / name
        if src.exists():
            shutil.copy2(src, DST / name)
            print(f"  + {name}")
        else:
            print(f"  ! missing: {name}")

    for d in STATIC_DIRS:
        src_dir = SRC / d
        if src_dir.is_dir():
            shutil.copytree(src_dir, DST / d)
            n = len(list((DST / d).glob("*")))
            print(f"  + {d}/ ({n} files)")
        else:
            print(f"  ! missing directory: {d}")

    if CUSTOM_DOMAIN:
        (DST / "CNAME").write_text(CUSTOM_DOMAIN + "\n", encoding="utf-8")
        print(f"  + CNAME ({CUSTOM_DOMAIN})")

    # A service worker only replaces its caches when its own bytes change.
    # Stamping the build time in guarantees that, so a returning player is
    # never stuck on a stale copy of the game.
    sw = DST / "sw.js"
    if sw.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        text = sw.read_text(encoding="utf-8")
        text = re.sub(r"const CACHE_VERSION = '[^']*';",
                      f"const CACHE_VERSION = '{stamp}';", text, count=1)
        sw.write_text(text, encoding="utf-8")
        print(f"  + sw.js cache version -> {stamp}")

    # 2. resize the images
    src_images = sorted((SRC / "images").glob("*"))
    print(f"\nProcessing {len(src_images)} images...")

    before = after = 0
    skipped = []

    for i, path in enumerate(src_images, 1):
        if not path.is_file():
            continue
        before += path.stat().st_size
        out = DST / "images" / path.name
        try:
            with Image.open(path) as im:
                im = ImageOps.exif_transpose(im)      # honour rotation
                im = im.convert("RGB")                # drop alpha/CMYK
                im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
                im.save(out, "JPEG", quality=QUALITY,
                        optimize=True, progressive=True)
        except Exception as e:                        # noqa: BLE001
            skipped.append((path.name, str(e)))
            shutil.copy2(path, out)                   # fall back to the original
        after += out.stat().st_size

        if i % 25 == 0 or i == len(src_images):
            print(f"  {i}/{len(src_images)}")

    # 3. sanity check + year-free copies for the online modes
    print("\nChecking artline.json against the image folder...")
    missing = []
    published = 0
    try:
        cards = json.loads((SRC / "artline.json").read_text(encoding="utf-8"))
        cards = [c for c in cards if c.get("id")]
        keys, added, key_file = load_keys(cards)
        for c in cards:
            name = image_name(c)
            if not name:
                continue
            web = DST / "images" / name
            if not web.exists():
                missing.append((c.get("id"), name))
                continue
            shutil.copy2(web, DST / "art" / f"{keys[c['id']]}.jpg")
            published += 1
        print(f"  + art/ ({published} year-free copies, {added} new keys in {key_file.name})")
    except Exception as e:                            # noqa: BLE001
        print(f"  could not read artline.json: {e}")

    # 4. report
    print("\n" + "=" * 58)
    print(f"  images before : {human(before)}")
    print(f"  images after  : {human(after)}")
    if before:
        print(f"  saved         : {(1 - after / before) * 100:.0f}%")
    print(f"\n  ready to upload: {DST}")
    print("=" * 58)

    if skipped:
        print(f"\n{len(skipped)} image(s) could not be resized "
              f"(originals copied instead):")
        for name, err in skipped[:10]:
            print(f"  - {name}: {err}")

    if missing:
        print(f"\nWARNING: {len(missing)} card(s) reference a missing image:")
        for cid, name in missing[:10]:
            print(f"  - {cid} -> {name}")
    else:
        print("\nAll cards have their image. Good to go.")


if __name__ == "__main__":
    main()
