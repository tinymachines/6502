#!/usr/bin/env bash
#
# Publish, in the right order, and check afterwards.
#
#   scripts/deploy.sh                 the site, then the API
#   scripts/deploy.sh site            just the site
#   scripts/deploy.sh archive games   other properties
#   scripts/deploy.sh all             everything
#   scripts/deploy.sh --verify        check what is live, publish nothing
#   scripts/deploy.sh --dry-run       print the steps, run none of them
#
# This ORCHESTRATES; it does not duplicate. The build itself is
# `deploy/deploy.sh`, run through its systemd unit so it gets that unit's
# environment and timeout rather than this shell's. Anything this script knew
# about building would be a second copy waiting to drift, which is the failure
# this repository keeps finding.
#
# Needs sudo for the systemctl calls. Nothing else here is privileged.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-6502.tinymachines.ai}"
cd "$REPO"

DRY=0; ONLY_VERIFY=0; TARGETS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --verify)  ONLY_VERIFY=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    all)       TARGETS=(site api archive games lab) ;;
    site|api|archive|games|lab) TARGETS+=("$a") ;;
    *) echo "unknown argument: $a (try --help)" >&2; exit 2 ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(site api)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then printf '    would run: %s\n' "$*"; else "$@"; fi; }
has()  { printf '%s\n' "${TARGETS[@]}" | grep -qx "$1"; }

FAIL=0
bad() { printf '    \033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
ok()  { printf '    ok   %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Preflight. Everything here is a warning about something that will otherwise
# be discovered halfway through, or after the fact by a reader.
# ---------------------------------------------------------------------------
preflight() {
  say "preflight"
  local head dirty
  head="$(git rev-parse --short HEAD)"
  dirty="$(git status --porcelain | wc -l)"
  note "HEAD $head on $(git rev-parse --abbrev-ref HEAD)"

  # The live build carries a `dirty` flag, and it has been true before. A
  # deploy from an uncommitted tree is legal and sometimes right; it should
  # just never be an accident.
  if [ "$dirty" != 0 ]; then
    note "WARNING: $dirty uncommitted change(s); build-info will stamp dirty:true"
  fi
  if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    local ahead; ahead="$(git rev-list --count '@{u}'..HEAD)"
    [ "$ahead" != 0 ] && note "WARNING: $ahead commit(s) not pushed"
  fi

  # deploy.sh runs check-dpc-vs-wiki.py, which SKIPS without these two. A skip
  # is not a failure, but a check you meant to run and silently did not is
  # worse than one you knew was off.
  [ -x target/release/halfwave ] \
    || note "note: no target/release/halfwave, so the wiki check will SKIP"
  [ -d archive/wiki-raw/wikitext ] \
    || note "note: no archive/wiki-raw, so the wiki check will SKIP"
  [ -f reference/mcs6500_family_programming_manual.pdf ] \
    || note "note: no reference/ manual, so the timing check will SKIP"
}

# ---------------------------------------------------------------------------
# The site, through its unit. Type=oneshot, so `start` blocks until it is done
# and its exit status is the build's.
# ---------------------------------------------------------------------------
deploy_site() {
  say "site: sudo systemctl start 6502-deploy"
  note "this builds wasm and the geometry; a cold build is a couple of minutes"
  if [ "$DRY" = 1 ]; then note "would run: sudo systemctl start 6502-deploy"; return 0; fi
  if ! sudo systemctl start 6502-deploy; then
    say "site: DEPLOY FAILED, last 60 journal lines"
    sudo journalctl -u 6502-deploy -n 60 --no-pager || true
    exit 1
  fi
  sudo journalctl -u 6502-deploy -n 25 --no-pager | sed 's/^/    /' || true
}

# The API holds groups.json and the atlas exporter's output in memory, so a
# deploy that changed either is not live until this runs.
restart_api() {
  say "api: sudo systemctl restart 6502-api"
  run sudo systemctl restart 6502-api
  [ "$DRY" = 1 ] && return 0
  for _ in $(seq 20); do
    curl -fsS "https://$HOST/api/v1/meta" >/dev/null 2>&1 && { ok "api answering"; return 0; }
    sleep 0.5
  done
  bad "api did not come back within 10s"
  sudo journalctl -u 6502-api -n 20 --no-pager | sed 's/^/    /' || true
}

deploy_archive() { say "archive"; run bash deploy/archive-deploy.sh; }
deploy_games()   { say "games";   run bash games/deploy.sh; }
deploy_lab()     { say "lab";     run bash deploy/halfwave-deploy.sh; }

# ---------------------------------------------------------------------------
# Verify what is actually live. A screenshot cannot show a wrong header and a
# 200 cannot show a stale build, so this asks for both.
# ---------------------------------------------------------------------------
verify() {
  say "verify https://$HOST"
  local head live
  head="$(git rev-parse --short HEAD)"

  live="$(curl -fsS "https://$HOST/build-info.json" 2>/dev/null \
          | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit",""))' 2>/dev/null || true)"
  if [ -z "$live" ]; then bad "could not read /build-info.json"
  elif [ "$live" = "$head" ]; then ok "live commit $live matches HEAD"
  else bad "live commit $live, HEAD $head (a deploy did not land)"; fi

  # `no-cache` on the entry points and `immutable` on hashed assets is the
  # whole caching contract; getting it backwards is invisible in a browser
  # until a deploy stops taking effect.
  local cc
  cc="$(curl -fsSI "https://$HOST/" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')"
  case "$cc" in *no-cache*) ok "/ is $cc" ;; *) bad "/ Cache-Control is '${cc:-absent}', want no-cache" ;; esac

  curl -fsSI "https://$HOST/" | tr -d '\r' | grep -qi '^content-security-policy:' \
    && ok "CSP present on /" || bad "no CSP on /"

  # The atlas count is READ FROM THE BUILD, never typed here: this script must
  # not become a second place that knows how many containers there are.
  local want got
  want="$(python3 -c 'import json;print(json.load(open("web/groups.json"))["counts"]["containers"])' 2>/dev/null || echo '')"
  got="$(curl -fsS "https://$HOST/api/v1/groups?layer=containers" 2>/dev/null \
         | python3 -c 'import json,sys;print(json.load(sys.stdin)["count"])' 2>/dev/null || true)"
  if [ -z "$want" ] || [ -z "$got" ]; then bad "could not compare container counts (want='$want' got='$got')"
  elif [ "$want" = "$got" ]; then ok "api serves $got containers, the build's own number"
  else bad "api serves $got containers, the build says $want (restart 6502-api)"; fi

  # The manifest is content-hashed by build-web.py, so there is no bare path to
  # ask for: read the href out of the page. Guessing `/manifest.webmanifest`
  # gets a 404 and reads as a broken MIME type, which is what it did first.
  local mf
  mf="$(curl -fsS "https://$HOST/" 2>/dev/null | grep -o 'href="[^"]*webmanifest"' \
        | head -1 | sed 's/^href="//;s/"$//')"
  if [ -z "$mf" ]; then bad "no manifest link on /"
  elif curl -fsSI "https://$HOST/$mf" 2>/dev/null | tr -d '\r' \
       | grep -qi 'content-type: *application/manifest+json'; then ok "manifest MIME ($mf)"
  else bad "$mf is not served as application/manifest+json"; fi

  # A hashed asset must be immutable, or the long cache is a lie.
  local asset
  asset="$(curl -fsS "https://$HOST/" 2>/dev/null \
           | grep -o 'src="[^"]*\.[0-9a-f]\{8\}\.js"' | head -1 | sed 's/^src="//;s/"$//')"
  if [ -n "$asset" ]; then
    curl -fsSI "https://$HOST/$asset" 2>/dev/null | tr -d '\r' \
      | grep -qi 'cache-control:.*immutable' \
      && ok "hashed asset is immutable ($asset)" || bad "$asset is not immutable"
  fi

  [ "$FAIL" = 0 ] && say "verify: ALL OK" || { say "verify: SOMETHING IS WRONG"; return 1; }
}

# ---------------------------------------------------------------------------
if [ "$ONLY_VERIFY" = 1 ]; then verify; exit $?; fi
preflight
has site    && deploy_site
has api     && restart_api
has archive && deploy_archive
has games   && deploy_games
has lab     && deploy_lab
if has site || has api; then
  [ "$DRY" = 1 ] && { say "dry run: nothing was published"; exit 0; }
  verify
fi
