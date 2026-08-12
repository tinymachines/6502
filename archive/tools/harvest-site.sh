#!/usr/bin/env bash
#
# Fetch the parts of visual6502.org that a crawler cannot reach.
#
# archive/urls/site-images.txt holds 548 die photographs (~2.3 GB, 41 chips)
# that the live server still serves but nothing links to: the wiki pages that
# referenced them return 500, and the directory listings are 403. They are
# effectively already lost -- present on disk, unreachable by any normal path.
# That is why this list had to be reconstructed from the Wayback index even
# though the bytes come from the origin.
#
# From the origin rather than Wayback deliberately: these are 20x microscope
# scans where resolution is the entire point, and the origin has the
# authoritative bytes. Wayback is the fallback for anything that 404s.
#
# Resumable: -N skips files already fetched with the same timestamp, and -c
# continues a partial transfer, so an interrupted run costs nothing to repeat.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${DEST:-$HERE/mirror}"
LISTS="${LISTS:-$HERE/urls/site-images.txt $HERE/urls/site-other.txt}"

mkdir -p "$DEST"

# --limit-rate is the important knob. Single-file PNGs here reach 244 MB, and
# this is a hobbyist server that has been up for fifteen years; saturating it
# would be a poor way to thank them for keeping it alive.
# shellcheck disable=SC2086
wget \
  --input-file=<(cat $LISTS | grep -v '^#') \
  --force-directories --no-host-directories --protocol-directories=off \
  --timestamping --continue \
  --wait=1 --random-wait \
  --limit-rate=1m \
  --tries=3 --timeout=120 --waitretry=15 \
  --user-agent="Mozilla/5.0 (compatible; archival mirror for preservation; contact via github.com/tinymachines/6502)" \
  --directory-prefix="$DEST/visual6502.org" \
  --append-output="$HERE/harvest-site.log" || true

echo "== site harvest =="
du -sh "$DEST"
find "$DEST" -type f | wc -l
