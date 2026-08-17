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

log "deriving the functional blocks"
cargo run --quiet -p v6502-netlist --bin export-blocks -- web/blocks.json

log "recognising the gate-level schematic"
cargo run --quiet -p v6502-netlist --bin export-schematic -- web/schematic.json

log "measuring the decode PLA"
cargo run --release --quiet -p v6502-sim --bin export-decode -- web/decode.json

log "timing every instruction"
cargo run --release --quiet -p v6502-sim --bin export-timing -- web/timing.json

# ---------------------------------------------------------------------------
# Sanity-check the build before it can replace a working site
# ---------------------------------------------------------------------------

for f in web/index.html web/app.js web/renderer.js web/disasm.js web/style.css \
         web/programs.js web/asm.js web/program-nav.js \
         web/programs.html web/programs-page.js \
         web/blueprint.html web/blueprint.js web/blueprint.json \
         web/exploded.html web/exploded.js web/exploded-gl.js web/blocks.json \
         web/schematic.html web/schematic.js web/schematic.json \
         web/sch-draw.js web/block.html web/block.js web/block-notes.js \
         web/trace.html web/trace.js web/primer.html web/primer.js web/demos.js \
         web/decode.html web/decode.js web/decode.json \
         web/timing.html web/timing.js web/timing.json \
         web/layout.bin web/pkg/v6502_wasm.js web/pkg/v6502_wasm_bg.wasm; do
  [ -s "$f" ] || { echo "deploy: missing or empty $f" >&2; exit 1; }
done

# The programs are assembled at load rather than typed, which moves the risk
# rather than removing it: a bad edit to the assembler changes every program at
# once, silently, and every page still boots. This refuses to publish unless the
# three that predate the rewrite still assemble to the bytes they shipped with.
# Which node, though. This runs under systemd, whose PATH is not the interactive
# shell's: `node` there is /usr/bin/node, v12, which cannot parse the `??` in
# web/programs.js and fails with a bare SyntaxError pointing at a line that is
# perfectly good JavaScript. Exactly the same trap as the stray /usr/bin/rustc
# documented in CLAUDE.md, and it cost a deploy to find.
#
# The alternative -- writing the site's JavaScript down to whatever node the
# host happens to ship -- would constrain browser code forever for the sake of
# one check script, and nothing would ever say so out loud.
pick_node() {
  local candidate version major
  for candidate in "${NODE:-}" node \
      $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -Vr); do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    version=$("$candidate" --version 2>/dev/null) || continue
    major=${version#v}; major=${major%%.*}
    case "$major" in ''|*[!0-9]*) continue ;; esac
    [ "$major" -ge 16 ] && { command -v "$candidate"; return 0; }
  done
  return 1
}
NODE_BIN=$(pick_node) || {
  echo "deploy: need node >= 16 to check that the programs assemble." >&2
  echo "        found: $(command -v node >/dev/null && node --version || echo none)" >&2
  echo "        systemd's PATH is not your shell's -- set NODE=/path/to/node." >&2
  exit 1
}
"$NODE_BIN" tools/check-programs.mjs || exit 1

# The layout blob is the one artefact whose corruption would not be obvious --
# a truncated file still "loads" and then renders nothing.
head -c 8 web/layout.bin | grep -q '^V6502LAY' || {
  echo "deploy: web/layout.bin has the wrong magic" >&2; exit 1; }

# The blueprint is derived, so an empty derivation is a silent failure: the page
# would load and draw nothing at all. Insist it actually found the datapath.
python3 - <<'PY' || exit 1
import json, re, sys
bp = json.load(open("web/blueprint.json"))
if len(bp["units"]) < 12 or len(bp["links"]) < 16:
    sys.exit(f"deploy: blueprint derived only {len(bp['units'])} units / "
             f"{len(bp['links'])} links -- the extraction has broken")
if bp["coverage"]["transistorsDrawn"] < 100:
    sys.exit("deploy: blueprint covers almost no transistors")

# The blocks are derived too, and the failure mode is the same shape: a rule
# table that stops matching still produces a well-formed file, in which every
# node has quietly fallen into "unclassified" and the exploded view has nothing
# to pull apart. Insist the seeds still land.
blk = json.load(open("web/blocks.json"))
if len(blk["blocks"]) < 12:
    sys.exit(f"deploy: only {len(blk['blocks'])} functional blocks derived")
for arr, want in [("nodeBlock", 1725), ("nodeDrives", 1725),
                  ("transistorBlock", 3510), ("transistorGate", 3510)]:
    if len(blk[arr]) != want:
        sys.exit(f"deploy: blocks.json {arr} has {len(blk[arr])} entries, expected {want}")
cov = blk["coverage"]
logic = next((b for b in blk["blocks"] if b["half"] == "logic"), None)
if logic is None:
    sys.exit("deploy: the static logic block is missing from blocks.json")
functional = cov["transistorsPlaced"] - logic["transistors"]
if functional < 2000:
    sys.exit(f"deploy: only {functional} transistors reach a functional block -- "
             "the name rules have drifted")
# Every functional block needs a page, and the slug table in block-notes.js is
# the one authored thing standing between blocks.rs and a 404. A block added or
# renamed there produces a well-formed blocks.json and a menu entry pointing at
# nothing, which is exactly the failure the archive exists to be embarrassed
# about. Read the slugs out of the JS rather than duplicating them here.
notes = open("web/block-notes.js").read()
slugs = set(re.findall(r"^  '?([A-Za-z][A-Za-z &/]*)'?:\s*'([a-z-]+)',", notes, re.M))
have = {name for name, _ in slugs}
for b in blk["blocks"]:
    if b["half"] in ("unknown", "logic"):
        continue
    if b["name"] not in have:
        sys.exit(f"deploy: block-notes.js has no slug for {b['name']!r}, so it has no page")
if len({s for _, s in slugs}) != len(slugs):
    sys.exit("deploy: two functional blocks share a slug, so one of their pages is unreachable")

# The static logic is identified by an electrical signature, not by name, so it
# must never be seeded. If it ever is, a name rule has started matching gates.
if logic["seeded"] != 0:
    sys.exit(f"deploy: {logic['seeded']} static-logic nodes were name-seeded")
# It should be roughly the non-pass-transistor share of the chip. A collapse here
# means the pullup/vss signature stopped matching and the block emptied out.
if not (0.20 <= logic["transistors"] / cov["transistors"] <= 0.40):
    sys.exit(f"deploy: static logic is {logic['transistors']} of {cov['transistors']} "
             "transistors, which is outside the plausible range for static gates")
# Most of what lands in a functional block must be *named* rather than inferred.
# Static logic is excluded: the die names none of it, by design.
if cov["nodesNamed"] * 2 < cov["nodesPlaced"] - logic["nodes"]:
    sys.exit(f"deploy: only {cov['nodesNamed']} named of "
             f"{cov['nodesPlaced'] - logic['nodes']} in functional blocks; "
             "growth is doing the work")
# ...and a residue must still be declared. A run that accounted for everything
# would mean the honesty check on the page now shows an empty set.
if blk["blocks"][0]["nodes"] < 1:
    sys.exit("deploy: nothing is unaccounted for, which means the page's honesty "
             "check now shows an empty set")
# The residue is understood -- two inert structures -- and the page says so by
# name. If it grows, something else has fallen in and that prose is now wrong.
if blk["blocks"][0]["nodes"] > 20:
    sys.exit(f"deploy: {blk['blocks'][0]['nodes']} nodes are unaccounted for, but the "
             "page describes the residue as two inert structures")
if any(b["nodes"] == 0 for b in blk["blocks"][1:]):
    empty = [b["name"] for b in blk["blocks"][1:] if b["nodes"] == 0]
    sys.exit(f"deploy: these blocks came out empty: {empty}")
# The drives attribution must never be able to position anything, so it may only
# ever be set on static logic.
drives = blk["nodeDrives"]
nodeblk = blk["nodeBlock"]
stray = [n for n, d in enumerate(drives) if d and (nodeblk[n] & 0x7f) != logic["id"]]
if stray:
    sys.exit(f"deploy: {len(stray)} non-logic nodes carry a drives attribution")

# The schematic is recognised, not drawn, and the failure mode is a recogniser
# that stops matching: it still emits a well-formed file, with every gate quietly
# missing and every signal a dead end.
sch = json.load(open("web/schematic.json"))
sc = sch["counts"]
if sc["absorbed"] + sc["switches"] != sc["transistors"]:
    sys.exit(f"deploy: schematic accounts for {sc['absorbed']}+{sc['switches']} of "
             f"{sc['transistors']} transistors")
if sc["gates"] < 1000 or len(sch["gates"]) != sc["gates"]:
    sys.exit(f"deploy: {sc['gates']} gates recognised -- the reduction has broken")
# The precharged family holds every control line. Losing it turns the most
# interesting signals on the chip back into dead ends, and the page says so.
if sc["dynamic"] < 100:
    sys.exit(f"deploy: only {sc['dynamic']} precharged gates; the control lines "
             "will render as dead ends")
if sc["unresolved"] > 5:
    sys.exit(f"deploy: {sc['unresolved']} nodes failed to resolve")
if len(sch["names"]) != 1725:
    sys.exit("deploy: schematic.json name table is the wrong length for this die")

# The decode table is measured by running the chip, so a broken run yields a
# well-formed file full of empty results rather than an error. Insist that the
# product terms were actually observed firing.
dec = json.load(open("web/decode.json"))
if len(dec["rows"]) < 100 or len(dec["opcodes"]) != 256:
    sys.exit(f"deploy: decode table has {len(dec['rows'])} terms / "
             f"{len(dec['opcodes'])} opcodes")
fired = {t for op in dec["opcodes"] for t in op["any"]}
if len(fired) < len(dec["rows"]):
    sys.exit(f"deploy: only {len(fired)} of {len(dec['rows'])} product terms "
             f"were observed firing -- the measurement run is broken")

# Term-to-line edges are fitted against the measurement and only kept above a
# threshold. Every shipped edge must still clear it, and the lines that did not
# fit must be declared rather than dropped.
links, unresolved = dec["links"], dec["unresolvedLines"]
if len(links) + len(unresolved) != len(dec["outputs"]):
    sys.exit("deploy: control lines are neither fitted nor declared unresolved")
weak = [l for l in links if l["explained"] < 0.95]
if weak:
    sys.exit(f"deploy: {len(weak)} term-to-line edges are below the "
             f"verification threshold")
if not any(l["mode"] == "override" for l in links):
    sys.exit("deploy: no override edges -- the hold lines have been lost")

# Timing: the cycle counts are measured, so a broken run shows up as everything
# jamming or as a suspiciously uniform table rather than as an error.
tim = json.load(open("web/timing.json"))
jams = [o for o in tim["opcodes"] if o["jam"]]
timed = [o for o in tim["opcodes"] if not o["jam"]]
if len(tim["opcodes"]) != 256 or len(timed) < 200:
    sys.exit(f"deploy: only {len(timed)} of 256 opcodes were timed")
if len(jams) != 12:
    sys.exit(f"deploy: {len(jams)} opcodes never finish; the 6502 has exactly 12")
if {o["cycles"] for o in timed} < {2, 3, 4, 5, 6, 7}:
    sys.exit("deploy: the measured cycle counts do not span the expected range")
if len(tim.get("terms", [])) < 100:
    sys.exit("deploy: timing.json carries no term names")
ends = [o for o in timed
        if any((tim["terms"][i] or "").startswith("op-T0-") for i in o["arrived"])]
if len(ends) < 120:
    sys.exit(f"deploy: only {len(ends)} instructions end on a T0 term -- "
             f"the arriving-term measurement has broken")
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
