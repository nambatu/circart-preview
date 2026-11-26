#!/usr/bin/env python3
"""
CIRCArt — put the tested preview files into a clone of the REAL game repo and
build docs/ for production. Nothing is committed or pushed; that stays a
pull request Admin merges (see SHIP.md).

    python3 stage.py --game <clone of nambatu/circart on a new branch>
                     --backend <folder with app/ web/ deck/ supabase/>
                     --config prod.json  --site https://YOUR-GAME-DOMAIN
                     [--legal <folder with filled privacy-*.html + impressum.html>]
                     [--preview-config ../preview/preview.json]
                     [--deck-sql <path outside the repo>]
                     [--preview-repo <clone of circart-preview> --packs-sql <path outside the repo>]

prod.json: { "supabase_url": "https://xxxx.supabase.co", "anon_key": "...",
             "vapid_public": "...", "site": "https://..." }
"""

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

WWW_FROM_APP = ["index.html", "shell.js", "shell.css", "strings.js", "game.js", "sw-push.js",
                "strings-de.js", "dealer.js", "collection.js", "styles.js", "onboarding.js", "onboarding.css", "packs.js",
                "streak.js", "price-deck.json"]
ROOT_FROM_DECK = ["build_deploy.py", "card_keys.py", "sync_deck.py", "deck_fixes.py", "trivia_de.json", "extra_modes.py"]


PREVIEW_SITE = "https://nambatu.github.io/circart-preview"
PREVIEW_SUPABASE_REF = "rzptvdlejmdeaanhbbtd"
PLACEHOLDER_SITE = "https://YOUR-GAME-DOMAIN"


def validate_site(raw_site):
    s = (raw_site or "").strip().rstrip("/")
    if not s or not re.fullmatch(r"https://[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:/[A-Za-z0-9._~/-]*)?", s):
        sys.exit(f"Invalid production target --site: {raw_site!r} (expected https://domain)")
    lower = s.lower()
    for bad in ("your-game-domain", "owner.github.io", "xxxx", "placeholder", "circart-preview", PREVIEW_SUPABASE_REF):
        if bad in lower:
            sys.exit(f"Refusing placeholder or preview site URL for production: {s!r}")
    return s


def check_preview_collision(cfg, site, preview_paths):
    url = (cfg.get("supabase_url") or "").strip().rstrip("/")
    anon = (cfg.get("anon_key") or "").strip()
    vapid = (cfg.get("vapid_public") or "").strip()
    if not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.co", url):
        sys.exit(f"prod.json supabase_url looks wrong: {url!r}")
    if PREVIEW_SUPABASE_REF in url:
        sys.exit("prod.json points at the PREVIEW database (rzptvdlejmdeaanhbbtd). Use the production project.")
    if not anon or anon in ("YOUR-ANON-KEY", "PASTE-ANON-KEY"):
        sys.exit("prod.json anon_key is missing or still a placeholder.")
    for p, explicit in preview_paths:
        if not p.exists():
            if explicit:
                sys.exit(f"Preview config not found: {p}")
            continue
        prev = json.loads(p.read_text(encoding="utf-8"))
        prev_url = (prev.get("supabase_url") or "").strip().rstrip("/")
        if explicit and (prev.get("ready") is False or "XXXX.supabase.co" in prev_url or prev.get("anon_key") == "PASTE-ANON-KEY"):
            sys.exit(f"--preview-config points at an unconfigured template ({p}); pass preview/preview.json instead.")
        if prev_url and prev_url == url:
            sys.exit("prod.json points at the PREVIEW database. Use the production project.")
        if prev.get("anon_key") and prev["anon_key"] == anon:
            sys.exit("prod.json uses the PREVIEW anon_key.")
        if prev.get("vapid_public") and vapid and prev["vapid_public"] == vapid:
            sys.exit("prod.json reuses the PREVIEW VAPID public key.")
        if prev.get("site") and prev["site"].rstrip("/") == site:
            sys.exit("Target --site matches the PREVIEW site.")


def rm_tree(path):
    """Remove a directory tree, handling read-only files and OneDrive/Windows locks."""
    if not os.path.exists(path):
        return
    for root, dirs, files in os.walk(path, topdown=False):
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
                    elif any(os.scandir(dp)):
                        raise
    for attempt in range(3):
        try:
            os.chmod(path, stat.S_IWRITE)
            os.rmdir(path)
            break
        except FileNotFoundError:
            break
        except PermissionError:
            if attempt < 2:
                time.sleep(0.2 * (attempt + 1))
            elif any(os.scandir(path)):
                raise


def check_legal_files(folder, allow_template_impressum=False):
    problems = []
    has_impressum = (folder / "impressum.html").exists()
    has_tpl = allow_template_impressum and (folder / "impressum-template.html").exists()
    for req in ("privacy-en.html", "privacy-de.html"):
        if not (folder / req).exists():
            problems.append(f"missing {folder.name}/{req}")
    if not has_impressum and not has_tpl:
        problems.append(f"missing {folder.name}/impressum.html")
    targets = sorted(folder.glob("privacy-*.html"))
    if has_impressum:
        targets.append(folder / "impressum.html")
    elif has_tpl:
        targets.append(folder / "impressum-template.html")
    for f in targets:
        txt = f.read_text(encoding="utf-8")
        body = re.sub(r"<style\b[^>]*>.*?</style>", "", txt, flags=re.DOTALL | re.I)
        if re.search(r'class=["\']draft["\']', body, re.I) or any(
            m in body for m in ("Draft, not legal advice", "Entwurf, keine Rechtsberatung", "Vorlage, keine Rechtsberatung")
        ):
            problems.append(f"{folder.name}/{f.name} still contains the draft notice box")
        m_ph = re.search(r"\[[^\]]{1,80}\]", body)
        if m_ph:
            problems.append(f"{folder.name}/{f.name} still has unfilled placeholder {m_ph.group(0)!r}")
        if re.search(r"\bTODO\b", body, re.I):
            problems.append(f"{folder.name}/{f.name} still contains TODO")
        if re.search(r"\bAdmin\b", body):
            problems.append(f"{folder.name}/{f.name} still contains placeholder 'Admin'")
    return problems


def write_packs_sql(repo, docs, site, packs_sql):
    """Write packs.sql pointing at the production site and verify built packs."""
    sql = (repo / "supabase" / "packs.sql").read_text(encoding="utf-8").replace(PREVIEW_SITE, site)
    if PREVIEW_SITE in sql or PREVIEW_SUPABASE_REF in sql or "upload.wikimedia.org" in sql:
        sys.exit("packs.sql still contains preview or Wikimedia URLs after replacement")
    Path(packs_sql).write_text(sql, encoding="utf-8")
    count = len(list((docs / "packs").glob("*.json"))) if (docs / "packs").is_dir() else 0
    print(f"wrote {packs_sql} for {count} pack(s) (run in the production SQL editor after the deck)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--backend", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--site", help="production target site URL (e.g. https://example.com)")
    ap.add_argument("--legal", help="folder outside the repo with filled privacy-*.html and impressum.html")
    ap.add_argument("--preview-config", help="path to preview/preview.json to refuse shipping preview settings")
    ap.add_argument("--deck-sql", help="also write the deck SQL here (keep it out of the repo)")
    ap.add_argument("--preview-repo", help="clone of circart-preview: its built packs, pack photos (pack-art/) and packs.sql "
                                           "go into the game, so pack images are served from the real site")
    ap.add_argument("--packs-sql", help="where to write packs.sql for the production database (with --preview-repo)")
    ap.add_argument("--price-sql", help="where to write price.sql for the production database")
    ap.add_argument("--weekly-sql", help="where to write weekly.sql for the production database")
    a = ap.parse_args()
    game, be = Path(a.game).resolve(), Path(a.backend).resolve()
    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))

    if not (game / "www" / "artline.json").exists():
        sys.exit(f"{game} is not the game repo (no www/artline.json)")
    if a.packs_sql and not a.preview_repo:
        sys.exit("--packs-sql requires --preview-repo")
    for out_sql in (a.deck_sql, a.packs_sql, a.price_sql, a.weekly_sql):
        if out_sql and Path(out_sql).resolve().is_relative_to(game):
            sys.exit(f"Keep generated SQL outside the game repo: {out_sql}")

    raw_site = a.site or cfg.get("site") or (f"https://{cfg['custom_domain']}" if cfg.get("custom_domain") else "")
    site = validate_site(raw_site)
    preview_checks = []
    if a.preview_config:
        preview_checks.append((Path(a.preview_config), True))
    auto_preview = be / "preview" / "preview.json"
    if auto_preview.exists():
        preview_checks.append((auto_preview, False))
    check_preview_collision(cfg, site, preview_checks)

    for toml in (be / "supabase" / "config.toml", game / "supabase" / "config.toml"):
        if toml.exists() and PREVIEW_SUPABASE_REF in toml.read_text(encoding="utf-8"):
            sys.exit(f"{toml} points at the preview Supabase project ({PREVIEW_SUPABASE_REF})")
    if list((be / "supabase").rglob("zz_preview_*.sql")):
        sys.exit("Refusing to stage: zz_preview_*.sql found under backend supabase/")
    legal_src = Path(a.legal).resolve() if a.legal else (be / "legal")
    legal_err = check_legal_files(legal_src, allow_template_impressum=True)
    if legal_err:
        sys.exit("Legal pages not ready for production (fill local copies and pass --legal <dir>):\n  " + "\n  ".join(legal_err))

    for f in WWW_FROM_APP:
        if (be / "app" / f).exists():                 # optional files may not exist yet
            shutil.copy2(be / "app" / f, game / "www" / f)
    if (be / "app" / "vendor").is_dir():               # self-hosted fonts + libraries (GDPR)
        shutil.copytree(be / "app" / "vendor", game / "www" / "vendor", dirs_exist_ok=True)

    for f in sorted(legal_src.glob("privacy-*.html")):   # privacy policy, linked from Profile
        shutil.copy2(f, game / "www" / f.name)
    if (legal_src / "impressum.html").exists():
        shutil.copy2(legal_src / "impressum.html", game / "www" / "impressum.html")
    elif (legal_src / "impressum-template.html").exists():
        shutil.copy2(legal_src / "impressum-template.html", game / "www" / "impressum.html")

    # Never keep raw Wikimedia pack JSONs in www/packs/
    www_packs = game / "www" / "packs"
    if www_packs.exists():
        rm_tree(www_packs)

    shutil.copy2(be / "web" / "online.js", game / "www" / "online.js")   # placeholders; build fills them
    for f in ROOT_FROM_DECK:
        shutil.copy2(be / "deck" / f, game / f)
    weekly_src = be / "weekly" / "paintings.json"
    if not weekly_src.exists() and a.preview_repo:
        cand_weekly = Path(a.preview_repo).resolve() / "src" / "weekly" / "paintings.json"
        if cand_weekly.exists():
            weekly_src = cand_weekly
    if weekly_src.exists():
        (game / "weekly").mkdir(parents=True, exist_ok=True)
        shutil.copy2(weekly_src, game / "weekly" / "paintings.json")
    for sub in ("migrations", "functions"):
        dst = game / "supabase" / sub
        if dst.exists():
            rm_tree(dst)
        shutil.copytree(be / "supabase" / sub, dst, dirs_exist_ok=True)
    if list((game / "supabase").rglob("zz_preview_*.sql")):
        sys.exit("Refusing to ship: zz_preview_*.sql found in staged supabase/")

    custom_domain = (cfg.get("custom_domain") or urlparse(site).netloc).strip()
    out_cfg = {k: cfg.get(k, "") for k in ("supabase_url", "anon_key", "vapid_public")}
    out_cfg["custom_domain"] = custom_domain
    (game / "deploy_config.json").write_text(
        json.dumps(out_cfg, indent=2) + "\n",
        encoding="utf-8")
    print("staged: www/ app files, build scripts, supabase/, deploy_config.json")

    build_cmd = [sys.executable, "build_deploy.py", "--site", site]
    if a.preview_config:
        build_cmd += ["--preview-config", str(Path(a.preview_config).resolve())]
    if a.preview_repo:
        build_cmd += ["--preview-repo", str(Path(a.preview_repo).resolve())]
    if a.price_sql:
        build_cmd += ["--price-sql", str(Path(a.price_sql).resolve())]
    if a.weekly_sql:
        build_cmd += ["--weekly-sql", str(Path(a.weekly_sql).resolve())]
    subprocess.run(build_cmd, cwd=game, check=True)

    if a.deck_sql:
        subprocess.run([sys.executable, "sync_deck.py", "docs/artline.json", "--site", site, "--sql",
                        str(Path(a.deck_sql).resolve())], cwd=game, check=True)

    docs = game / "docs"
    if a.preview_repo and a.packs_sql:
        write_packs_sql(Path(a.preview_repo).resolve(), docs, site, a.packs_sql)

    # last checks on what will be published
    problems = [f"missing docs/{f}" for f in
                ["CNAME", "index.html", "online.js", "shell.js", "game.js", "sw.js", "strings.js", "shell.css",
                 "packs.js", "vendor/supabase.js", "vendor/fonts.css", "privacy-en.html", "privacy-de.html", "impressum.html"]
                if not (docs / f).exists()]
    if (be / "app" / "streak.js").exists() and not (docs / "streak.js").exists():
        problems.append("missing docs/streak.js")
    if (be / "app" / "price-deck.json").exists():
        if not (docs / "price-deck.json").exists():
            problems.append("missing docs/price-deck.json")
        elif "upload.wikimedia.org" in (docs / "price-deck.json").read_text(encoding="utf-8"):
            problems.append("docs/price-deck.json contains raw Wikimedia URLs")
    if (game / "weekly" / "paintings.json").exists() and not list((docs / "art").glob("wk-*-varnish.jpg")):
        problems.append("docs/art/ is missing weekly restoration images")
    problems += [f"preview/legacy file in docs/: {f}" for f in
                 ["preview.js", "preview.json", "changes.html", "app.js", "Abstract Painting Loader.json", "vendor/lottie-player.js"]
                 if (docs / f).exists()]
    if (docs / "card_keys.json").exists() or (game / "www" / "card_keys.json").exists():
        problems.append("card_keys.json must not be in docs/ or www/")
    if (game / "www" / "packs").exists():
        problems.append("www/packs/ must not exist in the staged game repo")
    if (docs / "packs").is_dir():
        for pf in sorted((docs / "packs").glob("*.json")):
            ptxt = pf.read_text(encoding="utf-8")
            if "upload.wikimedia.org" in ptxt or "image_source" in ptxt:
                problems.append(f"docs/packs/{pf.name} contains raw Wikimedia/image_source fields")
    if not list((docs / "art").glob("*.jpg")):
        problems.append("docs/art/ is empty")
    online_txt = (docs / "online.js").read_text(encoding="utf-8")
    if "https://YOUR-PROJECT.supabase.co" in online_txt or "YOUR-ANON-KEY" in online_txt or PREVIEW_SUPABASE_REF in online_txt:
        problems.append("online.js still has placeholder or preview settings")
    idx_txt = (docs / "index.html").read_text(encoding="utf-8")
    if "*.supabase.co" in idx_txt or PREVIEW_SUPABASE_REF in idx_txt or "img-src 'self' data: blob:;" not in idx_txt:
        problems.append("docs/index.html CSP is not strictly pinned")
    cname_txt = (docs / "CNAME").read_text(encoding="utf-8").strip() if (docs / "CNAME").exists() else ""
    if not cname_txt or "YOUR-GAME-DOMAIN" in cname_txt or "circart-preview" in cname_txt:
        problems.append(f"docs/CNAME is invalid: {cname_txt!r}")
    if (game / "supabase" / "config.toml").exists() and PREVIEW_SUPABASE_REF in (game / "supabase" / "config.toml").read_text(encoding="utf-8"):
        problems.append("supabase/config.toml still references preview project")
    if list((game / "supabase").rglob("zz_preview_*.sql")):
        problems.append("zz_preview_*.sql present in supabase/")
    problems += check_legal_files(docs)
    if problems:
        sys.exit("NOT ready:\n  " + "\n  ".join(problems))
    print("\nReady. Review `git status`, commit on the branch and open the pull request.")


if __name__ == "__main__":
    main()
