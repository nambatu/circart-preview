"""
Year-free keys for CIRCArt cards.

The ids in artline.json start with the year ("1434-jan-van-eyck-..."), and so do
the image filenames. That's fine for solo play, but in multiplayer the phone
would see the answer in the image link before placing the card. Every card
therefore gets a random key that says nothing about it, e.g. "q7m2xk9a4t".

Keys are random rather than derived from the id: a hash of the id could be
recomputed by anyone who has artline.json. They are stored in card_keys.json in the
project root (next to this script) and must never change once a card has been
played, so commit that file. It must NOT go into www/ or docs/: www/ is what
the Android app bundles and docs/ is the public website, and the file maps
every year-bearing id to its key.
"""

import json
import secrets
from pathlib import Path

ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"   # no 0/o, 1/l/i
KEY_LEN = 10


def _new_key(taken):
    while True:
        k = "".join(secrets.choice(ALPHABET) for _ in range(KEY_LEN))
        if k not in taken:
            return k


KEY_FILE = Path(__file__).resolve().parent / "card_keys.json"


def load_keys(cards):
    """Return {artline id: key}, creating keys for new cards and saving the file."""
    path = KEY_FILE
    keys = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    taken = set(keys.values())
    added = 0
    for c in cards:
        if c["id"] not in keys:
            keys[c["id"]] = _new_key(taken)
            taken.add(keys[c["id"]])
            added += 1
    if added or not path.exists():
        path.write_text(json.dumps(keys, indent=1, sort_keys=True, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    return keys, added, path


def image_name(card):
    """'images\\\\1434-...jpg?t=123' -> '1434-...jpg' (the file in images/)."""
    ref = card.get("image_local") or ""
    return ref.replace("\\", "/").split("/")[-1].split("?")[0] or None
