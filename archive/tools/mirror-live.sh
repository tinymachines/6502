#!/usr/bin/env bash
#
# Mirror what visual6502.org still serves, into archive/mirror/.
#
# The main site is alive; only the wiki is down (HTTP 500). So this captures the
# live half and the Wayback lists cover the dead half.
#
# Deliberately polite. This is a fragile ~15-year-old server hosting an
# irreplaceable archive, and hammering it is the one way this exercise could do
# real harm: --wait/--random-wait between requests, one connection, capped rate.
# A slow mirror costs us an afternoon; a fast one could take the site down for
# everybody, which is precisely the outcome we are trying to prevent.
#
# robots.txt is respected (wget's default when recursing). That excludes
# /JSSim/{segdefs,transdefs,wires}.js and /stage/. Losing nothing: those three
# files are the die data, which we already hold canonically as the
# extern/visual6502 submodule pinned to the upstream git repo.
#
# No --convert-links: this stays a byte-faithful mirror. Rewriting for local
# browsing is a presentation concern and is done downstream, on a copy, so the
# pristine capture is always available to re-derive from.

set -euo pipefail

DEST="${DEST:-$(cd "$(dirname "$0")/.." && pwd)/mirror}"
HOST="${HOST:-visual6502.org}"

mkdir -p "$DEST"

# --mirror          = -r -N -l inf --no-remove-listing
# --page-requisites = css/js/images needed to render each page
# -N                = only re-fetch when newer, so re-runs are cheap and gentle
wget \
  --mirror \
  --page-requisites \
  --no-parent \
  --domains="$HOST,www.$HOST" \
  --wait=1 --random-wait \
  --limit-rate=500k \
  --tries=3 --timeout=60 --waitretry=10 \
  --user-agent="Mozilla/5.0 (compatible; archival mirror for preservation; contact via github.com/tinymachines/6502)" \
  --directory-prefix="$DEST" \
  --append-output="$DEST/../mirror.log" \
  "http://$HOST/" || true   # wget exits nonzero on any 404 in a large crawl

echo "== mirrored =="
du -sh "$DEST"
find "$DEST" -type f | wc -l
