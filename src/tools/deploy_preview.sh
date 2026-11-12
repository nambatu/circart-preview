#!/usr/bin/env bash
# CIRCArt — build the preview from src/ and deploy it, in one go.
#   src/tools/deploy_preview.sh "commit message"
# Run it from anywhere inside a clone of nambatu/circart-preview.
# 1. assembles a temporary build folder from src/ (the layout build_preview.py expects)
# 2. runs build_preview.py with src/preview/preview.json (edit label/changes/test first)
# 3. commits EVERYTHING (your src/ changes + the build output) and pushes, with retries
# 4. waits for preview-db + Pages; re-runs a Pages deploy that failed with a server error
# The base game (images, artline.json) comes from Julian's game repo nambatu/circart,
# cloned read-only into $GAME if it isn't there yet. Never push to that repo.
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"          # …/circart-preview/src
OUT="$(cd "$SRC/.." && pwd)"                     # …/circart-preview (the repo)
PV="${PV:-$(mktemp -d)}"                         # temporary build folder
GAME="${GAME:-$HOME/circart-game}"
MSG="${1:?commit message}"
REPO=nambatu/circart-preview

[ -d "$GAME/.git" ] || git clone -q --depth 1 https://github.com/nambatu/circart "$GAME"

mkdir -p "$PV/app" "$PV/backend/web" "$PV/backend/deck" "$PV/backend/supabase/migrations" "$PV/preview" "$PV/packs" "$PV/dailies"
cp "$SRC"/app/*.js "$SRC"/app/*.css "$SRC"/app/index.html "$PV/app/"
[ -d "$SRC/app/vendor" ] && mkdir -p "$PV/app/vendor" && cp -r "$SRC/app/vendor/." "$PV/app/vendor/"
cp "$SRC"/web/online.js "$PV/backend/web/"
cp "$SRC"/deck/*.py "$PV/backend/deck/"
cp "$SRC"/supabase/migrations/*.sql "$PV/backend/supabase/migrations/"
find "$SRC/preview" -maxdepth 1 -type f -exec cp {} "$PV/preview/" \;
cp "$SRC"/packs/*.json "$PV/packs/" 2>/dev/null || true
cp "$SRC"/dailies/*.json "$PV/dailies/" 2>/dev/null || true
mkdir -p "$PV/legal" && cp "$SRC"/legal/*.html "$PV/legal/" 2>/dev/null || true
[ -d "$SRC/supabase/functions" ] && mkdir -p "$PV/backend/supabase/functions" && cp -r "$SRC/supabase/functions/." "$PV/backend/supabase/functions/"

cd "$OUT"
git pull -q --rebase --autostash origin main || true
python3 "$PV/preview/build_preview.py" --game "$GAME" --claude "$PV" --out "$OUT" --config "$SRC/preview/preview.json"
for f in docs/*.js; do node --check "$f" || { echo "syntax error in $f"; exit 1; }; done
git add -A
git diff --cached --quiet && { echo "nothing to deploy"; exit 0; }
git commit -q -m "$MSG

Co-Authored-By: Claude <noreply@anthropic.com>"
for i in 1 2 3 4; do
  git pull -q --rebase origin main || true
  if git push -q origin HEAD:main 2>/dev/null; then echo "pushed"; break; fi
  [ $i = 4 ] && { echo "push failed"; exit 1; }
  sleep 15
done
sha=$(git rev-parse HEAD)
echo "waiting for GitHub (preview-db + Pages)…"
sleep 20
for i in $(seq 1 60); do
  pending=$(gh run list -R $REPO -L 6 --json status,headSha --jq "[.[] | select(.headSha==\"$sha\" and .status!=\"completed\")] | length" 2>/dev/null || echo 0)
  [ "$pending" = 0 ] && break
  sleep 10
done
gh run list -R $REPO -L 6 --json name,conclusion,headSha,databaseId --jq ".[] | select(.headSha==\"$sha\") | \"\(.conclusion)\t\(.name)\t\(.databaseId)\"" 2>/dev/null | while IFS=$'\t' read -r concl name id; do
  echo "$concl  $name"
  if [ "$concl" = failure ] && [[ "$name" == pages* ]]; then
    echo "  Pages failed — re-running once"; gh run rerun "$id" -R $REPO || true
  fi
done
echo "done: https://nambatu.github.io/circart-preview/"
