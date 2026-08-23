#!/bin/bash
# Every container as its own diagram.
#
#     bash tools/chip-elk/run.sh [outdir]
#
# 132 of them, a couple of seconds each. The whole chip in one layout is in
# the README and is not worth looking at; this is the scale that reads.
set -e
cd "$(dirname "$0")"
OUTDIR="${1:-/tmp/chip-elk-svg}"
[ -d node_modules ] || npm install --silent elkjs
mkdir -p "$OUTDIR"

KEYS=$(node -e '
  const g = require("../../web/groups.json");
  for (const x of g.groups) console.log(x.key);
')

ok=0; fail=0
for key in $KEYS; do
  # A key can carry a slash (alat:ADL/ABL, op-T2-ADL/ADD), which is a
  # directory separator to every filesystem. Flatten it for the filename and
  # keep the real key in the diagram.
  file=$(echo "$key" | tr '/:' '--')
  if GROUP="$key" OUT="/tmp/elk-one.json" node chip2elk.js >/dev/null 2>&1 \
     && OUT="/tmp/elk-one.json" SVG="$OUTDIR/$file.svg" node elk2svg.js >/dev/null 2>&1; then
    ok=$((ok+1))
  else
    echo "  FAILED $key" >&2
    fail=$((fail+1))
  fi
done
echo "$ok drawn, $fail failed -> $OUTDIR"
