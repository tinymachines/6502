#!/bin/bash
# Publish games.tinymachines.ai. No build step: the page is ES modules and a
# ROM, served as they are.
set -e
cd "$(dirname "$0")"
DEST=/var/www/games.tinymachines.ai
[ -d "$DEST" ] || { echo "games: $DEST does not exist" >&2; exit 1; }
for f in index.html game.js console.js chr.js; do
  [ -f "$f" ] || { echo "games: $f is missing" >&2; exit 1; }
done
[ -s rom/snake.rom ] || { echo "games: rom/snake.rom is missing" >&2; exit 1; }
# The sheet is generated from the art and is what the console draws; the
# starter set in chr.js is the fallback, so a missing sheet is a warning
# rather than a failure.
[ -s art/tiles.chr ] || echo "games: art/tiles.chr is missing; the starter tiles will be drawn" >&2
# The sample cartridge is MINTED here rather than kept in the tree, so it
# cannot go stale against rom/dierunner.s and so every deploy exercises the
# endpoint that makes it. A failure is not fatal: the page ships two built-in
# cartridges and the file is a sample of the format, not the site.
API=${API:-https://6502.tinymachines.ai/api}
if command -v python3 >/dev/null && [ -f rom/dierunner.s ]; then
  python3 tools/mint.py --api "$API" --out dierunner.cart.gz \
    || echo "games: could not mint dierunner.cart.gz from $API; publishing without it" >&2
fi

# `_*` is excluded the way build-web.py protects the simulator: a harness left
# in this directory would otherwise be published, and the archive already
# learned that rsync -a --delete copies EVERYTHING.
rsync -a --delete --exclude 'deploy.sh' --exclude '*.lst' --exclude 'tools' \
  --exclude '_*' ./ "$DEST/"
echo "published $(du -sh "$DEST" | cut -f1) -> $DEST"
curl -s -o /dev/null -w "live: %{http_code}\n" https://games.tinymachines.ai/
