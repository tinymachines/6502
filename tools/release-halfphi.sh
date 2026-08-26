#!/usr/bin/env bash
#
# Release halfphi: one version, two repositories, one digest.
#
#     tools/release-halfphi.sh 0.1.1            # do it
#     tools/release-halfphi.sh 0.1.1 --dry-run  # every gate, no writes
#
# halfphi is developed here (crates/halfphi, beside the chip it was extracted
# from and against the three chips its test loads) and published on its own
# at github.com/tinymachines/halfphi, where it can be MIT because it embeds
# no die data. tools/check-halfphi.mjs keeps the five shared files identical;
# this makes a release out of that: the same version in both Cargo.tomls, the
# changelog dated, a commit in each repository, and a tag on each at the same
# shared-file digest, so "halfphi 0.1.1" names one set of bytes wherever it
# is read from.
#
#   halfphi     tag  v<X>          the published crate's own release
#   6502        tag  halfphi-v<X>  the commit the crate was cut from, here
#
# Both tag messages carry the sha256 over the five shared files (the digest
# tinymachines/public's board-engine.py records), so a tag can be checked
# against the bytes it claims to name rather than trusted.
#
# It refuses, in order: a version that is not X.Y.Z or is not newer than the
# one in Cargo.toml; a dirty tree in either repository; a difference between
# the shared files; an empty [Unreleased] section (a release with nothing to
# say is a tag with no reason); and any failing gate. The gates are the ones
# the mirror's CI runs (fmt, clippy -D warnings, test with the chips
# required, doc) plus this workspace's halfphi test, and they run HERE, on the
# bytes being tagged: a green badge on the mirror describes the mirror's last
# push, not this release.
#
# Nothing is published to crates.io. That is a separate decision (it would
# make the crate's API a promise to strangers) and nothing here needs it: a
# git tag is what the 6502 project and the site depend on.

set -euo pipefail

export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$HOME/.cargo/bin:$PATH"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERE="$ROOT/crates/halfphi"
THERE="${HALFPHI:-$ROOT/../halfphi}"
DRY=
VERSION=
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -*) echo "release-halfphi: unknown option $a" >&2; exit 2 ;;
    *) VERSION="$a" ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: tools/release-halfphi.sh X.Y.Z [--dry-run]" >&2; exit 2; }

log() { printf '==> %s\n' "$*"; }
refuse() { echo "release-halfphi: $*" >&2; exit 1; }

# --- the version -----------------------------------------------------------
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "'$VERSION' is not X.Y.Z"
current=$(sed -n 's/^version = "\(.*\)"/\1/p' "$HERE/Cargo.toml" | head -1)
newer=$(printf '%s\n%s\n' "$current" "$VERSION" | sort -V | tail -1)
[ "$newer" = "$VERSION" ] && [ "$VERSION" != "$current" ] || refuse "$VERSION is not newer than $current"
log "halfphi $current -> $VERSION"

# --- the two trees ---------------------------------------------------------
[ -f "$THERE/src/engine.rs" ] || refuse "no standalone halfphi at $THERE (HALFPHI=/path to name it)"
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || refuse "this tree has uncommitted changes"
[ -z "$(git -C "$THERE" status --porcelain --untracked-files=no)" ] || refuse "$THERE has uncommitted changes"
git -C "$THERE" tag -l | grep -qx "v$VERSION" && refuse "$THERE already has tag v$VERSION"
git -C "$ROOT" tag -l | grep -qx "halfphi-v$VERSION" && refuse "this tree already has tag halfphi-v$VERSION"

log "the shared files"
HALFPHI="$THERE" REQUIRE_HALFPHI=1 node "$ROOT/tools/check-halfphi.mjs"

# --- the changelog has something to say -----------------------------------
CHANGELOG="$THERE/CHANGELOG.md"
unreleased=$(awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f' "$CHANGELOG" | grep -v '^\s*$' || true)
[ -n "$unreleased" ] || refuse "$CHANGELOG has an empty [Unreleased] section; a release says what changed"

# --- the digest: the same bytes, named once --------------------------------
digest() {
  python3 - "$1" <<'PY'
import hashlib, sys
from pathlib import Path
root = Path(sys.argv[1])
h = hashlib.sha256()
for rel in ["src/lib.rs", "src/source.rs", "src/netlist.rs", "src/engine.rs", "tests/chips.rs"]:
    h.update(rel.encode() + b"\0" + (root / rel).read_bytes() + b"\0")
print(h.hexdigest())
PY
}
DIGEST=$(digest "$HERE")
[ "$DIGEST" = "$(digest "$THERE")" ] || refuse "the shared-file digests differ after a parity pass; that should be impossible"
log "shared-file digest $DIGEST"

# --- the gates, on the bytes being tagged ---------------------------------
# Each test run goes to a file and is then read, not piped into grep -q: a
# grep that exits on its match sends SIGPIPE to what feeds it, and under
# pipefail that race reads as a failed gate. It did, on the first dry run.
three_chips() {
  local out; out=$(mktemp)
  ( cd "$1" && HALFPHI_REQUIRE_CHIPS=1 cargo test -q "${@:2}" >"$out" 2>&1 ) || { cat "$out" >&2; rm -f "$out"; return 1; }
  grep -q 'test result: ok. 3 passed' "$out" || { cat "$out" >&2; rm -f "$out"; return 1; }
  rm -f "$out"
}
log "gates in $THERE (what its CI runs)"
( cd "$THERE" && cargo fmt --all -- --check ) || refuse "fmt in $THERE"
( cd "$THERE" && cargo clippy -q --all-targets -- -D warnings ) || refuse "clippy in $THERE"
three_chips "$THERE" || refuse "the three-chip test in $THERE"
( cd "$THERE" && cargo doc -q --no-deps ) || refuse "cargo doc in $THERE"
log "gates here"
three_chips "$ROOT" -p halfphi || refuse "crates/halfphi's test here"

if [ -n "$DRY" ]; then
  log "dry run: every gate passed; nothing written. Would tag halfphi v$VERSION and 6502 halfphi-v$VERSION at $DIGEST"
  exit 0
fi

# --- write: versions, changelog --------------------------------------------
DATE=$(date -u +%Y-%m-%d)
sed -i "0,/^version = \"$current\"/s//version = \"$VERSION\"/" "$HERE/Cargo.toml" "$THERE/Cargo.toml"
python3 - "$CHANGELOG" "$VERSION" "$DATE" <<'PY'
import re, sys
from pathlib import Path
p, v, d = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
s = p.read_text()
s = s.replace("## [Unreleased]\n", f"## [Unreleased]\n\n## [{v}] - {d}\n", 1)
s = re.sub(r"^\[Unreleased\]: (.*)/compare/v[^.]+\.[^.]+\.[^.]+\.\.\.HEAD$",
           lambda m: f"[Unreleased]: {m.group(1)}/compare/v{v}...HEAD\n[{v}]: {m.group(1)}/releases/tag/v{v}",
           s, count=1, flags=re.M)
p.write_text(s)
PY
# The lockfiles carry the crate's own version; a build refreshes them.
( cd "$THERE" && cargo build -q )
( cd "$ROOT" && cargo build -q -p halfphi )

# --- commit and tag, both sides --------------------------------------------
MSG="halfphi $VERSION

Shared-file digest: $DIGEST"
# `add -u` with paths: the standalone ignores its Cargo.lock (a library's
# lockfile is not published), and a plain `git add` of an ignored file is an
# error that stopped the first release between the bump and the commit.
( cd "$THERE" && git add -u Cargo.toml Cargo.lock CHANGELOG.md \
  && git commit -q -m "$MSG" \
  && git tag -a "v$VERSION" -m "$MSG" )
( cd "$ROOT" && git add -u crates/halfphi/Cargo.toml Cargo.lock \
  && git commit -q -m "$MSG

Cut from crates/halfphi; published as tinymachines/halfphi v$VERSION." \
  && git tag -a "halfphi-v$VERSION" -m "$MSG" )

log "pushing"
( cd "$THERE" && git push -q origin HEAD "v$VERSION" )
( cd "$ROOT" && git push -q origin HEAD "halfphi-v$VERSION" )

log "released halfphi $VERSION: halfphi@$(git -C "$THERE" rev-parse --short HEAD) v$VERSION, 6502@$(git -C "$ROOT" rev-parse --short HEAD) halfphi-v$VERSION, digest $DIGEST"
