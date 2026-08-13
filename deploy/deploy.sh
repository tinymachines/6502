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

log "deriving the blueprint"
cargo run --quiet -p v6502-netlist --bin export-blueprint -- web/blueprint.json

# ---------------------------------------------------------------------------
# Sanity-check the build before it can replace a working site
# ---------------------------------------------------------------------------

for f in web/index.html web/app.js web/renderer.js web/disasm.js web/style.css \
         web/programs.js web/blueprint.html web/blueprint.js web/blueprint.json \
         web/layout.bin web/pkg/v6502_wasm.js web/pkg/v6502_wasm_bg.wasm; do
  [ -s "$f" ] || { echo "deploy: missing or empty $f" >&2; exit 1; }
done

# The layout blob is the one artefact whose corruption would not be obvious --
# a truncated file still "loads" and then renders nothing.
head -c 8 web/layout.bin | grep -q '^V6502LAY' || {
  echo "deploy: web/layout.bin has the wrong magic" >&2; exit 1; }

# The blueprint is derived, so an empty derivation is a silent failure: the page
# would load and draw nothing at all. Insist it actually found the datapath.
python3 - <<'PY' || exit 1
import json, sys
bp = json.load(open("web/blueprint.json"))
if len(bp["units"]) < 12 or len(bp["links"]) < 16:
    sys.exit(f"deploy: blueprint derived only {len(bp['units'])} units / "
             f"{len(bp['links'])} links -- the extraction has broken")
if bp["coverage"]["transistorsDrawn"] < 100:
    sys.exit("deploy: blueprint covers almost no transistors")
PY

# ---------------------------------------------------------------------------
# Content-hash everything and emit the service worker
# ---------------------------------------------------------------------------

# Git metadata for the version footer. Must run before the hashing step, which
# copies build-info.json into dist/ -- and it reads the working tree, so it also
# records whether this deploy came from uncommitted changes.
log "stamping build info"
python3 tools/build-info.py web --kind simulator

log "hashing assets"
python3 tools/build-web.py web dist

for f in dist/index.html dist/sw.js dist/asset-manifest.json; do
  [ -s "$f" ] || { echo "deploy: build produced no $f" >&2; exit 1; }
done

# One wasm, one layout blob: more than one means a stale artefact survived a
# rebuild and the worker would precache both.
for pat in 'dist/pkg/v6502_wasm_bg.*.wasm' 'dist/layout.*.bin'; do
  # shellcheck disable=SC2086
  n=$(ls -1 $pat 2>/dev/null | wc -l)
  [ "$n" = 1 ] || { echo "deploy: expected exactly one $pat, found $n" >&2; exit 1; }
done

# Every asset the worker promises to precache must actually exist, or install
# fails and the app silently loses offline support.
python3 - <<'PY' || exit 1
import json, re, sys, pathlib
sw = pathlib.Path("dist/sw.js").read_text()
listed = json.loads(re.search(r"const PRECACHE = (\[.*?\]);", sw, re.S).group(1))
missing = [p for p in listed if p != "./" and not (pathlib.Path("dist") / p[2:]).exists()]
if missing:
    print(f"deploy: sw.js precaches missing files: {missing}", file=sys.stderr)
    sys.exit(1)
print(f"  precache list verified: {len(listed)} entries")
PY

# ---------------------------------------------------------------------------
# Stage a release
# ---------------------------------------------------------------------------

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$RELEASES/$STAMP"
log "staging $DEST"
mkdir -p "$DEST"

# dist/ contains exactly what should be served -- build-web.py emits nothing
# else, so there is no exclude list to keep in sync.
rsync -a --delete dist/ "$DEST/"

# Precompress once here rather than per-request: `gzip_static on` serves these
# directly, so nginx spends no CPU and we get -9 instead of the runtime default.
log "precompressing"
find "$DEST" -type f \
  \( -name '*.js' -o -name '*.html' -o -name '*.css' -o -name '*.wasm' \
     -o -name '*.bin' -o -name '*.json' -o -name '*.svg' -o -name '*.webmanifest' \) \
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
for f in "$DEST"/layout.*.bin "$DEST"/pkg/v6502_wasm_bg.*.wasm; do
  [ -f "$f" ] || continue
  log "$(basename "$f") $(stat -c%s "$f" | numfmt --to=iec) -> gz $(stat -c%s "$f.gz" | numfmt --to=iec)"
done
