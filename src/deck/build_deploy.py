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

Online settings: online.js needs the production Supabase project's URL and
anon key (and the public VAPID key for notifications). They are read from
deploy_config.json next to this script, or from the environment variables
CIRCART_SUPABASE_URL, CIRCART_SUPABASE_ANON_KEY, CIRCART_VAPID_PUBLIC_KEY
(these win). All three values are public by design, so deploy_config.json
may be committed:

    { "supabase_url": "https://xxxx.supabase.co",
      "anon_key": "eyJ...",
      "vapid_public": "BP..." }

If www/images is not on this computer (it is not in git), the images already
in docs/images are reused as they are.
"""

import json
import os
import re
import shutil
import sys
import tempfile
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
    # app shell + online features
    "strings.js",
    "shell.css",
    "shell.js",
    "game.js",
    "online.js",
    # added 2026-11-05 (copied when present in www/)
    "strings-de.js",
    "solo.js",
    "solo.css",
    "solo-i18n.js",
    "solo-i18n.css",
    "onboarding.js",
    "onboarding.css",
    # added 2026-11-06: card packs + privacy policy pages
    "packs.js",
    "privacy-en.html",
    "privacy-de.html",
]

# Copied wholesale (app icons).
STATIC_DIRS = ["icons", "vendor", "packs"]   # vendor: self-hosted fonts + libraries; packs: card pack json

# Added to the service worker's offline list (if present in docs/).
SW_EXTRA_ASSETS = ["strings.js", "shell.css", "shell.js", "game.js", "online.js"] + ['strings-de.js', 'solo.js', 'solo.css', 'solo-i18n.js', 'solo-i18n.css', 'onboarding.js', 'onboarding.css', 'packs.js', 'vendor/fonts.css', 'vendor/supabase.js', 'vendor/lottie-player.js']
# Push-notification handlers, appended to docs/sw.js (not published on its own).
SW_PUSH = "sw-push.js"
CONFIG_FILE = ROOT / "deploy_config.json"
PLACEHOLDERS = ("", "https://YOUR-PROJECT.supabase.co", "YOUR-ANON-KEY")


def online_config():
    """URL / anon key / VAPID key for online.js: deploy_config.json, then env vars."""
    cfg = {}
    if CONFIG_FILE.exists():
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    for key, env in (("supabase_url", "CIRCART_SUPABASE_URL"),
                     ("anon_key", "CIRCART_SUPABASE_ANON_KEY"),
                     ("vapid_public", "CIRCART_VAPID_PUBLIC_KEY")):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    url, anon = cfg.get("supabase_url", "").rstrip("/"), cfg.get("anon_key", "")
    if url in PLACEHOLDERS or anon in PLACEHOLDERS:
        sys.exit(f"online.js needs the Supabase URL and anon key. Put them in {CONFIG_FILE.name}\n"
                 f"or set CIRCART_SUPABASE_URL and CIRCART_SUPABASE_ANON_KEY (see the top of this file).")
    if not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.co", url):
        sys.exit(f"supabase_url looks wrong: {url!r} (expected https://xxxx.supabase.co)")
    for k in ("anon_key", "vapid_public"):
        if not re.fullmatch(r"[A-Za-z0-9._-]*", cfg.get(k, "")):
            sys.exit(f"{k} contains unexpected characters")
    return {"SUPABASE_URL": url, "SUPABASE_ANON_KEY": anon,
            "VAPID_PUBLIC_KEY": cfg.get("vapid_public", "")}


def fill_online_js(path, cfg):
    text = path.read_text(encoding="utf-8")
    for const, value in cfg.items():
        text, n = re.subn(rf"const {const} = '[^']*';", f"const {const} = '{value}';", text, count=1)
        if not n:
            sys.exit(f"could not find  const {const} = '...';  in online.js")
    path.write_text(text, encoding="utf-8")


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def main():
    if not SRC.is_dir():
        sys.exit(f"Could not find {SRC}. Run this from the artline-cma folder.")

    # Check the online settings before anything is deleted.
    cfg = online_config() if (SRC / "online.js").exists() else None

    # www/images is not in git. Without it, keep the already-resized images.
    reuse = None
    if not (SRC / "images").is_dir() and (DST / "images").is_dir():
        reuse = Path(tempfile.mkdtemp(prefix="circart-images-")) / "images"
        shutil.copytree(DST / "images", reuse)

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
            print(f"  ! missing directory: {d}" + ("  ← the app can't start without it" if d == "vendor" else ""))

    if cfg:
        fill_online_js(DST / "online.js", cfg)
        print(f"  + online.js -> {cfg['SUPABASE_URL']}"
              f" (notifications {'on' if cfg['VAPID_PUBLIC_KEY'] else 'off'})")

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
        # the new app files work offline too
        extra = "".join(f"\n    './{f}'," for f in SW_EXTRA_ASSETS
                        if (DST / f).exists() and f"'./{f}'" not in text)
        text = text.replace("const SHELL_ASSETS = [", "const SHELL_ASSETS = [" + extra, 1)
        # push notifications + notification taps
        push = SRC / SW_PUSH
        if push.exists() and "addEventListener('push'" not in text:
            text += push.read_text(encoding="utf-8")
        sw.write_text(text, encoding="utf-8")
        print(f"  + sw.js cache version -> {stamp}"
              + (" (+ push handlers)" if "addEventListener('push'" in text else ""))

    # 2. resize the images
    if reuse:
        for path in sorted(reuse.glob("*")):
            shutil.copy2(path, DST / "images" / path.name)
        shutil.rmtree(reuse.parent)
        print(f"\nNo {SRC / 'images'} here: reused {len(list((DST / 'images').glob('*')))} "
              f"images from the previous docs/images.")
    src_images = sorted((SRC / "images").glob("*")) if (SRC / "images").is_dir() else []
    if not reuse:
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
    if src_images:
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
