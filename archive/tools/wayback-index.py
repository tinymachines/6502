#!/usr/bin/env python3
"""Index what the Wayback Machine holds for visual6502.org, and emit harvest lists.

    python3 archive/tools/wayback-index.py            # use cached CDX, rebuild lists
    python3 archive/tools/wayback-index.py --refetch  # re-query the CDX API first

Why this exists: visual6502.org's wiki has been returning HTTP 500 since some
point after 2021 -- MediaWiki itself is failing, so every article is unreachable
even though the main site still serves. The Wayback Machine has it, but a naive
`url=visual6502.org/wiki*` query returns ~90k rows that are almost entirely
MediaWiki navigation cruft: Special:RecentChanges with every combination of
hideminor/hideliu/hidemyself/hideanons, login redirects carrying returnto=, and
thousands of oldid/diff permutations. Fewer than 1 row in 100 is content.

This script separates the content from the chaff and picks one best snapshot per
target, so the result is a few hundred URLs to fetch rather than tens of
thousands.

The important find: 163 of the 169 content pages have `action=edit` snapshots,
which embed the page's raw wikitext in a <textarea>. That is the difference
between preserving a *rendering* of the wiki and preserving the wiki -- wikitext
can be re-imported into a fresh MediaWiki, or converted cleanly to Markdown/HTML.
Rendered HTML is captured too, as a fallback for the 6 pages without wikitext and
as a cross-check on the extraction.

Snapshot URLs use the `id_` modifier (`/web/<timestamp>id_/<url>`), which returns
the originally archived bytes with no Wayback toolbar injected and no rewriting of
in-page links. For wikitext extraction and for image binaries that is what you
want; a rewritten copy would need un-rewriting later.
"""

import argparse
import collections
import json
import sys
import urllib.parse as up
import urllib.request
from pathlib import Path

CDX = "http://web.archive.org/cdx/search/cdx"
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cdx"
OUT = ROOT / "urls"

# MediaWiki namespaces we treat as content worth preserving. Everything else --
# principally Special: -- is generated navigation that a live wiki regenerates
# for itself and that carries no authored content.
CONTENT_NS = {
    "(article)", "File", "Image", "Template", "Category",
    "Help", "Talk", "User", "MediaWiki",
}
KNOWN_NS = {
    "File", "Image", "Talk", "User", "User talk", "Category", "Category talk",
    "Template", "Template talk", "Help", "Help talk", "Special", "MediaWiki",
}


def wb(timestamp: str, url: str) -> str:
    """A Wayback URL for the original bytes -- no toolbar, no link rewriting."""
    return f"https://web.archive.org/web/{timestamp}id_/{url}"


def fetch_cdx(query: str, prefix: str, *, refetch: bool) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    n_url = f"{CDX}?url={up.quote(query)}&filter=statuscode:200&collapse=urlkey&showNumPages=true"
    with urllib.request.urlopen(n_url, timeout=300) as r:
        pages = int(r.read().decode().strip())
    print(f"  {query}: {pages} CDX pages", file=sys.stderr)
    for p in range(pages):
        dest = CACHE / f"{prefix}-{p}.json"
        if dest.exists() and dest.stat().st_size and not refetch:
            continue
        u = (f"{CDX}?url={up.quote(query)}&filter=statuscode:200&collapse=urlkey"
             f"&output=json&fl=original,timestamp,mimetype,length&page={p}")
        with urllib.request.urlopen(u, timeout=600) as r:
            dest.write_bytes(r.read())
        print(f"    page {p} cached", file=sys.stderr)


def load(prefix: str) -> list:
    rows = []
    for f in sorted(CACHE.glob(f"{prefix}-*.json"),
                    key=lambda p: int(p.stem.rsplit("-", 1)[1])):
        d = json.loads(f.read_text())
        if d and d[0][0] == "original":
            d = d[1:]
        rows += d
    if not rows:
        sys.exit(f"no cached CDX for {prefix}-*; run with --refetch")
    return rows


def namespace(title: str) -> str:
    head = title.split(":")[0]
    return head if (":" in title and head in KNOWN_NS) else "(article)"


def classify(rows):
    """Split raw CDX rows into (rendered, wikitext, uploads, thumbs)."""
    rendered, wikitext, uploads, thumbs = {}, {}, {}, {}

    def keep(store, key, ts, extra=None):
        # Latest snapshot wins. Articles only gained content over time, and the
        # dead-wiki era returns 500 (excluded by filter=statuscode:200), so the
        # newest 200 is the most complete capture rather than an error page.
        if key not in store or ts > store[key][0]:
            store[key] = (ts, extra)

    for orig, ts, mime, length in rows:
        u = up.urlparse(orig)
        if not u.query:
            if "/wiki/images/thumb/" in u.path:
                # .../thumb/<a>/<ab>/<Name>/<width>px-<Name>. Keyed by the
                # original filename so it can stand in for a missing full-size.
                parts = u.path.split("/thumb/", 1)[1].split("/")
                if len(parts) >= 3:
                    keep(thumbs, up.unquote(parts[2]), ts, (orig, mime, length))
            elif "/wiki/images/" in u.path:
                keep(uploads, u.path, ts, (orig, mime, length))
            continue
        q = up.parse_qs(u.query)
        title = q.get("title", [None])[0]
        if not title or namespace(title) not in CONTENT_NS:
            continue
        params = set(q) - {"title"}
        if not params:
            keep(rendered, title, ts, orig)
        elif params == {"action"} and q["action"][0] in ("edit", "raw"):
            keep(wikitext, title, ts, orig)
    return rendered, wikitext, uploads, thumbs


def write_list(name: str, lines, header: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    lines = list(lines)
    p = OUT / name
    p.write_text(f"# {header}\n" + "".join(f"{l}\n" for l in lines))
    print(f"  {p.relative_to(ROOT.parent)}: {len(lines)} URLs")
    return p


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refetch", action="store_true", help="re-query the CDX API")
    args = ap.parse_args()

    if args.refetch:
        print("querying CDX...", file=sys.stderr)
        fetch_cdx("visual6502.org/wiki*", "wiki", refetch=True)
        fetch_cdx("visual6502.org*", "site", refetch=True)

    rows = load("wiki")
    rendered, wikitext, uploads, thumbs = classify(rows)

    ns_counts = collections.Counter(namespace(t) for t in rendered)
    print(f"\n{len(rows)} CDX rows -> content:")
    for k, v in ns_counts.most_common():
        n_src = sum(1 for t in wikitext if namespace(t) == k)
        print(f"  {k:12} {v:4} rendered  {n_src:4} with wikitext")

    missing = sorted(set(rendered) - set(wikitext))
    print(f"\n{len(rendered)} pages, {len(wikitext)} with wikitext, "
          f"{len(missing)} rendered-only")

    write_list("wiki-wikitext.txt",
               (wb(ts, orig) for ts, orig in sorted(wikitext.values())),
               "visual6502 wiki -- raw wikitext (action=edit; text is in the <textarea>)")
    write_list("wiki-rendered.txt",
               (wb(ts, orig) for ts, orig in sorted(rendered.values())),
               "visual6502 wiki -- rendered HTML")
    write_list("wiki-images.txt",
               (wb(ts, e[0]) for ts, e in sorted(uploads.values())),
               "visual6502 wiki -- uploaded images (full size, no thumbs)")

    # A manifest so a harvester can map a fetched URL back to its page identity
    # without re-deriving it from the query string.
    man = []
    for title, (ts, orig) in sorted(rendered.items()):
        src = wikitext.get(title)
        man.append({
            "title": title,
            "namespace": namespace(title),
            "rendered": {"timestamp": ts, "url": wb(ts, orig), "original": orig},
            "wikitext": ({"timestamp": src[0], "url": wb(src[0], src[1]),
                          "original": src[1]} if src else None),
        })
    up_man = [{"path": p, "timestamp": ts, "url": wb(ts, e[0]),
               "mime": e[1], "bytes": int(e[2]) if str(e[2]).isdigit() else None}
              for p, (ts, e) in sorted(uploads.items())]
    (OUT / "wiki-manifest.json").write_text(
        json.dumps({"pages": man, "uploads": up_man}, indent=2) + "\n")

    total = sum(u["bytes"] or 0 for u in up_man)
    print(f"  archive/urls/wiki-manifest.json: {len(man)} pages, "
          f"{len(up_man)} uploads ({total / 1e6:.1f} MB)")

    # Which File: pages have no full-size binary archived? For those, a thumbnail
    # is a poor substitute but far better than nothing, so it gets its own list
    # rather than being silently mixed in with the full-resolution captures.
    have = {up.unquote(u["path"].rsplit("/", 1)[1]) for u in up_man}
    wanted = {t[5:].replace(" ", "_") for t in rendered if namespace(t) == "File"}
    gap = sorted(f for f in wanted if up.unquote(f) not in have)
    fallback = [(f, thumbs[up.unquote(f)]) for f in gap if up.unquote(f) in thumbs]
    if fallback:
        write_list("wiki-images-thumb-only.txt",
                   (wb(ts, e[0]) for _, (ts, e) in fallback),
                   "visual6502 wiki -- REDUCED RESOLUTION fallbacks: no full-size "
                   "copy of these was ever archived")
    lost = [f for f in gap if up.unquote(f) not in thumbs]

    if missing:
        print(f"\nrendered-only (no wikitext archived): {', '.join(missing)}")
    if lost:
        print(f"\n!! no copy at any resolution ({len(lost)}) -- look for these "
              f"elsewhere:\n   " + "\n   ".join(lost))

    index_site()


def index_site() -> None:
    """List the non-wiki site, which a crawler cannot discover by itself.

    Crawling http://visual6502.org/ reaches 36 files. The Wayback index knows
    661. The difference is almost entirely /images/<chip>/ -- 41 die-photograph
    sets, ~2.3 GB, linked from wiki pages that no longer resolve and from
    directory listings that are now 403. Nothing links to them from the live
    homepage, so they are invisible to a crawl and effectively already lost even
    though the server still serves every one of them.

    These are emitted as ORIGIN urls, not Wayback ones: the files are live, and
    the origin has the authoritative bytes. Wayback is the fallback for the few
    that 404.
    """
    rows = load("site")
    site = {}
    for orig, ts, mime, length in rows:
        u = up.urlparse(orig)
        host = u.netloc.lower().replace("www.", "")
        if u.query or "/wiki/" in u.path or not host.endswith("visual6502.org"):
            continue
        # /stage/ is a staging duplicate of JSSim and robots-disallowed;
        # /get-viagra/ is spam-injection debris from an old compromise.
        if u.path.startswith(("/stage/", "/get-viagra/")) or u.path.endswith("/"):
            continue
        n = int(length) if str(length).isdigit() else 0
        if u.path not in site or ts > site[u.path][0]:
            site[u.path] = (ts, orig, mime, n)

    imgs = {p: v for p, v in site.items() if p.startswith("/images/")}
    rest = {p: v for p, v in site.items() if not p.startswith("/images/")}
    write_list("site-images.txt",
               (f"http://visual6502.org{p}" for p in sorted(imgs)),
               "visual6502.org die photography -- LIVE at origin, ~2.3 GB, "
               "unreachable by crawling (no inbound links, dir listing 403)")
    write_list("site-other.txt",
               (f"http://visual6502.org{p}" for p in sorted(rest)),
               "visual6502.org non-image files (JSSim, /sim/ ARM simulator, docs)")

    sets = collections.Counter()
    for p, v in imgs.items():
        if p.count("/") > 2:
            sets[p.split("/")[2]] += v[3]
    (OUT / "site-manifest.json").write_text(json.dumps({
        "note": "sizes from the Wayback index; bytes come from the live origin",
        "total_bytes": sum(v[3] for v in site.values()),
        "image_sets": [{"chip": k, "bytes": v} for k, v in sets.most_common()],
        "files": [{"path": p, "bytes": v[3], "mime": v[2],
                   "origin": f"http://visual6502.org{p}", "wayback": wb(v[0], v[1])}
                  for p, v in sorted(site.items())],
    }, indent=2) + "\n")
    print(f"  archive/urls/site-manifest.json: {len(site)} files, "
          f"{sum(v[3] for v in site.values()) / 1e9:.2f} GB, "
          f"{len(sets)} chip image sets")


if __name__ == "__main__":
    main()
