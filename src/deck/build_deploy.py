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

import argparse
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is not installed. Run:  pip install pillow")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from card_keys import load_keys, image_name  # noqa: E402
try:
    import deck_fixes  # noqa: E402
    import sync_deck   # noqa: E402
except ImportError as e:
    sys.exit(f"Missing required build helper next to build_deploy.py: {e}")

# --- settings ---------------------------------------------------------------
MAX_EDGE = 1600      # longest side, in pixels
QUALITY = 82         # JPEG quality (82 is visually lossless for photos)
# GitHub Pages serves the site at this hostname. The CNAME file is what makes
# the custom domain survive a rebuild, and this script recreates docs/ from
# scratch each run, so the file has to be written here rather than committed by
# hand. Set to None if you ever go back to a plain github.io URL.
CUSTOM_DOMAIN = "YOUR-GAME-DOMAIN"
# ----------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "www"
DST = ROOT / "docs"

def rm_tree(path):
    """Remove all files and subdirectories under path, tolerating locked empty OneDrive stubs."""
    p = str(path)
    if not os.path.exists(p):
        return
    for root, dirs, files in os.walk(p, topdown=False):
        for name in files:
            fp = os.path.join(root, name)
            for attempt in range(5):
                try:
                    os.chmod(fp, stat.S_IWRITE)
                    os.unlink(fp)
                    break
                except FileNotFoundError:
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.2 * (attempt + 1))
        for name in dirs:
            dp = os.path.join(root, name)
            if os.path.islink(dp):
                os.unlink(dp)
                continue
            for attempt in range(3):
                try:
                    os.chmod(dp, stat.S_IWRITE)
                    os.rmdir(dp)
                    break
                except FileNotFoundError:
                    break
                except PermissionError:
                    if attempt < 2:
                        time.sleep(0.2 * (attempt + 1))
                    elif os.listdir(dp):
                        raise
    for attempt in range(3):
        try:
            os.chmod(p, stat.S_IWRITE)
            os.rmdir(p)
            break
        except FileNotFoundError:
            break
        except PermissionError:
            if attempt < 2:
                time.sleep(0.2 * (attempt + 1))
            elif os.listdir(p):
                raise

STATIC_FILES = [
    "index.html",
    "pwa.js",
    "style.css",
    "artline.json",
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
    "dealer.js",
    "collection.js",
    "styles.js",
    "onboarding.js",
    "onboarding.css",
    # added 2026-11-06: card packs + privacy policy pages
    "packs.js",
    "privacy-en.html",
    "privacy-de.html",
    "impressum.html",
]

# Copied wholesale (app icons and self-hosted vendor files; never raw www/packs/).
STATIC_DIRS = ["icons", "vendor"]

# Added to the service worker's offline list (if present in docs/).
SW_EXTRA_ASSETS = [
    "strings.js", "shell.css", "shell.js", "game.js", "online.js",
    "strings-de.js", "dealer.js", "collection.js", "styles.js",
    "onboarding.js", "onboarding.css", "packs.js",
    "privacy-en.html", "privacy-de.html", "impressum.html",
]
# Push-notification handlers, appended to docs/sw.js (not published on its own).
SW_PUSH = "sw-push.js"
CONFIG_FILE = ROOT / "deploy_config.json"
PLACEHOLDERS = ("", "https://YOUR-PROJECT.supabase.co", "YOUR-ANON-KEY", "https://XXXX.supabase.co", "PASTE-ANON-KEY")
PREVIEW_SUPABASE_REF = "rzptvdlejmdeaanhbbtd"
PREVIEW_SITE_MARKERS = ("nambatu.github.io/circart-preview", "circart-preview")


def check_not_preview_config(cfg, preview_config_path):
    """Refuse preview database/keys and refuse unconfigured template config.json."""
    url = cfg.get("SUPABASE_URL", "").rstrip("/")
    if PREVIEW_SUPABASE_REF in url:
        sys.exit(f"Refusing to build production against the PREVIEW database ({PREVIEW_SUPABASE_REF}).")
    if not preview_config_path:
        return
    p = Path(preview_config_path)
    if not p.is_file():
        sys.exit(f"Preview config not found: {p}")
    prev = json.loads(p.read_text(encoding="utf-8"))
    prev_url = (prev.get("supabase_url") or "").rstrip("/")
    if prev.get("ready") is False or "XXXX.supabase.co" in prev_url or prev.get("anon_key") == "PASTE-ANON-KEY":
        sys.exit(f"--preview-config points at an unconfigured template ({p.name}); pass src/preview/preview.json instead.")
    if prev_url and prev_url == url:
        sys.exit("deploy_config points at the PREVIEW database. Use the production project.")
    if prev.get("anon_key") and prev["anon_key"] == cfg.get("SUPABASE_ANON_KEY"):
        sys.exit("deploy_config uses the PREVIEW anon_key.")
    if prev.get("vapid_public") and cfg.get("VAPID_PUBLIC_KEY") and prev["vapid_public"] == cfg["VAPID_PUBLIC_KEY"]:
        sys.exit("deploy_config reuses the PREVIEW VAPID public key.")


def online_config(preview_config_path=None):
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
    out = {"SUPABASE_URL": url, "SUPABASE_ANON_KEY": anon,
           "VAPID_PUBLIC_KEY": cfg.get("vapid_public", "")}
    check_not_preview_config(out, preview_config_path)
    return out


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


def pin_index_csp(index_path, supabase_url):
    """Pin connect-src to the exact Supabase origin and restrict img-src to 'self' data: blob:."""
    host = urlparse(supabase_url).netloc
    if not re.fullmatch(r"[a-z0-9-]+\.supabase\.co", host):
        sys.exit(f"Cannot pin CSP connect-src to invalid Supabase host: {host!r}")
    s = index_path.read_text(encoding="utf-8")
    s = re.sub(r"connect-src\s+[^;\"]+", f"connect-src 'self' https://{host} wss://{host}", s, count=1)
    s = re.sub(r"img-src\s+[^;\"]+", "img-src 'self' data: blob:", s, count=1)
    if "*.supabase.co" in s or f"https://{host} wss://{host}" not in s or "img-src 'self' data: blob:" not in s:
        sys.exit("build_deploy: failed to tighten CSP in docs/index.html")
    index_path.write_text(s, encoding="utf-8")


def copy_built_packs(preview_repo, dst):
    """Copy built year-free packs and their pack-art/<key>.jpg files from preview repo (never raw www/packs/)."""
    built, art = preview_repo / "docs" / "packs", preview_repo / "pack-art"
    if not built.is_dir() or not art.is_dir():
        sys.exit(f"{preview_repo} has no docs/packs or pack-art/")
    (dst / "packs").mkdir(parents=True, exist_ok=True)
    copied, missing = 0, []
    for f in sorted(built.glob("*.json")):
        raw = f.read_text(encoding="utf-8")
        if "upload.wikimedia.org" in raw or "image_source" in raw:
            sys.exit(f"Built pack {f.name} still contains raw Wikimedia/image_source references")
        data = json.loads(raw)
        for c in data.get("cards", []):
            local_rel = c.get("image_local") or ""
            name = Path(local_rel).name
            if not local_rel.startswith("art/") or not name:
                sys.exit(f"Pack {f.name} card {c.get('id')} does not use year-free art/<key>.jpg: {local_rel!r}")
            src_img = art / name
            if src_img.exists():
                shutil.copy2(src_img, dst / "art" / name)
                copied += 1
            else:
                missing.append(name)
        shutil.copy2(f, dst / "packs" / f.name)
    if missing:
        sys.exit(f"pack photos missing in {art}: {len(missing)} (e.g. {missing[0]}). Let pack-images finish first.")
    print(f"  + packs/ + art/ ({copied} year-free pack photos from {preview_repo})")


def rewrite_sw(sw_path, dst):
    """Update sw.js version, precache list (including legal + vendor/*), clean navigate fallback, and strip dead CDN rules."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    text = sw_path.read_text(encoding="utf-8")
    text = re.sub(r"const CACHE_VERSION = '[^']*';", f"const CACHE_VERSION = '{stamp}';", text, count=1)
    text = re.sub(r"[ \t]*const VENDOR_CACHE\s*=[^\n]*\r?\n?", "", text)
    text = re.sub(r"const ALL_CACHES\s*=\s*\[[^\]]*\];", "const ALL_CACHES   = [SHELL_CACHE, IMAGE_CACHE];", text, count=1)
    text = re.sub(r"[ \t]*['\"]\./(?:app\.js|Abstract Painting Loader\.json)['\"],?[ \t]*\r?\n?", "", text)

    vendor_assets = []
    if (dst / "vendor").is_dir():
        vendor_assets = sorted(p.relative_to(dst).as_posix() for p in (dst / "vendor").rglob("*") if p.is_file())
    precache = list(dict.fromkeys(SW_EXTRA_ASSETS + vendor_assets))
    extra = "".join(f"\n    './{f}'," for f in precache if (dst / f).exists() and f"'./{f}'" not in text)
    text = text.replace("const SHELL_ASSETS = [", "const SHELL_ASSETS = [" + extra, 1)

    nav_re = re.compile(r"if\s*\(\s*request\.mode\s*===\s*'navigate'\s*\)\s*\{.*?\n\s*return;\s*\n\s*\}", re.DOTALL)
    nav_repl = """if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(SHELL_CACHE);
            try {
                const fresh = await fetch(request);
                if (fresh && fresh.ok) cache.put(request, fresh.clone());
                return fresh;
            } catch (e) {
                return (await cache.match(request, { ignoreSearch: true })) ||
                       (await cache.match('./index.html')) ||
                       Response.error();
            }
        })());
        return;
    }"""
    if not nav_re.search(text):
        sys.exit("build_deploy: could not find navigate handler in sw.js")
    text = nav_re.sub(nav_repl, text, count=1)

    if "url.pathname.includes('/art/')" not in text:
        text = text.replace("url.pathname.includes('/images/')",
                            "(url.pathname.includes('/images/') || url.pathname.includes('/art/'))")

    text = re.sub(r"\n[ \t]*// Fonts and the Lottie player\..*?// Everything else[^\n]*", "", text, flags=re.DOTALL)
    text = re.sub(r"\n[ \t]*if\s*\([^\n]*fonts[^\n]*\|\|[^\n]*unpkg\.com[^\n]*\)\s*\{[^}]*\}\s*", "\n", text, flags=re.DOTALL)
    if any(dead in text for dead in ("googleapis", "gstatic", "unpkg.com", "VENDOR_CACHE")):
        sys.exit("build_deploy: dead Google Fonts / unpkg / VENDOR_CACHE code still present in sw.js")

    push = SRC / SW_PUSH
    if push.exists() and "addEventListener('push'" not in text:
        text += push.read_text(encoding="utf-8")
    sw_path.write_text(text, encoding="utf-8")
    print(f"  + sw.js cache version -> {stamp}"
          + (" (+ push handlers)" if "addEventListener('push'" in text else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview-config", help="refuse to build if deploy_config matches preview")
    ap.add_argument("--preview-repo", help="clone of circart-preview containing docs/packs and pack-art/")
    ap.add_argument("--site", help="production target site URL (https://...)")
    args = ap.parse_args()

    if not SRC.is_dir():
        sys.exit(f"Could not find {SRC}. Run this from the artline-cma folder.")

    # Refuse raw Wikimedia pack JSONs sitting in www/packs/
    if (SRC / "packs").is_dir():
        raw_packs = [p.name for p in sorted((SRC / "packs").glob("*.json"))
                     if "upload.wikimedia.org" in p.read_text(encoding="utf-8") or "image_source" in p.read_text(encoding="utf-8")]
        if raw_packs:
            sys.exit(f"Raw Wikimedia pack JSONs must not be kept in {SRC / 'packs'}: {', '.join(raw_packs)}")

    # Check the online settings before anything is deleted.
    cfg = online_config(args.preview_config) if (SRC / "online.js").exists() else None
    if cfg is None and args.preview_config:
        check_not_preview_config({}, args.preview_config)

    file_cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
    domain = (os.environ.get("CIRCART_CUSTOM_DOMAIN") or file_cfg.get("custom_domain") or CUSTOM_DOMAIN or "").strip()
    if args.site:
        site = sync_deck.validate_site(args.site)
        if any(m in site.lower() for m in PREVIEW_SITE_MARKERS):
            sys.exit(f"Refusing preview site URL in production build: {site!r}")
        if domain in ("", "YOUR-GAME-DOMAIN") or "OWNER" in domain:
            domain = urlparse(site).netloc
    if not domain or domain == "YOUR-GAME-DOMAIN" or "OWNER" in domain or any(m in domain.lower() for m in PREVIEW_SITE_MARKERS):
        sys.exit(f"Invalid production custom_domain/CNAME: {domain!r} (set custom_domain in deploy_config.json or pass --site)")
    if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", domain):
        sys.exit(f"custom_domain looks wrong: {domain!r}")

    # www/images is not in git. Without it, keep the already-resized images.
    reuse = None
    if not (SRC / "images").is_dir() and (DST / "images").is_dir():
        reuse = Path(tempfile.mkdtemp(prefix="circart-images-")) / "images"
        shutil.copytree(DST / "images", reuse)

    rm_tree(DST)
    (DST / "images").mkdir(parents=True, exist_ok=True)
    (DST / "art").mkdir(exist_ok=True)

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
            shutil.copytree(src_dir, DST / d, dirs_exist_ok=True)
            n = len(list((DST / d).glob("*")))
            print(f"  + {d}/ ({n} files)")
        else:
            print(f"  ! missing directory: {d}" + ("  ← the app can't start without it" if d == "vendor" else ""))

    for stale in (DST / "app.js", DST / "Abstract Painting Loader.json", DST / "vendor" / "lottie-player.js"):
        stale.unlink(missing_ok=True)

    if cfg:
        fill_online_js(DST / "online.js", cfg)
        print(f"  + online.js -> {cfg['SUPABASE_URL']}"
              f" (notifications {'on' if cfg['VAPID_PUBLIC_KEY'] else 'off'})")
        if (DST / "index.html").exists():
            pin_index_csp(DST / "index.html", cfg["SUPABASE_URL"])
            print("  + index.html CSP pinned")

    man = DST / "manifest.webmanifest"
    if man.exists():
        m = json.loads(man.read_text(encoding="utf-8"))
        m["id"] = "./"
        man.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    (DST / "CNAME").write_text(domain + "\n", encoding="utf-8")
    print(f"  + CNAME ({domain})")

    if args.preview_repo:
        copy_built_packs(Path(args.preview_repo).resolve(), DST)

    # A service worker only replaces its caches when its own bytes change.
    # Stamping the build time in guarantees that, so a returning player is
    # never stuck on a stale copy of the game.
    sw = DST / "sw.js"
    if sw.exists():
        rewrite_sw(sw, DST)

    # 2. resize the images
    if reuse:
        for path in sorted(reuse.glob("*")):
            shutil.copy2(path, DST / "images" / path.name)
        rm_tree(reuse.parent)
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

    # 3. apply deck fixes + sanity check + year-free copies for the online modes
    print("\nApplying deck fixes and checking artline.json against the image folder...")
    missing = []
    published = 0
    try:
        all_cards = json.loads((SRC / "artline.json").read_text(encoding="utf-8"))
        fixed = deck_fixes.apply(all_cards, sync_deck.fix_mojibake)
        (DST / "artline.json").write_text(json.dumps(all_cards, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  + deck fixes applied ({fixed} style updates)")
        cards = [c for c in all_cards if c.get("id")]
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
        sys.exit(f"could not process artline.json: {e}")

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
