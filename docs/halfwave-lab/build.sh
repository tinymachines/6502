#!/usr/bin/env bash
# Inline src/demo.json into src/lab.template.html -> halfwave-lab.html
#
#   ./build.sh                 # rebuild from the current demo.json
#   ./build.sh --recapture     # refresh demo.json from the API first
set -euo pipefail
cd "$(dirname "$0")"
[[ "${1:-}" == "--recapture" ]] && python3 src/capture-demo.py
python3 - <<'PY'
tpl = open("src/lab.template.html").read()
demo = open("src/demo.json").read()
assert "__DEMO__" in tpl, "template has no __DEMO__ placeholder"
open("halfwave-lab.html", "w").write(tpl.replace("__DEMO__", demo))
import os
print(f"built halfwave-lab.html ({os.path.getsize('halfwave-lab.html'):,} bytes)")
PY
