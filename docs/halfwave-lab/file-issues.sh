#!/usr/bin/env bash
# File the reviewed issues against tinymachines/6502.
#
#   gh auth login          # once
#   ./file-issues.sh              # dry run, prints what it would do
#   ./file-issues.sh --create     # actually create them
#
# Bodies live in ./issues/. Edit them before running; nothing here is
# generated at run time.

set -euo pipefail
REPO="${REPO:-tinymachines/6502}"
DIR="$(cd "$(dirname "$0")" && pwd)/issues"
CREATE=0
[[ "${1:-}" == "--create" ]] && CREATE=1

# file | title | labels
ISSUES=(
"01-watch-bitmask-precision.md|watch bitmask silently loses precision past 53 watched names|bug,api,priority:high"
"02-enable-gzip.md|Enable gzip on /api — 6.4x on rows, 23x on objects|performance,api,priority:high,good first issue"
"03-promote-latch-fields.md|Promote idl/idb/dor/alua/alub (and abl/abh) to Observation fields|enhancement,api"
"04-tracerows-docs.md|TraceRows: state the compression measurement boundary; re-measure after gzip|documentation,api"
"05-ndjson-streaming.md|Stream long traces as chunked NDJSON (not websockets)|enhancement,api"
"06-confirm-657-fix-in-solver.md|Confirm the node 657 rail fix lives in the solver, not the serializer|bug,simulator,priority:high"
"07-export-build-stamp.md|Add a build stamp to halfshot export metadata|enhancement,export"
"08-export-ci-invariants.md|Assert halfshot export invariants in CI|testing,export"
)

for entry in "${ISSUES[@]}"; do
  IFS='|' read -r file title labels <<< "$entry"
  path="$DIR/$file"
  [[ -f "$path" ]] || { echo "missing: $path" >&2; exit 1; }
  if (( CREATE )); then
    echo "creating: $title"
    gh issue create --repo "$REPO" --title "$title" --label "$labels" --body-file "$path"
  else
    echo "[dry run] gh issue create --repo $REPO \\"
    echo "            --title \"$title\" \\"
    echo "            --label \"$labels\" \\"
    echo "            --body-file issues/$file"
  fi
done

(( CREATE )) || echo $'\nNothing created. Re-run with --create.'
