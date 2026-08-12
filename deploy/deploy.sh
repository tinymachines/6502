#!/usr/bin/env bash
#
# Build and publish 6502.tinymachines.ai.
#
# Publishes into a timestamped release directory and swaps a symlink, so a
# visitor never sees a half-updated site (a new .wasm against the old app.js
# would simply fail to boot). Keeps the last few releases for rollback.
#
# Run directly, or via `sudo systemctl start 6502-deploy`.

set -euo pipefail

REPO="${REPO:-/home/bisenbek/projects/tinymachines/6502}"
SITE="${SITE:-/var/www/6502.tinymachines.ai}"
RELEASES="$SITE/releases"
KEEP="${KEEP:-3}"

# A stray /usr/bin/rustc (1.75) shadows rustup's shim and makes cargo 1.97 fail
# on --check-cfg. Put the real toolchain first.
export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$HOME/.cargo/bin:$PATH"

log() { printf '==> %s\n' "$*"; }

cd "$REPO"

log "rustc $(rustc --version | awk '{print $2}'), $(wasm-pack --version)"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

log "building wasm"
wasm-pack build crates/v6502-wasm --target web --out-dir ../../web/pkg

log "exporting die geometry"
cargo run --quiet -p v6502-netlist --bin export-layout -- web/layout.bin

# ---------------------------------------------------------------------------
# Sanity-check the build before it can replace a working site
# ---------------------------------------------------------------------------

for f in web/index.html web/app.js web/renderer.js web/disasm.js web/style.css \
         web/layout.bin web/pkg/v6502_wasm.js web/pkg/v6502_wasm_bg.wasm; do
  [ -s "$f" ] || { echo "deploy: missing or empty $f" >&2; exit 1; }
done

# The layout blob is the one artefact whose corruption would not be obvious --
# a truncated file still "loads" and then renders nothing.
head -c 8 web/layout.bin | grep -q '^V6502LAY' || {
  echo "deploy: web/layout.bin has the wrong magic" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Stage a release
# ---------------------------------------------------------------------------

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$RELEASES/$STAMP"
log "staging $DEST"
mkdir -p "$DEST"

rsync -a --delete \
  --exclude '.gitignore' \
  --exclude 'pkg/package.json' \
  --exclude 'pkg/*.d.ts' \
  web/ "$DEST/"

# Precompress once here rather than per-request: `gzip_static on` serves these
# directly, so nginx spends no CPU and we get -9 instead of the runtime default.
log "precompressing"
find "$DEST" -type f \
  \( -name '*.js' -o -name '*.html' -o -name '*.css' -o -name '*.wasm' \
     -o -name '*.bin' -o -name '*.json' -o -name '*.svg' \) \
  -exec gzip -9 -k -f {} +

# ---------------------------------------------------------------------------
# Atomic swap
# ---------------------------------------------------------------------------

log "activating"
ln -sfn "$DEST" "$SITE/.current.new"
mv -Tf "$SITE/.current.new" "$SITE/current"

# ---------------------------------------------------------------------------
# Prune old releases
# ---------------------------------------------------------------------------

# shellcheck disable=SC2012
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  log "pruning $(basename "$old")"
  rm -rf "$old"
done

raw=$(du -sh "$DEST" | cut -f1)
log "published $STAMP ($raw on disk)"
log "layout.bin $(stat -c%s "$DEST/layout.bin" | numfmt --to=iec) -> gz $(stat -c%s "$DEST/layout.bin.gz" | numfmt --to=iec)"
log "wasm       $(stat -c%s "$DEST/pkg/v6502_wasm_bg.wasm" | numfmt --to=iec) -> gz $(stat -c%s "$DEST/pkg/v6502_wasm_bg.wasm.gz" | numfmt --to=iec)"
