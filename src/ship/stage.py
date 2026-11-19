#!/usr/bin/env python3
"""
CIRCArt — put the tested preview files into a clone of the REAL game repo and
build docs/ for production. Nothing is committed or pushed; that stays a
pull request Julian merges (see SHIP.md).

    python3 stage.py --game <clone of nambatu/circart on a new branch>
                     --backend <folder with app/ web/ deck/ supabase/>
                     --config prod.json  [--preview-config ../preview/config.json]
                     [--deck-sql <path outside the repo>]

prod.json: { "supabase_url": "https://xxxx.supabase.co", "anon_key": "...",
             "vapid_public": "..." }      (all three are public values)
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

WWW_FROM_APP = ["index.html", "shell.js", "shell.css", "strings.js", "game.js", "sw-push.js",
                "strings-de.js", "solo.js", "dealer.js", "collection.js", "solo.css", "solo-i18n.js", "solo-i18n.css", "onboarding.js", "onboarding.css", "packs.js"]
ROOT_FROM_DECK = ["build_deploy.py", "card_keys.py", "sync_deck.py"]


PREVIEW_SITE = "https://nambatu.github.io/circart-preview"
SITE = "https://circart.langschwerts.de"


def stage_pack_images(repo, docs, cfg, packs_sql):
    """Use the preview's built pack files (image_local = art/<key>.jpg) and copy the photos from pack-art/."""
    built, art = repo / "docs" / "packs", repo / "pack-art"
    if not built.is_dir() or not art.is_dir():
        sys.exit(f"{repo} has no docs/packs or pack-art/")
    (docs / "packs").mkdir(exist_ok=True)
    (docs / "art").mkdir(exist_ok=True)
    copied, missing = 0, []
    for f in sorted(built.glob("*.json")):
        shutil.copy2(f, docs / "packs" / f.name)
        for c in json.loads(f.read_text(encoding="utf-8"))["cards"]:
            name = Path(c["image_local"]).name
            if (art / name).exists():
                shutil.copy2(art / name, docs / "art" / name)
                copied += 1
            else:
                missing.append(name)
    if missing:
        sys.exit(f"pack photos missing in pack-art/: {len(missing)} (e.g. {missing[0]}). Let the pack-images Action finish first.")
    print(f"staged: {copied} pack photos in docs/art/")
    if packs_sql:
        sql = (repo / "supabase" / "packs.sql").read_text(encoding="utf-8").replace(PREVIEW_SITE, SITE)
        Path(packs_sql).write_text(sql, encoding="utf-8")
        print(f"wrote {packs_sql} (run it in the production SQL editor after the deck)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--backend", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--preview-config", help="refuse to ship if prod.json points at the preview database")
    ap.add_argument("--deck-sql", help="also write the deck SQL here (keep it out of the repo)")
    ap.add_argument("--preview-repo", help="clone of circart-preview: its built packs, pack photos (pack-art/) and packs.sql "
                                           "go into the game, so pack images are served from the real site")
    ap.add_argument("--packs-sql", help="where to write packs.sql for the production database (with --preview-repo)")
    a = ap.parse_args()
    game, be = Path(a.game).resolve(), Path(a.backend).resolve()
    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))

    if not (game / "www" / "artline.json").exists():
        sys.exit(f"{game} is not the game repo (no www/artline.json)")
    if a.preview_config:
        prev = json.loads(Path(a.preview_config).read_text(encoding="utf-8"))
        if prev.get("supabase_url", "").rstrip("/") == cfg.get("supabase_url", "").rstrip("/"):
            sys.exit("prod.json points at the PREVIEW database. Use the production project.")

    for f in WWW_FROM_APP:
        if (be / "app" / f).exists():                 # optional files may not exist yet
            shutil.copy2(be / "app" / f, game / "www" / f)
    if (be / "app" / "vendor").is_dir():               # self-hosted fonts + libraries (GDPR)
        shutil.copytree(be / "app" / "vendor", game / "www" / "vendor", dirs_exist_ok=True)
    for f in sorted((be / "legal").glob("privacy-*.html")):   # privacy policy, linked from Profile
        shutil.copy2(f, game / "www" / f.name)
    if (be / "packs").is_dir():                       # card packs (images load from Wikimedia in prod for now)
        (game / "www" / "packs").mkdir(parents=True, exist_ok=True)
        for f in sorted((be / "packs").glob("*.json")):
            shutil.copy2(f, game / "www" / "packs" / f.name)
    shutil.copy2(be / "web" / "online.js", game / "www" / "online.js")   # placeholders; build fills them
    for f in ROOT_FROM_DECK:
        shutil.copy2(be / "deck" / f, game / f)
    for sub in ("migrations", "functions"):
        dst = game / "supabase" / sub
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(be / "supabase" / sub, dst)
    (game / "deploy_config.json").write_text(
        json.dumps({k: cfg.get(k, "") for k in ("supabase_url", "anon_key", "vapid_public")}, indent=2) + "\n",
        encoding="utf-8")
    print("staged: www/ app files, build scripts, supabase/, deploy_config.json")

    subprocess.run([sys.executable, "build_deploy.py"], cwd=game, check=True)
    if a.deck_sql:
        subprocess.run([sys.executable, "sync_deck.py", "www/artline.json", "--sql",
                        str(Path(a.deck_sql).resolve())], cwd=game, check=True)

    docs = game / "docs"
    if a.preview_repo:
        stage_pack_images(Path(a.preview_repo).resolve(), docs, cfg, a.packs_sql)

    # last checks on what will be published
    problems = [f"missing docs/{f}" for f in
                ["CNAME", "index.html", "online.js", "shell.js", "game.js", "sw.js", "strings.js", "shell.css",
                 "packs.js", "vendor/supabase.js", "vendor/fonts.css", "privacy-en.html"]
                if not (docs / f).exists()]
    problems += [f"preview file in docs/: {f}" for f in ["preview.js", "preview.json", "changes.html"]
                 if (docs / f).exists()]
    if (docs / "card_keys.json").exists() or (game / "www" / "card_keys.json").exists():
        problems.append("card_keys.json must not be in docs/ or www/")
    if not list((docs / "art").glob("*.jpg")):
        problems.append("docs/art/ is empty")
    if "YOUR-ANON-KEY" in (docs / "online.js").read_text(encoding="utf-8"):
        problems.append("online.js still has the placeholder key")
    if problems:
        sys.exit("NOT ready:\n  " + "\n  ".join(problems))
    print("\nReady. Review `git status`, commit on the branch and open the pull request.")


if __name__ == "__main__":
    main()
