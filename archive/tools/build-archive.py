#!/usr/bin/env python3
"""Assemble the visual6502.org preservation archive into one servable site.

    python3 archive/tools/build-archive.py

Runs the wiki and gallery builders, links the mirrored originals into place, and
writes the landing page that explains what this is and who made it.

Layout produced under archive/public/:

    index.html      what was lost, what was recovered, and the attribution
    wiki/           169 pages rebuilt from recovered wikitext
    gallery/        41 chips of die photography, browsable
    full/           symlink to the mirrored full-resolution originals
    site/           the live site as it still stands (JSSim, docs, /sim/)

`full/` is a symlink rather than a copy: the originals are 2.3 GB and there is
no reason to hold them twice. nginx follows symlinks by default, and the deploy
resolves it.
"""

import html
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
PUBLIC = ROOT / "public"
MIRROR = ROOT / "mirror" / "visual6502.org"

ATTRIB = ("Visual6502 project &mdash; Greg James, Barry Silverman and "
          "Brian Silverman, and the Visual6502 team")
LICENCE = "https://creativecommons.org/licenses/by-nc-sa/3.0/"


def run(script: str) -> None:
    print(f"\n=== {script} ===")
    r = subprocess.run([sys.executable, str(TOOLS / script)], check=False)
    if r.returncode:
        sys.exit(f"{script} failed ({r.returncode})")


CSS = """
:root{--space:#0b1120;--surface:#131c2f;--subtle:#1a2740;--line:#3d5573;
--fg:#eaf2ff;--muted:#9fb3cc;--accent:#22d3ee;--gold:#7dd3fc;--warn:#fb7185;
--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--mono:"SFMono-Regular","SF Mono",ui-monospace,Consolas,monospace;
--hard:5px 5px 0 rgba(2,6,16,.5);--hard-card:8px 8px 0 rgba(2,6,16,.48)}
*{box-sizing:border-box}
body{margin:0;color:var(--fg);font-family:var(--sans);line-height:1.65;
background:radial-gradient(circle at 12% 6%,#22d3ee1f,transparent 30rem),
radial-gradient(circle at 88% 10%,#7dd3fc16,transparent 28rem),
linear-gradient(135deg,var(--space),#0e1830 56%,var(--subtle));background-attachment:fixed}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.4;
background-image:radial-gradient(circle,#eaf2ff7a 0 1.5px,transparent 2px),
radial-gradient(circle,#22d3ee66 0 1px,transparent 1.5px);
background-size:140px 128px,180px 176px;background-position:0 0,42px 58px}
.wrap{position:relative;z-index:1;max-width:60rem;margin:0 auto;padding:0 1.25rem 6rem}
header.top{position:sticky;top:0;z-index:5;background:#0b1120ee;backdrop-filter:blur(8px);
border-bottom:2px solid var(--line)}
header.top .wrap{display:flex;gap:1rem;align-items:center;justify-content:space-between;
padding:.75rem 1.25rem}
header.top a{color:var(--fg);text-decoration:none;font-weight:800}
header.top nav a{color:var(--muted);font-weight:600;margin-left:1rem;font-size:.9rem}
header.top nav a:hover{color:var(--accent)}
.eyebrow{font-family:var(--mono);font-size:.75rem;letter-spacing:.16em;
text-transform:uppercase;color:var(--accent);display:flex;align-items:center;gap:.75rem;
margin:3rem 0 .5rem}
.eyebrow::after{content:"";flex:1;height:2px;
background:linear-gradient(90deg,var(--accent),transparent)}
h1{font-weight:900;font-size:clamp(2rem,6vw,3.4rem);line-height:1.05;margin:.5rem 0 1rem;
letter-spacing:-.02em}
h2{font-weight:900;font-size:clamp(1.4rem,3.4vw,2rem);line-height:1.15;margin:.3rem 0 .8rem}
p{max-width:44rem}
p.lede{font-size:1.15rem;color:var(--muted)}
a{color:var(--accent)}
.cards{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));
padding:0;list-style:none;margin:1.5rem 0}
.card{border:2px solid var(--line);background:var(--surface);box-shadow:var(--hard-card);
padding:1.25rem;display:flex;flex-direction:column}
.card h3{margin:.2rem 0 .5rem;font-size:1.2rem;font-weight:800}
.card p{color:var(--muted);font-size:.92rem;flex:1}
.card .n{font-family:var(--mono);font-size:.72rem;color:var(--gold);letter-spacing:.08em}
.card a.go{display:inline-block;margin-top:.9rem;font-weight:700;text-decoration:none;
border:2px solid var(--accent);color:var(--accent);padding:.4rem .8rem;font-size:.88rem}
.card a.go:hover{background:var(--accent);color:#06121f}
table.status{border-collapse:collapse;width:100%;margin:1.5rem 0;font-size:.92rem;
border:2px solid var(--line);box-shadow:var(--hard);background:var(--surface)}
table.status td,table.status th{border:1px solid var(--line);padding:.55rem .7rem;
text-align:left;vertical-align:top}
table.status th{background:var(--subtle);font-weight:700}
.bad{color:var(--warn);font-weight:700}
.ok{color:var(--gold);font-weight:700}
.note{border-left:3px solid var(--accent);padding:.3rem 0 .3rem 1rem;margin:1.5rem 0;
color:var(--muted)}
footer{margin-top:4rem;padding-top:1.5rem;border-top:2px solid var(--line);
color:var(--muted);font-size:.88rem}
footer strong{color:var(--fg)}
"""


def main() -> None:
    if not MIRROR.exists():
        sys.exit("no mirror yet -- run archive/tools/mirror-live.sh and "
                 "harvest-site.sh first")

    run("build-wiki.py")
    run("build-gallery.py")

    PUBLIC.mkdir(parents=True, exist_ok=True)

    # Full-resolution originals, linked rather than copied (2.3 GB).
    link = PUBLIC / "full"
    if link.is_symlink() or link.exists():
        link.unlink() if link.is_symlink() else shutil.rmtree(link)
    link.symlink_to(Path("..") / "mirror" / "visual6502.org" / "images")

    # The live site as it still stands, minus the images already in the gallery.
    site = PUBLIC / "site"
    if site.exists():
        shutil.rmtree(site)
    site.mkdir(parents=True)
    for item in MIRROR.iterdir():
        if item.name == "images":
            continue
        (shutil.copytree if item.is_dir() else shutil.copy2)(item, site / item.name)

    wiki_n = len(list((PUBLIC / "wiki").glob("*.html"))) - 1
    gm = PUBLIC / "gallery" / "gallery-manifest.json"
    g = json.loads(gm.read_text()) if gm.exists() else {"chips": [], "total_bytes": 0}
    n_chips = len(g["chips"])
    n_imgs = sum(c["images"] for c in g["chips"])
    gb = g["total_bytes"] / 1e9
    site_n = sum(1 for _ in site.rglob("*") if _.is_file())

    body = f"""
<h1>visual6502.org, preserved</h1>
<p class="lede">The Visual6502 project reverse-engineered the MOS&nbsp;6502 by
photographing its silicon and simulating every transistor. Their website has
been quietly falling apart. This is a mirror, with attribution, so that it
does not go.</p>

<div class="eyebrow">What was lost</div>
<table class="status">
<tr><th>Part of the site</th><th>State</th><th>Recovered here</th></tr>
<tr><td>The wiki &mdash; {wiki_n}+ pages of research</td>
    <td class="bad">HTTP 500 on every page</td>
    <td>Rebuilt from wikitext recovered out of the Internet Archive</td></tr>
<tr><td>Die photography &mdash; {n_imgs} scans, {gb:.1f}&nbsp;GB</td>
    <td class="bad">Served, but nothing links to it</td>
    <td>Mirrored and made browsable for the first time in years</td></tr>
<tr><td>The JavaScript simulator and docs</td>
    <td class="ok">Still working</td>
    <td>Mirrored as it stands</td></tr>
</table>

<p class="note">The wiki returns <strong>500, not 404</strong> &mdash; MediaWiki
is failing rather than the content being deleted, which suggests the pages are
still on disk behind a broken database. The die photographs are stranger still:
all {gb:.1f}&nbsp;GB are served correctly right now, but every page that linked
to them is dead and the directory listings return 403, so nothing on the open
web points at them. Intact and unreachable at once &mdash; which is usually how
this material disappears. Not deleted, just orphaned.</p>

<div class="eyebrow">The archive</div>
<ul class="cards">
<li class="card"><span class="n">{wiki_n} pages</span>
  <h3>The wiki</h3>
  <p>A decade of research on the 6502 &mdash; decimal mode, interrupt
  behaviour, timing states, the decode ROM &mdash; plus the project's index of
  chips in their collection. Rebuilt as static pages from the original
  wikitext, so it cannot rot the way the original did.</p>
  <a class="go" href="wiki/index.html">Read the wiki</a></li>
<li class="card"><span class="n">{n_chips} chips &middot; {gb:.1f} GB</span>
  <h3>Die photography</h3>
  <p>Twenty-times microscope scans of the silicon: the 6502 and 6800, the
  68000, Atari's POKEY and GTIA, the NES PPU, and more. For several of these
  parts these are the only public images that exist.</p>
  <a class="go" href="gallery/index.html">Browse the collection</a></li>
<li class="card"><span class="n">{site_n} files</span>
  <h3>The original site</h3>
  <p>visual6502.org as it still stands, including the JavaScript simulator that
  started all of this and the SIGGRAPH&nbsp;2010 talk describing how the chip
  was photographed and vectorised.</p>
  <a class="go" href="site/index.html">Open the mirror</a></li>
</ul>

<div class="eyebrow">Attribution</div>
<p>None of this is our work. The Visual6502 project is
<strong>Greg James, Barry Silverman and Brian Silverman</strong>, with the
Visual6502 team and its contributors. The die images, polygon data and wiki
content are theirs, licensed
<a href="{LICENCE}" rel="noopener">CC BY-NC-SA 3.0</a>; that licence permits
this mirror and carries the same NonCommercial and ShareAlike terms onward to
anyone who takes it further.</p>
<p>Every page here links back to its original URL and to the Internet Archive
snapshot it came from. Where something could not be recovered, it is marked as
missing rather than quietly omitted &mdash; an archive that hides its gaps is
worth less than one that shows them.</p>
<p><a href="http://visual6502.org/" rel="noopener">visual6502.org</a> &middot;
<a href="http://blog.visual6502.org/" rel="noopener">the project blog</a> &middot;
<a href="https://github.com/trebonian/visual6502" rel="noopener">source data on
GitHub</a></p>

<div class="eyebrow">Still missing</div>
<p>Two images have no surviving copy at any resolution, and they are among the
most historically interesting things the wiki held: scans of hand-drawn 6502
schematic sheets dated <strong>November 1974</strong> and
<strong>August 1975</strong>. Their description pages survive; the scans do not.
If you have them, they are the hole in this archive.</p>
"""

    (PUBLIC / "index.html").write_text(f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>visual6502.org, preserved</title>
<meta name="description" content="A preservation mirror of visual6502.org: the
wiki rebuilt from the Internet Archive, and {gb:.1f} GB of die photography made
browsable again.">
<link rel="stylesheet" href="archive.css">
</head><body>
<header class="top"><div class="wrap">
  <a href="index.html">visual6502.org <span class="eyebrow"
     style="margin:0;display:inline">archived</span></a>
  <nav>
    <a href="wiki/index.html">Wiki</a>
    <a href="gallery/index.html">Die photos</a>
    <a href="/">Simulator</a>
  </nav>
</div></header>
<div class="wrap">{body}
<footer>Mirrored for preservation by
<a href="https://github.com/tinymachines/6502">tinymachines/6502</a>, which
builds a transistor-level 6502 simulator from this project's data. Content
&copy; the {ATTRIB}, licensed
<a href="{LICENCE}" rel="noopener">CC BY-NC-SA 3.0</a>.
<strong>Not affiliated with the Visual6502 project.</strong> If you are one of
its authors and want any of this changed or taken down, open an issue on the
repository and it will be.</footer>
</div></body></html>
""", encoding="utf-8")
    (PUBLIC / "archive.css").write_text(CSS)

    print(f"\n=== archive assembled ===")
    print(f"  wiki    {wiki_n} pages")
    print(f"  gallery {n_chips} chips, {n_imgs} images, {gb:.2f} GB")
    print(f"  site    {site_n} files")
    print(f"  -> {PUBLIC}")


if __name__ == "__main__":
    main()
