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
#   scripts/deploy.sh --direct        skip systemd, run deploy/deploy.sh here
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
SITE_DIR="${SITE_DIR:-/var/www/6502.tinymachines.ai}"
SUDO_OK=0
cd "$REPO"

DRY=0; ONLY_VERIFY=0; DIRECT=0; TARGETS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --verify)  ONLY_VERIFY=1 ;;
    --direct)  DIRECT=1 ;;
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

  # The one privileged thing here is systemctl. Probe it rather than
  # discovering it as a password prompt with no terminal to type into, which
  # is a hang that looks exactly like a slow build.
  if sudo -n true 2>/dev/null; then
    SUDO_OK=1; note "sudo works without a password"
  else
    SUDO_OK=0
    note "NOTE: sudo needs a password here, and this may have no terminal."
    note "      The site publishes fine without it: $SITE_DIR is owned by"
    note "      $(whoami), which is the user the unit runs as anyway. Falling"
    note "      back to running deploy/deploy.sh directly."
    note "      The API restart DOES need sudo and will be skipped; run"
    note "      'sudo systemctl restart 6502-api' yourself afterwards."
    DIRECT=1
  fi
}

# ---------------------------------------------------------------------------
# The site, through its unit. Type=oneshot, so `start` blocks until it is done
# and its exit status is the build's.
# ---------------------------------------------------------------------------
deploy_site() {
  if [ "$DIRECT" = 1 ]; then
    say "site: deploy/deploy.sh (direct, no systemd)"
    # Worth knowing which one ran. The unit is the environment production
    # actually uses -- a minimal PATH, PrivateTmp, a 1800s timeout -- and this
    # shell is richer than that. A bug that only bites under systemd (the
    # node-v12 trap this repo has already paid for) can hide here.
    note "NOTE: a richer environment than the unit's, so an env-dependent"
    note "      failure could hide. Prefer the unit when sudo is available."
    if [ "$DRY" = 1 ]; then note "would run: deploy/deploy.sh"; return 0; fi
    deploy/deploy.sh || { say "site: DEPLOY FAILED"; exit 1; }
    return 0
  fi
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
  if [ "$SUDO_OK" != 1 ] && [ "$DRY" != 1 ]; then
    say "api: SKIPPED, needs sudo"
    note "run: sudo systemctl restart 6502-api"
    note "until then the API keeps serving the groups.json it started with"
    return 0
  fi
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
# The lab installs as www-data, so unlike archive and games it needs root:
# without sudo it dies on "cannot remove index.html: Permission denied"
# AFTER its two self-contained checks have passed, which reads like the
# page was rejected rather than the write.
deploy_lab()     { say "lab";     run sudo bash deploy/halfwave-deploy.sh; }

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
  case "$cc" in *no-cache*) ok "/ (the forward) is $cc" ;; *) bad "/ Cache-Control is '${cc:-absent}', want no-cache" ;; esac

  curl -fsSI "https://$HOST/" | tr -d '\r' | grep -qi '^content-security-policy:' \
    && ok "CSP present on / (the forward)" || bad "no CSP on /"

  # The atlas count is READ FROM THE BUILD, never typed here: this script must
  # not become a second place that knows how many containers there are.
  local want got
  want="$(python3 -c 'import json;print(json.load(open("web/groups.json"))["counts"]["containers"])' 2>/dev/null || echo '')"
  got="$(curl -fsS "https://$HOST/api/v1/groups?layer=containers" 2>/dev/null \
         | python3 -c 'import json,sys;print(json.load(sys.stdin)["count"])' 2>/dev/null || true)"
  if [ -z "$want" ] || [ -z "$got" ]; then bad "could not compare container counts (want='$want' got='$got')"
  elif [ "$want" = "$got" ]; then ok "api serves $got containers, the build's own number"
  else bad "api serves $got containers, the build says $want (restart 6502-api)"; fi

  # The pages forward to the apex now, so `/` is a 301 with no body and the
  # hashed names cannot be scraped out of it. They come from the build's own
  # asset manifest instead, which is better anyway: this checks what was
  # BUILT rather than what some page happened to link.
  #
  # Every capture below ends in `|| true`. Without it a `grep` that matches
  # nothing exits 1 and `set -e` kills this function mid-run: when the forward
  # first went live, verify printed four lines and stopped, with no ALL OK and
  # no SOMETHING IS WRONG, which reads exactly like a pass to anyone skimming.
  local am mf asset
  am=dist/asset-manifest.json
  if [ ! -f "$am" ]; then
    note "no $am; skipping the hashed-asset checks (run a build to get them)"
  else
    mf="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(next((v for v in d.values() if v.endswith(".webmanifest")), ""))' "$am" 2>/dev/null || true)"
    asset="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("app.js",""))' "$am" 2>/dev/null || true)"

    if [ -z "$mf" ]; then bad "no webmanifest in $am"
    elif curl -fsSI "https://$HOST/$mf" 2>/dev/null | tr -d '\r' \
         | grep -qi 'content-type: *application/manifest+json'; then ok "manifest MIME ($mf)"
    else bad "$mf is not served as application/manifest+json"; fi

    # A hashed asset must be immutable, or the long cache is a lie.
    if [ -z "$asset" ]; then bad "no app.js in $am"
    elif curl -fsSI "https://$HOST/$asset" 2>/dev/null | tr -d '\r' \
         | grep -qi 'cache-control:.*immutable'; then ok "hashed asset is immutable ($asset)"
    else bad "$asset is not immutable"; fi
  fi

  # The forward itself, pinned. The apex site redirects this origin's pages to
  # tinymachines.ai/6502/, configured in deploy/6502.tinymachines.ai.nginx. A
  # copy-over from deploy/ to /etc that predates the forward would silently
  # undo it, and the only symptom would be the site quietly working the old
  # way, so it is asserted rather than assumed.
  local fwd
  fwd="$(curl -sI "https://$HOST/" | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}' || true)"
  case "$fwd" in
    https://tinymachines.ai/6502/*) ok "/ forwards to the apex ($fwd)" ;;
    "") bad "/ does not forward; deploy/*.nginx may have overwritten the forward" ;;
    *) bad "/ forwards to '$fwd', not the apex" ;;
  esac

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
