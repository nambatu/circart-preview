#!/usr/bin/env bash
# CIRCArt — run every test: all server suites (PGlite) + the browser test (Playwright).
#   src/tools/test_all.sh [--no-e2e]
# $WORK is a scratch folder with node_modules (@electric-sql/pglite@0.5.15 + playwright);
# it is created and filled on the first run. DECK defaults to the repo's supabase/deck.sql.
set -u
BE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HOME/circart-testwork}"
DECK="${DECK:-$BE/../supabase/deck.sql}"
mkdir -p "$WORK"
if [ ! -d "$WORK/node_modules/@electric-sql/pglite" ]; then
  (cd "$WORK" && npm init -y >/dev/null && npm i -s @electric-sql/pglite@0.5.15 >/dev/null)
fi
# Playwright: use the one already installed on the machine if require() finds it, else install it
node -e "require('playwright')" 2>/dev/null || (cd "$WORK" && npm i -s playwright >/dev/null)
MIG="$BE/supabase/migrations"
fail=0
cd "$WORK"
for t in "$BE"/tests/*.test.mjs; do
  name=$(basename "$t" .test.mjs)
  cp "$t" "$WORK/"
  if [ "$name" = foundation ]; then args=("$MIG/001_foundation.sql" "$DECK"); else args=("$MIG" "$DECK"); fi
  res=$(timeout 300 node "$WORK/$(basename "$t")" "${args[@]}" 2>&1 | grep -E "✗|all checks passed|FAILED|Error" | head -5 | tr '\n' ' ')
  printf "%-12s %s\n" "$name" "$res"
  case "$res" in *"all checks passed"*) ;; *) [ "$name" = foundation ] || fail=1 ;; esac
done
if [ "${1:-}" != "--no-e2e" ]; then
  S="$WORK/e2e"; rm -rf "$S"; mkdir -p "$S/site"
  # base game (images, app.js, artline.json) from Admin's game repo, read-only, like deploy_preview.sh
  GAME="${GAME:-$HOME/circart-game}"
  [ -d "$GAME/.git" ] || git clone -q --depth 1 https://github.com/nambatu/circart "$GAME"
  cp -r "$GAME/docs/." "$S/site/"
  [ -f "$S/site/app.js" ] && sed -i "s/const REPORT_EMAIL = '[^']*';/const REPORT_EMAIL = '';/" "$S/site/app.js"
  cp "$BE"/app/*.js "$BE"/app/*.css "$BE"/app/index.html "$S/site/" 2>/dev/null
  for f in "$BE"/app/*.json; do [ -f "$f" ] && cp "$f" "$S/site/"; done
  [ -d "$BE/app/vendor" ] && cp -r "$BE/app/vendor" "$S/site/"
  mkdir -p "$S/site/packs" && for f in "$BE"/packs/*.json; do [ -f "$f" ] && cp "$f" "$S/site/packs/"; done
  [ -d "$BE/../docs/packs" ] && for f in "$BE/../docs/packs"/*.json; do [ -f "$f" ] && cp "$f" "$S/site/packs/"; done
  [ -d "$BE/../pack-art" ] && mkdir -p "$S/site/art" && cp "$BE/../pack-art"/* "$S/site/art/" 2>/dev/null || true
  PY=""
  for cand in python python3; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import PIL" 2>/dev/null; then
      PY="$cand"; break
    fi
  done
  PY="${PY:-$(command -v python3 || command -v python)}"
  cp "$BE/../card_keys.json" "$S/card_keys.json" 2>/dev/null || echo '{}' > "$S/card_keys.json"
  E2E_DECK="$S/deck_plus_extra.sql"
  cp "$DECK" "$E2E_DECK"
  "$PY" "$BE/deck/extra_modes.py" \
    --artline "$S/site/artline.json" \
    --card-keys "$S/card_keys.json" \
    --game-images "$GAME/docs/images" \
    --pack-art "$BE/../pack-art" \
    --price-json "$BE/app/price-deck.json" \
    --weekly-json "$BE/weekly/paintings.json" \
    --out-docs "$S/site" \
    --price-sql "$S/price.sql" \
    --weekly-sql "$S/weekly.sql" || { echo "extra_modes.py failed"; fail=1; }
  [ -f "$S/price.sql" ] && cat "$S/price.sql" >> "$E2E_DECK"
  if [ -f "$S/weekly.sql" ] && grep -q "weekly_paintings" "$MIG"/*.sql 2>/dev/null; then
    cat "$S/weekly.sql" >> "$E2E_DECK"
  fi
  cp "$BE/app/tests/e2e-online.js" "$S/site/online.js"
  cp "$BE/app/tests/e2e.mjs" "$S/run.mjs"
  res=$(timeout 600 node "$S/run.mjs" "$S" "$MIG" "$E2E_DECK" 2>&1 | grep -E "✗|all checks passed|FAILED|Error" | head -8 | tr '\n' ' ')
  printf "%-12s %s\n" "e2e" "$res"
  case "$res" in *"all checks passed"*) ;; *) fail=1 ;; esac
fi
[ $fail = 0 ] && echo "ALL GREEN" || echo "SOMETHING FAILED"
exit $fail
