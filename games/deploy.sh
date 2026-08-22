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
# `_*` is excluded the way build-web.py protects the simulator: a harness left
# in this directory would otherwise be published, and the archive already
# learned that rsync -a --delete copies EVERYTHING.
rsync -a --delete --exclude 'deploy.sh' --exclude '*.lst' --exclude 'tools' \
  --exclude '_*' ./ "$DEST/"
echo "published $(du -sh "$DEST" | cut -f1) -> $DEST"
curl -s -o /dev/null -w "live: %{http_code}\n" https://games.tinymachines.ai/
