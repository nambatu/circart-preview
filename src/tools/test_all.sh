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
  if [ "$name" = foundation ]; then args="$MIG/001_foundation.sql $DECK"; else args="$MIG $DECK"; fi
  res=$(timeout 300 node "$WORK/$(basename "$t")" $args 2>&1 | grep -E "✗|all checks passed|FAILED|Error" | head -5 | tr '\n' ' ')
  printf "%-12s %s\n" "$name" "$res"
  case "$res" in *"all checks passed"*) ;; *) [ "$name" = foundation ] || fail=1 ;; esac
done
if [ "${1:-}" != "--no-e2e" ]; then
  S="$WORK/e2e"; mkdir -p "$S/site"
  cp "$BE"/app/*.js "$BE"/app/*.css "$BE"/app/index.html "$S/site/" 2>/dev/null
  [ -d "$BE/app/vendor" ] && cp -r "$BE/app/vendor" "$S/site/"
  mkdir -p "$S/site/packs" && for f in "$BE"/packs/*.json; do [ -f "$f" ] && cp "$f" "$S/site/packs/"; done
  cp "$BE/app/tests/e2e-online.js" "$S/site/online.js"
  cp "$BE/app/tests/e2e.mjs" "$S/run.mjs"
  res=$(timeout 600 node "$S/run.mjs" "$S" "$MIG" "$DECK" 2>&1 | grep -E "✗|all checks passed|FAILED" | tr '\n' ' ')
  printf "%-12s %s\n" "e2e" "$res"
  case "$res" in *"all checks passed"*) ;; *) fail=1 ;; esac
fi
[ $fail = 0 ] && echo "ALL GREEN" || echo "SOMETHING FAILED"
exit $fail
