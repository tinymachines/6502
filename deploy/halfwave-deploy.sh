#!/usr/bin/env bash
# Publish the Halfwave Lab to halfwave.tinymachines.ai.
#
# The site is one self-contained file served as index.html, by request:
# "add it as index.html for now, we'll package later". When packaging
# happens, this script is the seam it happens at.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=docs/halfwave-lab/halfwave-lab.html
ROOT=/var/www/halfwave.tinymachines.ai

# The page must be the consumer we think it is: self-contained (no local
# fetches to files this deploy does not ship) and pointed at its own origin.
grep -q 'location.origin + "/api"' "$SRC" || {
  echo "refusing: $SRC no longer resolves its API at location.origin/api"; exit 1; }
grep -qE "fetch\((\"|')[a-z]" "$SRC" && {
  echo "refusing: $SRC fetches a local file this deploy does not publish:"; \
  grep -oE "fetch\((\"|')[a-z][^\"')]*" "$SRC"; exit 1; }

install -o www-data -g www-data -m 644 "$SRC" "$ROOT/index.html"
# The PWA shell beside it: manifest, service worker, icons. All unhashed and
# all served no-cache by the vhost, so a deploy is picked up on the next
# online load and the worker cannot pin a stale build.
install -o www-data -g www-data -m 644 docs/halfwave-lab/manifest.webmanifest "$ROOT/"
install -o www-data -g www-data -m 644 docs/halfwave-lab/sw.js "$ROOT/"
install -d -o www-data -g www-data "$ROOT/icons"
install -o www-data -g www-data -m 644 docs/halfwave-lab/icons/*.png "$ROOT/icons/"
echo "published $(wc -c < "$SRC") bytes -> $ROOT/index.html (+ manifest, sw, icons)"
curl -fsS -o /dev/null https://halfwave.tinymachines.ai/ && echo "live: 200"
