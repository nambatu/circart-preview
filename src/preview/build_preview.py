#!/usr/bin/env python3
"""
CIRCArt — build the PREVIEW site (never the real one).

    python build_preview.py --game <clone of the game repo> --claude <folder with app/ backend/ preview/>
                            --out <clone of circart-preview> --config preview.json

What it does
  1. Starts from the game repo's published site (docs/: app.js, style.css,
     artline.json, resized images). www/images is not in git, docs/ is.
  2. Adds the new files (index.html, shell.*, strings.js, game.js, online.js)
     and points online.js at the PREVIEW Supabase project.
  3. Publishes every image again under its year-free key (docs/art/<key>.jpg).
     Keys live in <out>/card_keys.json so they stay the same between builds.
  4. Makes it obviously a preview: "CIRCArt Preview" name, a banner with the
     build time linking to a "What's new / what to test" page, no CNAME
     (so it can never take over circart.langschwerts.de).
  5. Writes supabase/migrations/*.sql and supabase/deck.sql for the GitHub
     Action, which applies them to the preview database.

preview.json:
  { "site": "https://<user>.github.io/circart-preview",
    "supabase_url": "https://xxxx.supabase.co", "anon_key": "...",
    "label": "Thu 5 Nov, 17:40",
    "changes": ["Daily challenge on the home screen", ...],
    "test":    ["Play today's daily challenge", ...] }
"""

import argparse
import html
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

NEW_WWW = ["index.html", "shell.js", "shell.css", "strings.js", "strings-de.js", "game.js", "solo.js", "solo.css", "dealer.js"]
OPTIONAL_WWW = ["onboarding.js", "onboarding.css", "solo-i18n.js", "packs.js"]          # copied when present


def log(msg):
    print("  " + msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True, help="clone of the game repo (has docs/)")
    ap.add_argument("--claude", required=True, help="folder with app/, backend/, preview/ from the project")
    ap.add_argument("--out", required=True, help="clone of the circart-preview repo")
    ap.add_argument("--config", required=True)
    a = ap.parse_args()

    game, claude, out = Path(a.game), Path(a.claude), Path(a.out)
    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    site = cfg["site"].rstrip("/")
    src_docs = game / "docs"
    if not (src_docs / "artline.json").exists():
        sys.exit(f"{src_docs} has no artline.json — is --game the game repo?")

    # 1. fresh copy of the published site
    docs = out / "docs"
    if docs.exists():
        shutil.rmtree(docs)
    shutil.copytree(src_docs, docs)
    (docs / "CNAME").unlink(missing_ok=True)          # never claim the real domain
    (docs / ".nojekyll").write_text("")               # serve files as they are
    log(f"base: {src_docs} ({len(list((docs / 'images').glob('*')))} images)")

    # 2. new app files
    for name in NEW_WWW:
        shutil.copy2(claude / "app" / name, docs / name)
    for name in ("privacy-en.html", "privacy-de.html"):      # drafts until Julian fills in his details
        if (claude / "legal" / name).exists():
            shutil.copy2(claude / "legal" / name, docs / name)
    if (claude / "app" / "vendor").is_dir():              # self-hosted fonts + libraries
        shutil.copytree(claude / "app" / "vendor", docs / "vendor", dirs_exist_ok=True)
    for name in OPTIONAL_WWW:
        if (claude / "app" / name).exists():
            shutil.copy2(claude / "app" / name, docs / name)
    online = (claude / "backend" / "web" / "online.js").read_text(encoding="utf-8")
    online = re.sub(r"const SUPABASE_URL = '[^']*';", f"const SUPABASE_URL = '{cfg['supabase_url']}';", online)
    online = re.sub(r"const SUPABASE_ANON_KEY = '[^']*';", f"const SUPABASE_ANON_KEY = '{cfg['anon_key']}';", online)
    if cfg.get("vapid_public"):
        online = re.sub(r"const VAPID_PUBLIC_KEY = '[^']*';", f"const VAPID_PUBLIC_KEY = '{cfg['vapid_public']}';", online)
    if f"const SUPABASE_URL = '{cfg['supabase_url']}';" not in online or f"'{cfg['anon_key']}'" not in online:
        sys.exit("could not set the Supabase URL / anon key in online.js")
    (docs / "online.js").write_text(online, encoding="utf-8")
    log("app files + online.js (preview database)")

    # 3. year-free images, keys kept in the preview repo
    sys.path.insert(0, str(claude / "backend" / "deck"))
    import card_keys                                       # noqa: E402
    import sync_deck                                       # noqa: E402
    card_keys.KEY_FILE = out / "card_keys.json"
    import deck_fixes                                      # noqa: E402  (corrections to the base deck)
    all_cards = json.loads((docs / "artline.json").read_text(encoding="utf-8"))
    log(f"deck fixes: {deck_fixes.apply(all_cards, sync_deck.fix_mojibake)} cards lost their style")
    (docs / "artline.json").write_text(json.dumps(all_cards, ensure_ascii=False, indent=2), encoding="utf-8")
    cards = [c for c in all_cards if c.get("id")]
    keys, added, _ = card_keys.load_keys(cards)
    (docs / "art").mkdir(exist_ok=True)
    n = 0
    for c in cards:
        img = card_keys.image_name(c)
        if img and (docs / "images" / img).exists():
            shutil.copy2(docs / "images" / img, docs / "art" / f"{keys[c['id']]}.jpg")
            n += 1
    log(f"art/: {n} year-free images ({added} new keys)")

    # 3b. card packs: claude/packs/<id>.json → docs/packs/<id>.json (solo game),
    #     supabase/packs.sql (database), pack_images.json (the pack-images Action
    #     downloads each image once into pack-art/<key>.jpg; copied into art/ here)
    pack_sql, pack_images = build_packs(claude, out, docs, card_keys, site)
    log(f"packs: {pack_sql}")
    # 3c. story dailies: claude/dailies/<date>-<slug>.json → supabase/dailies.sql
    #     (their images join pack_images.json, so the same Action downloads them)
    log(f"story dailies: {build_dailies(claude, out, docs, card_keys, site, pack_images)}")

    # 4. it's a preview, and it says so
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    sw = docs / "sw.js"
    if sw.exists():
        s = sw.read_text(encoding="utf-8")
        s = re.sub(r"const CACHE_VERSION = '[^']*';", f"const CACHE_VERSION = 'preview-{stamp}';", s, count=1)
        extra = "".join(f"\n    './{f}'," for f in ["shell.css", "shell.js", "strings.js", "strings-de.js", "game.js", "solo.js", "solo.css", "dealer.js", "solo-i18n.js", "onboarding.js", "onboarding.css", "packs.js", "online.js", "preview.js"]
                        if f"'./{f}'" not in s)
        s = s.replace("const SHELL_ASSETS = [", "const SHELL_ASSETS = [" + extra, 1)
        # a preview must never serve yesterday's build: shell files network-first
        s = s.replace("event.respondWith(cacheFirst(request, SHELL_CACHE));",
                      "event.respondWith(networkFirst(request, SHELL_CACHE));")
        s += (claude / "app" / "sw-push.js").read_text(encoding="utf-8")   # push + notification taps
        sw.write_text(s, encoding="utf-8")
    man = docs / "manifest.webmanifest"
    if man.exists():
        m = json.loads(man.read_text(encoding="utf-8"))
        m["name"], m["short_name"] = "CIRCArt Preview", "CIRCArt β"
        man.write_text(json.dumps(m, indent=2, ensure_ascii=False), encoding="utf-8")
    idx = docs / "index.html"
    s = idx.read_text(encoding="utf-8")
    s = s.replace("<title>CIRCArt</title>", "<title>CIRCArt Preview</title>")
    s = s.replace('content="CIRCArt">', 'content="CIRCArt β">')
    s = s.replace('<script src="pwa.js"></script>', '<script src="pwa.js"></script>\n    <script src="preview.js"></script>')
    idx.write_text(s, encoding="utf-8")
    shutil.copy2(claude / "preview" / "preview.js", docs / "preview.js")
    (docs / "preview.json").write_text(json.dumps({"label": cfg.get("label", stamp)}), encoding="utf-8")
    (docs / "changes.html").write_text(changes_page(cfg), encoding="utf-8")

    # every script and stylesheet the page loads must really be there
    # (6 Nov: packs.js was missing from the build for a day and nobody noticed)
    page = idx.read_text(encoding="utf-8")
    refs = re.findall(r'<script[^>]+src="([^":]+)"', page) + re.findall(r'<link[^>]+href="([^":]+\.css)"', page)
    missing = [r for r in refs if not r.startswith("//") and not (docs / r).exists()]
    if missing:
        sys.exit("build_preview: index.html loads files that are not in docs/: " + ", ".join(missing))
    log("preview name, banner, What's new page, network-first service worker")

    # 5. database files for the GitHub Action
    mig = out / "supabase" / "migrations"
    mig.mkdir(parents=True, exist_ok=True)
    for f in sorted((claude / "backend" / "supabase" / "migrations").glob("*.sql")):
        shutil.copy2(f, mig / f.name)
    for f in sorted((claude / "preview").glob("zz_preview_*.sql")):   # preview-only: cron jobs, push
        shutil.copy2(f, mig / f.name)
    rows, problems, _ = sync_deck.build_rows(json.loads((docs / "artline.json").read_text(encoding="utf-8")), keys, site)
    (out / "supabase" / "deck.sql").write_text(sync_deck.to_sql(rows), encoding="utf-8")
    log(f"supabase/: {len(list(mig.glob('*.sql')))} migrations, deck.sql with {len(rows)} cards"
        + (f" ({len(problems)} card problems)" if problems else ""))

    wf = out / ".github" / "workflows"
    wf.mkdir(parents=True, exist_ok=True)
    shutil.copy2(claude / "preview" / "preview-db.yml", wf / "preview-db.yml")
    for name in ("pack-images.yml", "commons-lookup.yml", "daily-history.yml"):
        if (claude / "preview" / name).exists():
            shutil.copy2(claude / "preview" / name, wf / name)
    print(f"\nPreview built in {docs}. Commit and push {out} to deploy.")


TIER_LABEL = {1: "icon", 2: "recognisable", 3: "obscure"}


def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:40]


def sql_q(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def build_packs(claude, out, docs, card_keys, site):
    src = claude / "packs"
    files = sorted(src.glob("*.json")) if src.is_dir() else []
    (docs / "packs").mkdir(exist_ok=True)
    art_cache = out / "pack-art"
    art_cache.mkdir(exist_ok=True)
    sql, images, summary = ["-- generated by build_preview.py: card packs (inactive cards, solo only)"], [], []
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        meta, cards = data["pack"], data["cards"]
        pid = meta["id"]
        for c in cards:
            c["_id"] = f"{c['year']}-{slug(c['artist'])}-{slug(c['title'])}"
        keys, _, _ = card_keys.load_keys([{"id": c["_id"]} for c in cards])
        app_cards, have = [], 0
        for c in cards:
            key = keys[c["_id"]]
            if (art_cache / f"{key}.jpg").exists():
                shutil.copy2(art_cache / f"{key}.jpg", docs / "art" / f"{key}.jpg")
                have += 1
            urls = [u for u in (c.get("image_source"), c.get("image_source_original"), c.get("image_source_fallback")) if u]
            images.append({"key": key, "urls": urls, "page": c.get("commons_page") or ""})
            app_cards.append({
                "id": c["_id"], "title": c["title"], "artist": c["artist"], "year": c["year"],
                "date_note": c.get("date_note"), "movement": c.get("movement"), "medium": c.get("medium"),
                "location": c.get("location"), "tier": c.get("tier", 2), "tier_label": TIER_LABEL.get(c.get("tier", 2), "recognisable"),
                "visual_type": "object", "trivia": c.get("trivia"), "trivia_de": c.get("trivia_de"),
                "image_local": f"art/{key}.jpg", "license": c.get("license"), "commons_page": c.get("commons_page"),
                "pack": pid,
            })
            sql.append("insert into public.cards (id, source_id, title, artist, year, date_note, movement, medium, location, tier, "
                       "visual_type, image_url, trivia, pack_id, active) values ("
                       + ", ".join(sql_q(v) for v in [key, "pack:" + pid + ":" + c["_id"], c["title"], c["artist"], c["year"],
                                                      c.get("date_note"), c.get("movement"), c.get("medium"), c.get("location"),
                                                      int(c.get("tier", 2)), "object", f"{site}/art/{key}.jpg", c.get("trivia"), pid, False])
                       + ") on conflict (id) do update set title = excluded.title, artist = excluded.artist, year = excluded.year, "
                         "date_note = excluded.date_note, movement = excluded.movement, medium = excluded.medium, "
                         "location = excluded.location, tier = excluded.tier, image_url = excluded.image_url, "
                         "trivia = excluded.trivia, pack_id = excluded.pack_id, active = false, updated_at = now();")
        # a pack defined only in its JSON (not in a migration) is created here; existing rules are kept
        sql.insert(1, "insert into public.packs (id, title, title_de, description, description_de, unlock_rule, unlock_text, unlock_text_de) values ("
                   + ", ".join(sql_q(v) for v in [pid, meta.get("title"), meta.get("title_de"), meta.get("description") or "",
                                                  meta.get("description_de"), json.dumps(meta.get("unlock_rule") or {"type": "free"}),
                                                  meta.get("unlock_text") or meta.get("unlock_hint") or "", meta.get("unlock_text_de")])
                   + ") on conflict (id) do nothing;")
        (docs / "packs" / f"{pid}.json").write_text(json.dumps({"pack": meta, "cards": app_cards}, ensure_ascii=False, indent=1), encoding="utf-8")
        summary.append(f"{pid} {len(app_cards)} cards, {have} images")
    (out / "supabase").mkdir(exist_ok=True)
    (out / "supabase" / "packs.sql").write_text("\n".join(sql) + "\n", encoding="utf-8")
    (out / "pack_images.json").write_text(json.dumps(images, indent=1), encoding="utf-8")
    return (", ".join(summary) or "none"), images


def build_dailies(claude, out, docs, card_keys, site, images):
    src = claude / "dailies"
    files = sorted(src.glob("*.json")) if src.is_dir() else []
    art_cache = out / "pack-art"
    sql, summary = ["-- generated by build_preview.py: story dailies (inactive cards + themes)"], []
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        th, cards = data["theme"], data["cards"]
        if not 4 <= len(cards) <= 31:
            sys.exit(f"build_preview: {f.name} needs a start card + 3 to 30 cards, has {len(cards)}")
        for c in cards:
            c["_id"] = f"{c['year']}-{slug(c['artist'])}-{slug(c['title'])}"
        keys, _, _ = card_keys.load_keys([{"id": c["_id"]} for c in cards])
        have = 0
        for c in cards:
            key = keys[c["_id"]]
            if (art_cache / f"{key}.jpg").exists():
                shutil.copy2(art_cache / f"{key}.jpg", docs / "art" / f"{key}.jpg")
                have += 1
            urls = [u for u in (c.get("image_source"), c.get("image_source_original"), c.get("image_source_fallback")) if u]
            if not any(i["key"] == key for i in images):
                images.append({"key": key, "urls": urls, "page": c.get("commons_page") or ""})
            sql.append("insert into public.cards (id, source_id, title, artist, year, date_note, movement, medium, location, tier, "
                       "visual_type, image_url, trivia, active) values ("
                       + ", ".join(sql_q(v) for v in [key, "daily:" + th["slug"] + ":" + c["_id"], c["title"], c["artist"], c["year"],
                                                      c.get("date_note"), c.get("movement"), c.get("medium"), c.get("location"),
                                                      int(c.get("tier", 2)), c.get("visual_type") or "object",
                                                      # not downloaded yet (pack-images Action) → load straight from Wikimedia for now
                                                      f"{site}/art/{key}.jpg" if (art_cache / f"{key}.jpg").exists() else (urls[0] if urls else None),
                                                      c.get("trivia"), False])
                       + ") on conflict (id) do update set title = excluded.title, artist = excluded.artist, year = excluded.year, "
                         "date_note = excluded.date_note, movement = excluded.movement, medium = excluded.medium, "
                         "location = excluded.location, tier = excluded.tier, visual_type = excluded.visual_type, "
                         "image_url = excluded.image_url, trivia = excluded.trivia, updated_at = now();")
        day = th["date"]
        sql.append("insert into public.daily_themes (day, slug, title, title_de, intro, intro_de, outro, outro_de) values ("
                   + ", ".join(sql_q(v) for v in [day, th["slug"], th["title"], th.get("title_de"), th["intro"], th.get("intro_de"),
                                                  th.get("outro"), th.get("outro_de")])
                   + ") on conflict (day) do update set slug = excluded.slug, title = excluded.title, title_de = excluded.title_de, "
                     "intro = excluded.intro, intro_de = excluded.intro_de, outro = excluded.outro, outro_de = excluded.outro_de, updated_at = now();")
        sql.append(f"delete from public.daily_theme_cards where day = {sql_q(day)};")
        for pos, c in enumerate(cards):
            sql.append("insert into public.daily_theme_cards (day, position, card_id, chapter, chapter_de, credit) values ("
                       + ", ".join(sql_q(v) for v in [day, pos, keys[c["_id"]], c.get("chapter"), c.get("chapter_de"), c.get("credit")]) + ");")
        summary.append(f"{day} {th['slug']} ({len(cards) - 1} cards, {have}/{len(cards)} images)")
    (out / "supabase").mkdir(exist_ok=True)
    (out / "supabase" / "dailies.sql").write_text("\n".join(sql) + "\n", encoding="utf-8")
    (out / "pack_images.json").write_text(json.dumps(images, indent=1), encoding="utf-8")
    return ", ".join(summary) or "none"


def changes_page(cfg):
    li = lambda xs: "".join(f"<li>{html.escape(x)}</li>" for x in xs) or "<li>—</li>"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>CIRCArt Preview · What's new</title>
<link rel="stylesheet" href="shell.css"><style>body{{margin:0;font-family:Inter,system-ui,sans-serif}}
.page{{max-width:560px}} li{{margin:6px 0;line-height:1.45}} h2{{margin-top:12px}}</style>
<script>try{{var t=localStorage.getItem('circart-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}}catch(e){{}}</script>
</head><body><div class="page">
<p class="eyebrow">PREVIEW · {html.escape(cfg.get('label', ''))}</p>
<h1 class="serif" style="font-size:28px">What's new</h1><ul>{li(cfg.get('changes', []))}</ul>
<h2 class="serif" style="font-size:22px">What to test</h2><ol>{li(cfg.get('test', []))}</ol>
<p class="note">Something wrong? In the app: Profile → Send feedback, or the flag during a game.
It lands in the preview database and the next evening build reads it.</p>
<p class="note">This is a test version with its own database. Your real game at circart.langschwerts.de is not affected.</p>
<p><a class="btn primary" href="./">Open the preview</a></p></div></body></html>
"""


if __name__ == "__main__":
    main()
