#!/usr/bin/env python3
"""Fetch the dead visual6502 wiki out of the Wayback Machine.

    python3 archive/tools/harvest-wiki.py            # everything, resumable
    python3 archive/tools/harvest-wiki.py --only wikitext

Reads the lists produced by wayback-index.py and writes:

    archive/wiki-raw/wikitext/<Title>.wiki    extracted page source
    archive/wiki-raw/rendered/<Title>.html    the archived rendering
    archive/wiki-raw/images/<path>            uploaded images

The wikitext is pulled out of the <textarea> of an archived `action=edit` page.
That is the whole reason this is worth doing: rendered HTML preserves what the
wiki looked like, but wikitext preserves what it *was* -- re-renderable,
diffable, convertible, and free of MediaWiki's dead chrome.

Resumable by design: an existing non-empty output file is skipped, so a run
interrupted by a Wayback rate-limit can simply be repeated. Wayback throttles
hard and returns 429 under load, so failures are expected rather than
exceptional -- they are retried with backoff and then recorded in
harvest-wiki-failed.txt for a later pass instead of aborting the run.
"""

import argparse
import html
import re
import sys
import time
import urllib.error
import urllib.parse as up
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
URLS = ROOT / "urls"
OUT = ROOT / "wiki-raw"
UA = ("Mozilla/5.0 (compatible; archival retrieval for preservation; "
      "contact via github.com/tinymachines/6502)")

# MediaWiki puts page source in this textarea on an edit form.
TEXTAREA = re.compile(
    r'<textarea[^>]*\bname=["\']wpTextbox1["\'][^>]*>(.*?)</textarea>', re.S | re.I)
TEXTAREA_ANY = re.compile(r"<textarea[^>]*>(.*?)</textarea>", re.S | re.I)
# A capture of MediaWiki's "you may view the source but not edit" page.
DENIED = re.compile(r"do not have permission to edit|Login required|"
                    r"view and copy the source", re.I)


def get(url: str, *, tries: int = 4) -> bytes | None:
    """Fetch with backoff. Wayback 429s freely; that is normal, not fatal."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 502, 504) and attempt < tries - 1:
                time.sleep(10 * (attempt + 1))
                continue
            print(f"    HTTP {e.code}", file=sys.stderr)
            return None
        except Exception as e:  # noqa: BLE001 - network is allowed to fail anyhow
            if attempt < tries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            print(f"    {type(e).__name__}: {e}", file=sys.stderr)
            return None
    return None


def title_of(wayback_url: str) -> str:
    """Recover the page title from the archived MediaWiki query string."""
    orig = wayback_url.split("id_/", 1)[1]
    t = up.parse_qs(up.urlparse(orig).query).get("title", ["untitled"])[0]
    # Titles carry a namespace colon and may contain slashes; neither is safe
    # in a filename, and losing the distinction would collide File:x with x.
    return t.replace(":", "__").replace("/", "___")


def read_list(name: str) -> list[str]:
    p = URLS / name
    if not p.exists():
        sys.exit(f"missing {p}; run archive/tools/wayback-index.py first")
    return [l.strip() for l in p.read_text().splitlines()
            if l.strip() and not l.startswith("#")]


def harvest(kind: str, urls: list[str], dest: Path, *, pace: float) -> tuple:
    dest.mkdir(parents=True, exist_ok=True)
    failed, denied, n_new = [], [], 0
    for i, u in enumerate(urls, 1):
        if kind == "images":
            path = up.unquote(up.urlparse(u.split("id_/", 1)[1]).path)
            out = dest / path.split("/wiki/images/", 1)[-1]
        else:
            out = dest / (title_of(u) + (".wiki" if kind == "wikitext" else ".html"))
        if out.exists() and out.stat().st_size:
            continue
        body = get(u)
        if body is None:
            failed.append(u)
            continue

        if kind == "wikitext":
            text = body.decode("utf-8", "replace")
            m = TEXTAREA.search(text) or TEXTAREA_ANY.search(text)
            if not m or not m.group(1).strip():
                # The wiki refused anonymous edits on some pages -- almost all
                # of the File: namespace -- so the Internet Archive's crawler
                # captured a permission-denied form with an empty readonly
                # textarea rather than the editor. The source is not in that
                # snapshot and never will be, so this is a permanent absence,
                # not a transient fetch failure. Retrying it forever would be
                # both futile and rude to the Archive.
                if DENIED.search(text):
                    denied.append(u)
                else:
                    failed.append(u)
                continue
            body = html.unescape(m.group(1)).encode("utf-8")

        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        n_new += 1
        if n_new % 25 == 0:
            print(f"  {kind}: {i}/{len(urls)} ({n_new} new)", flush=True)
        time.sleep(pace)
    print(f"  {kind}: {n_new} fetched, {len(failed)} failed, "
          f"{len(denied)} source withheld in the capture, "
          f"{len(urls) - n_new - len(failed) - len(denied)} already had")
    return failed, denied


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["wikitext", "rendered", "images"])
    ap.add_argument("--pace", type=float, default=1.5,
                    help="seconds between requests (Wayback throttles)")
    args = ap.parse_args()

    jobs = [
        ("wikitext", "wiki-wikitext.txt", OUT / "wikitext"),
        ("rendered", "wiki-rendered.txt", OUT / "rendered"),
        ("images", "wiki-images.txt", OUT / "images"),
        ("images", "wiki-images-thumb-only.txt", OUT / "images"),
    ]
    failed, denied = [], []
    for kind, listname, dest in jobs:
        if args.only and kind != args.only:
            continue
        urls = read_list(listname)
        print(f"{listname}: {len(urls)} URLs")
        f, d = harvest(kind, urls, dest, pace=args.pace)
        failed += f
        denied += d

    if failed:
        p = ROOT / "harvest-wiki-failed.txt"
        p.write_text("".join(f"{u}\n" for u in failed))
        print(f"\n{len(failed)} transient failures written to {p.name} -- "
              f"re-running the script retries only these")
    if denied:
        # Kept apart from failures precisely so nobody re-runs them hoping for a
        # different answer. These pages fall back to their rendered capture.
        p = ROOT / "harvest-wiki-nosource.txt"
        p.write_text("".join(f"{u}\n" for u in denied))
        print(f"{len(denied)} pages have no source in any capture (the wiki "
              f"refused anonymous edits); listed in {p.name}. These are served "
              f"from their rendered HTML instead.")


if __name__ == "__main__":
    main()
