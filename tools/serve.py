#!/usr/bin/env python3
"""Development server that resolves bare page paths, the way nginx does.

    python3 tools/serve.py web 8777        # then http://localhost:8777/

The site's nav links point at bare paths (`/schematic`, `/blueprint`), which the
production nginx resolves with `try_files $uri $uri.html $uri/`. Python's stock
`http.server` does not, so serving `web/` with it makes every nav link 404 --
the pages are all still there, and the site simply looks broken.

This exists so the documented development loop keeps working. It mirrors the
same three-step lookup in the same order: an exact file first, then `.html`,
then a directory index. Keeping the order identical matters more than the
implementation: a page must beat a same-named directory, which is the case that
already caused trouble in the archive.

It also sends the live site's Content Security Policy, read out of
`deploy/6502.tinymachines.ai.nginx` so the two cannot drift, on every response
except the `_*.html` development harnesses (which carry their own inline
module and would not boot under it). This was added after the tracer shipped
with its region colours written as a style ATTRIBUTE: the live policy is
`style-src 'self'` with no 'unsafe-inline', which blocks that write, and
nothing in development ever had, so every harness was green while the live
page drew every container grey. A page framed by a harness now runs under the
policy it will ship under. Violations are reported to `/__csp-report` and kept
in memory; `GET /__csp-reports` returns them (`?clear=1` empties the list),
which is what `_csp-test.html` reads.

It is a development tool and nothing else -- no caching headers, no compression,
single-threaded. Production is nginx; see `deploy/`.
"""

import http.server
import json
import os
import re
import sys
import threading
from functools import partial

NGINX_CONF = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "deploy", "6502.tinymachines.ai.nginx")


def live_csp():
    """The policy nginx sends, with frame-ancestors dropped (the harnesses frame
    every page) and a report-uri added so violations can be read back."""
    try:
        text = open(NGINX_CONF, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r'add_header\s+Content-Security-Policy\s+"([^"]+)"', text)
    if not m:
        return None
    parts = [d.strip() for d in m.group(1).split(";") if d.strip() and not d.strip().startswith("frame-ancestors")]
    return "; ".join(parts + ["report-uri /__csp-report"])


CSP = live_csp()
REPORTS = []
REPORTS_LOCK = threading.Lock()


class TryFilesHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/__csp-report":
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n)
            try:
                rep = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                rep = {"raw": body.decode("utf-8", "replace")}
            with REPORTS_LOCK:
                REPORTS.append(rep.get("csp-report", rep))
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(405)

    def do_GET(self):
        if self.path.split("?")[0] == "/__csp-reports":
            with REPORTS_LOCK:
                out = json.dumps(REPORTS).encode("utf-8")
                if "clear=1" in self.path:
                    REPORTS.clear()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        super().do_GET()

    def translate_path(self, path):
        local = super().translate_path(path)
        if os.path.isfile(local):
            return local
        # `$uri.html`, before the directory case. Only for paths that do not
        # already name a file and do not end in a slash -- a trailing slash is a
        # request for a directory, and answering it with a page would diverge
        # from what the live site does.
        if not path.endswith("/") and not os.path.isdir(local):
            candidate = local + ".html"
            if os.path.isfile(candidate):
                return candidate
        return local

    def end_headers(self):
        # Development only: never let a stale page survive an edit. Production
        # cache policy lives in the nginx config and is deliberately different.
        self.send_header("Cache-Control", "no-store")
        # The live policy on everything but the harnesses: a harness document
        # is `_name.html` (or `/_name`), and its inline module would not run
        # under script-src 'self'. The pages it frames are not exempt.
        if CSP and not re.match(r"^/(?:.*/)?_[^/]*$", self.path.split("?")[0]):
            self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> int:
    directory = sys.argv[1] if len(sys.argv) > 1 else "web"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8777
    if not os.path.isdir(directory):
        print(f"serve: {directory} is not a directory", file=sys.stderr)
        return 1
    handler = partial(TryFilesHandler, directory=directory)
    with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"serving {directory}/ at http://localhost:{port}/  (bare paths resolve)")
        if CSP:
            print(f"  with the live CSP from {os.path.relpath(NGINX_CONF)}; reports at /__csp-reports")
        else:
            print("  WARNING: no CSP found in deploy/; serving without one, unlike the live site")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
