#!/usr/bin/env bash
#
# Publish the visual6502.org preservation archive to 6502.tinymachines.ai/archive/.
#
# Separate from deploy.sh on purpose. The simulator is a small, content-hashed
# bundle that is rebuilt and swapped atomically on every deploy; the archive is
# ~2.5 GB of third-party material that changes only when something new is
# recovered. Putting them in the same release directory would mean copying
# gigabytes of unchanged die photographs on every front-end tweak.
#
# So the archive lives beside releases/ rather than inside it:
#
#   /var/www/6502.tinymachines.ai/
#     current -> releases/<stamp>/      the simulator, swapped per deploy
#     archive/                          public/ from the archive build
#     mirror/                           the raw mirror, holding the originals
#
# That layout is load-bearing. archive/full is a relative symlink to
# ../mirror/visual6502.org/images, so mirror/ must sit as a sibling of archive/
# for full-resolution downloads to resolve. rsync -a preserves the symlink
# itself rather than copying 2.3 GB through it.

set -euo pipefail

REPO="${REPO:-/home/bisenbek/projects/tinymachines/6502}"
SITE="${SITE:-/var/www/6502.tinymachines.ai}"

log() { printf '==> %s\n' "$*"; }

cd "$REPO"

[ -f archive/public/index.html ] || {
  echo "archive-deploy: no archive/public -- run:" >&2
  echo "  python3 archive/tools/build-archive.py" >&2; exit 1; }

# The landing page is the attribution surface. If it ever ships without the
# licence and the authors' names, we are redistributing CC BY-NC-SA material
# without complying with it, so this is a hard gate rather than a lint.
for needle in "CC BY-NC-SA 3.0" "Greg James" "Not affiliated"; do
  grep -qF "$needle" archive/public/index.html || {
    echo "archive-deploy: index.html is missing '$needle' -- refusing" >&2; exit 1; }
done

# A truncated harvest publishes an archive full of broken images, which is
# worse than not publishing: it looks complete and is not.
imgs=$(find archive/mirror/visual6502.org/images -type f 2>/dev/null | wc -l)
want=$(grep -c '^http' archive/urls/site-images.txt)   # the list carries a # header
log "die photographs: $imgs local, $want in the manifest"
[ "$imgs" -ge $(( want * 95 / 100 )) ] || {
  echo "archive-deploy: only $imgs/$want images -- finish harvest-site.sh first" >&2
  exit 1; }

log "publishing mirror ($(du -sh archive/mirror | cut -f1))"
mkdir -p "$SITE/mirror"
rsync -a --delete archive/mirror/ "$SITE/mirror/"

# Re-stamp with what is live at this moment, so the footer can say what changed
# since it. build-archive.py stamped at build time and could not know; only the
# deploy does. The anchor is read off the live copy's own stamp rather than
# remembered anywhere, the same arrangement the simulator's deploy uses.
PREV_COMMIT=""
if [ -f "$SITE/archive/build-info.json" ]; then
  PREV_COMMIT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("commitFull",""))' \
    "$SITE/archive/build-info.json" 2>/dev/null || true)
fi
log "stamping build info (previous archive deploy: ${PREV_COMMIT:-none})"
PREVIOUS_DEPLOY="$PREV_COMMIT" python3 tools/build-info.py archive/public --kind archive

log "publishing archive ($(du -shL archive/public 2>/dev/null | cut -f1))"
mkdir -p "$SITE/archive"
rsync -a --delete archive/public/ "$SITE/archive/"

# Precompress the text: the same reasoning as deploy.sh, since gzip_types is
# commented out in this box's nginx.conf and only text/html would compress at
# runtime. Images are already compressed and are skipped.
log "precompressing html/css/json"
find "$SITE/archive" -type f \( -name '*.html' -o -name '*.css' -o -name '*.json' \
  -o -name '*.js' \) -exec gzip -9 -k -f {} +

# The symlink must survive the copy and still resolve on the server.
target="$SITE/archive/full"
[ -L "$target" ] || { echo "archive-deploy: $target is not a symlink" >&2; exit 1; }
[ -d "$target/" ] || { echo "archive-deploy: $target does not resolve -- is "\
"$SITE/mirror populated?" >&2; exit 1; }

log "published"
du -sh "$SITE/archive" "$SITE/mirror" 2>/dev/null
echo "  https://6502.tinymachines.ai/archive/"
