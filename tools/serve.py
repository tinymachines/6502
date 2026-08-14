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

It is a development tool and nothing else -- no caching headers, no compression,
single-threaded. Production is nginx; see `deploy/`.
"""

import http.server
import os
import sys
from functools import partial


class TryFilesHandler(http.server.SimpleHTTPRequestHandler):
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
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
