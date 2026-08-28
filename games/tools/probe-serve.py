#!/usr/bin/env python3
"""Serve games/ for _probe.html, optionally holding one file back.

    python3 games/tools/probe-serve.py 8794
    python3 games/tools/probe-serve.py 8794 --delay art/tiles.chr=1500

The delay exists for one test. art/tiles.chr and a linked cartridge are two
fetches the console starts together, and on the live site their responses
land about two milliseconds apart (measured by the apex session over three
runs), so which one wins is a coin toss. The probe's delayed-sheet case needs
the sheet to lose, every time, and a server that holds it back is the only
way to arrange that from outside the page. `python3 -m http.server` cannot,
which is the only reason this file exists.

Threaded on purpose: a held-back response must not hold back the cartridge it
is racing, or the delay would order nothing.
"""
import argparse
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("port", type=int)
ap.add_argument("--delay", action="append", default=[], metavar="PATH=MS",
                help="hold this path's response back by this many milliseconds")
args = ap.parse_args()

delays = {}
for d in args.delay:
    path, ms = d.rsplit("=", 1)
    delays["/" + path.lstrip("/")] = int(ms) / 1000

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in delays:
            time.sleep(delays[path])
        super().do_GET()

    def log_message(self, *a):
        pass


print(f"serving {ROOT} on {args.port}" + (f", delaying {delays}" if delays else ""), flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
