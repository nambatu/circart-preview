#!/usr/bin/env python3
"""CIRCArt — publish story dailies to the preview WITHOUT rebuilding the app.

For the story-daily agent. It only touches what a story needs in the preview
repo (a clone of nambatu/circart-preview):
  supabase/dailies.sql   → the preview-db Action loads it into the database
  pack_images.json       → the pack-images Action downloads the photos into pack-art/
  docs/art/<key>.jpg     → copies of downloaded photos (second run, after the download)

  python3 publish_story.py --stories <folder with <date>-<slug>.json> --out <preview clone> \
                           --deck <folder with card_keys.py> [--site https://nambatu.github.io/circart-preview]

Run it once, commit + push (photos get downloaded), pull, run it again, commit + push
(the cards then use the preview's own copies). Every story file in --stories is
published; keep only current/future stories there (old ones may stay — they are upserts).
"""
import argparse, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stories", required=True, help="folder with <date>-<slug>.json files")
    ap.add_argument("--out", required=True, help="clone of nambatu/circart-preview")
    ap.add_argument("--deck", required=True, help="folder with card_keys.py (claude/backend/deck)")
    ap.add_argument("--site", default="https://nambatu.github.io/circart-preview")
    a = ap.parse_args()
    out = Path(a.out)
    sys.path.insert(0, str(HERE))
    sys.path.insert(0, str(Path(a.deck)))
    import build_preview as bp          # reuse the exact build code for stories
    import card_keys
    card_keys.KEY_FILE = out / "card_keys.json"
    # build_dailies expects <claude>/dailies; point it at the stories folder's parent
    stories = Path(a.stories)
    claude = stories.parent if stories.name == "dailies" else None
    if claude is None:
        tmp = out / ".stories-tmp"; (tmp / "dailies").mkdir(parents=True, exist_ok=True)
        for f in (tmp / "dailies").glob("*.json"): f.unlink()
        for f in stories.glob("*.json"): (tmp / "dailies" / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
        claude = tmp
    images = json.loads((out / "pack_images.json").read_text(encoding="utf-8")) if (out / "pack_images.json").exists() else []
    (out / "docs" / "art").mkdir(parents=True, exist_ok=True)
    summary = bp.build_dailies(claude, out, out / "docs", card_keys, a.site.rstrip("/"), images)
    if (out / ".stories-tmp").exists():
        import shutil; shutil.rmtree(out / ".stories-tmp")
    print("published:", summary)


if __name__ == "__main__":
    main()
