#!/usr/bin/env python3
"""Build a browsable gallery of the visual6502 die photography.

    python3 archive/tools/build-gallery.py            # -> archive/public/gallery/

The collection is 548 files across 41 chips, ~2.3 GB, with single PNGs reaching
244 MB. It is still served by visual6502.org but nothing links to it: the wiki
pages that referenced these images return 500 and the directory listings are
403. The collection is intact and unreachable at the same time.

So the point of this script is less "make a gallery" than "make the collection
navigable at all". Each image gets two derivatives:

    thumb  480px   contact-sheet browsing
    view  2000px   readable in a page without a 244 MB download

and the original is always one click away, labelled with its true size so nobody
starts that download by accident. Serving a quarter-gigabyte PNG as the only way
to look at a chip is the reason nobody browses these today.

Derivatives are generated in parallel and skipped if newer than the source, so
re-runs after adding chips are cheap.
"""

import html
import json
import os
import re
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Imported by name: this file defines its own shell(), which would rebind
# the module-level name. See build-wiki.py for the same note.
from shell import CSS as HEADER_CSS, LINKS as SITE_LINKS, header as site_header  # noqa: E402

try:
    from PIL import Image, ImageFile
except ImportError:
    sys.exit("build-gallery needs Pillow:  pip install Pillow")

# These are legitimately enormous scientific scans, not decompression bombs, and
# several exceed Pillow's default 89 Mpx guard. Truncated files are tolerated so
# one bad download cannot abort a 548-image build.
Image.MAX_IMAGE_PIXELS = None
ImageFile.LOAD_TRUNCATED_IMAGES = True

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "mirror" / "visual6502.org" / "images"
OUT = ROOT / "public" / "gallery"
EXT = {".jpg", ".jpeg", ".png", ".gif", ".tif", ".tiff"}

THUMB, VIEW = 480, 2000
ATTRIB = ("Visual6502 project &mdash; Greg James, Barry Silverman and "
          "Brian Silverman, and the Visual6502 team")
LICENCE = "https://creativecommons.org/licenses/by-nc-sa/3.0/"


def description_pages() -> dict:
    """Map a chip directory to the site's own page describing that die shoot.

    visual6502.org wrote a short page per chip under images/pages/, which is
    where the project's own words about each part live -- what it is, who
    donated it, how it was decapped. Those pages reference ../<chip>/photo.jpg,
    so the directory they point at most often identifies the chip they describe.
    Without this the gallery would show the photographs stripped of everything
    the people who took them had to say about them.
    """
    out, d = {}, SRC / "pages"
    if not d.exists():
        return out
    for f in sorted(d.glob("*.html")):
        text = f.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"<title>(.*?)</title>", text, re.S | re.I)
        title = " ".join(html.unescape(m.group(1)).split()) if m else f.stem
        refs = Counter(re.findall(r'(?:href|src)="\.\./([^/"]+)/', text))
        if refs:
            out.setdefault(refs.most_common(1)[0][0], []).append((title, f.name))
    return out


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def derive(job: tuple) -> tuple:
    """Make thumb+view for one image. Runs in a worker process."""
    src, thumb_p, view_p = Path(job[0]), Path(job[1]), Path(job[2])
    try:
        mtime = src.stat().st_mtime
        need = [p for p in (thumb_p, view_p)
                if not p.exists() or p.stat().st_mtime < mtime]
        with Image.open(src) as im:
            w, h = im.size
            if not need:
                return (str(src), w, h, True, None)
            # draft() lets the JPEG decoder downscale while reading, which is
            # the difference between seconds and minutes on the large scans.
            if im.format == "JPEG":
                im.draft("RGB", (VIEW, VIEW))
            im = im.convert("RGB")
            for p, box in ((thumb_p, THUMB), (view_p, VIEW)):
                if p not in need:
                    continue
                c = im.copy()
                c.thumbnail((box, box), Image.LANCZOS)
                p.parent.mkdir(parents=True, exist_ok=True)
                c.save(p, "JPEG", quality=82, optimize=True, progressive=True)
        return (str(src), w, h, True, None)
    except Exception as e:  # noqa: BLE001 - one bad file must not stop the build
        return (str(src), 0, 0, False, f"{type(e).__name__}: {e}")


CSS = """
:root{--space:#0b1120;--surface:#131c2f;--subtle:#1a2740;--line:#3d5573;
--fg:#eaf2ff;--muted:#9fb3cc;--accent:#22d3ee;--gold:#7dd3fc;
--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--mono:"SFMono-Regular","SF Mono",ui-monospace,Consolas,monospace;
--hard:5px 5px 0 rgba(2,6,16,.5)}
*{box-sizing:border-box}
body{margin:0;color:var(--fg);font-family:var(--sans);line-height:1.6;
background:radial-gradient(circle at 12% 6%,#22d3ee1f,transparent 30rem),
linear-gradient(135deg,var(--space),#0e1830 56%,var(--subtle));background-attachment:fixed}
.wrap{max-width:78rem;margin:0 auto;padding:0 1.25rem 5rem}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.14em;
text-transform:uppercase;color:var(--accent)}
h1{font-weight:900;font-size:clamp(1.7rem,4vw,2.6rem);line-height:1.1;margin:2rem 0 .5rem}
h2{font-weight:800;font-size:1.35rem;margin:2.5rem 0 .8rem;padding-bottom:.3rem;
border-bottom:2px solid var(--line)}
a{color:var(--accent)}
p.lede{color:var(--muted);max-width:44rem}
.banner{border:2px solid var(--line);background:var(--surface);box-shadow:var(--hard);
padding:1rem 1.1rem;margin:1.5rem 0 2rem;font-size:.9rem;color:var(--muted)}
.banner strong{color:var(--fg)}
.chips{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr));
padding:0;list-style:none}
.chips a{display:block;border:2px solid var(--line);background:var(--surface);
text-decoration:none;color:var(--fg)}
.chips a:hover{border-color:var(--accent);box-shadow:var(--hard)}
.chips img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#0a1526}
.chips .meta{padding:.6rem .75rem}
.chips .meta b{display:block;font-size:1rem}
.chips .meta small{color:var(--muted);font-family:var(--mono);font-size:.72rem}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,19rem),1fr));
padding:0;list-style:none}
.grid figure{margin:0;border:2px solid var(--line);background:var(--surface)}
.grid img{width:100%;display:block;background:#0a1526}
.grid figcaption{padding:.55rem .7rem;font-size:.8rem}
.grid figcaption b{display:block;font-weight:600;word-break:break-word}
.grid figcaption small{display:block;color:var(--muted);font-family:var(--mono);
font-size:.7rem}
.grid a{text-decoration:none;color:var(--fg)}
.dl{display:inline-block;margin-top:.3rem;font-family:var(--mono);font-size:.7rem;
color:var(--gold)}
.dl.src{color:var(--muted);margin-left:.5rem}
.orig-wrap{display:flex;flex-wrap:wrap;gap:.6rem;margin:1.25rem 0}
.orig{display:inline-block;border:2px solid var(--accent);color:var(--accent);
padding:.45rem .8rem;text-decoration:none;font-weight:600;font-size:.88rem}
.orig:hover{background:var(--accent);color:#06121f}
.orig.doc{border-color:var(--gold);color:var(--gold);font-family:var(--mono);
font-size:.78rem;font-weight:400}
.orig.doc:hover{background:var(--gold);color:#06121f}
footer{margin-top:4rem;padding-top:1.5rem;border-top:2px solid var(--line);
color:var(--muted);font-size:.85rem}

.version-foot{display:inline-flex;align-items:center;gap:.5rem;
font-family:var(--mono);font-size:.7rem;margin-left:.75rem}
.version-foot:empty{display:none}
.vf-rev{display:inline-flex;align-items:center;gap:.35rem;text-decoration:none}
.vf-pill{border:1px solid var(--line);background:var(--subtle);color:var(--accent);
padding:.1rem .4rem;letter-spacing:.04em}
.vf-hash{color:var(--muted)}
.vf-rev:hover .vf-pill{border-color:var(--accent)}
.vf-rev:hover .vf-hash{color:var(--fg)}
.vf-built{color:var(--muted)}
.vf-built::before{content:"·";margin-right:.5rem;opacity:.6}
"""


def shell(title: str, body: str, *, depth: int) -> str:
    root = "../" * depth              # back to gallery/
    archive = "../" * (depth + 1)     # back to the archive root
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} · visual6502 die photography (archived)</title>
<link rel="stylesheet" href="{root}gallery.css">
</head><body>
{site_header(archive, SITE_LINKS, active="Die photos")}
<div class="wrap">
{body}
<footer>Images &copy; the {ATTRIB}, licensed
<a href="{LICENCE}" rel="noopener">CC BY-NC-SA 3.0</a>. Mirrored from
<a href="http://visual6502.org/" rel="noopener">visual6502.org</a> for
preservation; not affiliated with the Visual6502 project.
<span class="version-foot" data-version-footer></span></footer>
</div>
<script type="module" src="{archive}site-nav.js"></script>
<script type="module" src="{archive}version-footer.js"></script>
</body></html>
"""


BANNER = f"""<div class="banner"><strong>Archived copy.</strong> These die
photographs are still served by visual6502.org, but nothing links to them any
more: the wiki pages that referenced them return HTTP&nbsp;500 and the directory
listings return 403. Mirrored here so they stay reachable. Images by the
{ATTRIB}, licensed <a href="{LICENCE}" rel="noopener">CC BY-NC-SA 3.0</a>.</div>"""


def main() -> None:
    if not SRC.exists():
        sys.exit(f"no mirror at {SRC} -- run archive/tools/harvest-site.sh first")

    chips, docs = {}, {}
    for d in sorted(SRC.iterdir()):
        if not d.is_dir() or d.name == "pages":
            continue
        files = sorted(f for f in d.rglob("*")
                       if f.is_file() and f.suffix.lower() in EXT)
        if files:
            chips[d.name] = files
            # Datasheets and programming guides sit beside the photographs in
            # a few directories. They are part of what was collected and would
            # otherwise be mirrored but never surfaced anywhere.
            docs[d.name] = sorted(f for f in d.rglob("*")
                                  if f.is_file() and f.suffix.lower() == ".pdf")
    if not chips:
        sys.exit(f"no images under {SRC}")
    described = description_pages()

    jobs = []
    for chip, files in chips.items():
        for f in files:
            rel = f.relative_to(SRC)
            jobs.append((str(f), str(OUT / "thumb" / rel.with_suffix(".jpg")),
                         str(OUT / "view" / rel.with_suffix(".jpg"))))
    print(f"{len(chips)} chips, {len(jobs)} images -> deriving thumbnails")

    dims, failed = {}, []
    with ProcessPoolExecutor(max_workers=min(8, os.cpu_count() or 4)) as ex:
        for i, (src, w, h, ok, err) in enumerate(ex.map(derive, jobs, chunksize=1), 1):
            if ok:
                dims[src] = (w, h)
            else:
                failed.append((src, err))
            if i % 50 == 0:
                print(f"  {i}/{len(jobs)}", flush=True)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "gallery.css").write_text(CSS + HEADER_CSS)

    # Per-chip pages.
    cards = []
    for chip, files in chips.items():
        items, total = [], 0
        for f in files:
            rel = f.relative_to(SRC)
            size = f.stat().st_size
            total += size
            w, h = dims.get(str(f), (0, 0))
            thumb = f"thumb/{rel.with_suffix('.jpg').as_posix()}"
            view = f"view/{rel.with_suffix('.jpg').as_posix()}"
            # The full-size link points at our own copy, not back at
            # visual6502.org. An archive that sources its originals from the
            # site it is archiving stops working the moment that site does,
            # which is the failure this whole exercise is about.
            full = f"../full/images/{rel.as_posix()}"
            upstream = f"http://visual6502.org/images/{rel.as_posix()}"
            px = f"{w}&times;{h}" if w else "unknown"
            items.append(
                f'<li><figure><a href="../{view}"><img loading="lazy" '
                f'src="../{thumb}" alt="{html.escape(f.name)}"></a>'
                f'<figcaption><b>{html.escape(f.name)}</b>'
                f'<small>{px} &middot; {human(size)}</small>'
                f'<a class="dl" href="{full}">full resolution '
                f'{human(size)} &darr;</a> '
                f'<a class="dl src" href="{upstream}" rel="noopener">source</a>'
                f'</figcaption></figure></li>')
        extra = ""
        for title, name in described.get(chip, []):
            extra += (f'<a class="orig" href="../full/images/pages/{name}">'
                      f'{html.escape(title)} &mdash; the project\'s own page '
                      f'about this chip &rarr;</a>')
        for doc in docs.get(chip, []):
            r = doc.relative_to(SRC).as_posix()
            extra += (f'<a class="orig doc" href="../full/images/{r}">'
                      f'{html.escape(doc.name)} '
                      f'({human(doc.stat().st_size)}) &darr;</a>')

        body = (f'<h1>{html.escape(chip)}</h1>'
                f'<p class="lede">{len(files)} images, {human(total)}. '
                f'Click a photograph for a 2000px view; the original full-resolution '
                f'scan is linked beneath each one.</p>'
                + (f'<div class="orig-wrap">{extra}</div>' if extra else "")
                + BANNER
                + f'<ul class="grid">{"".join(items)}</ul>')
        (OUT / "chip").mkdir(parents=True, exist_ok=True)
        (OUT / "chip" / f"{chip}.html").write_text(
            shell(chip, body, depth=1))

        cover = files[0].relative_to(SRC)
        cards.append((total, chip, len(files),
                      f"thumb/{cover.with_suffix('.jpg').as_posix()}"))

    cards.sort(key=lambda c: -c[0])
    lis = "".join(
        f'<li><a href="chip/{html.escape(chip)}.html">'
        f'<img loading="lazy" src="{th}" alt="{html.escape(chip)} die">'
        f'<div class="meta"><b>{html.escape(chip)}</b>'
        f'<small>{n} images &middot; {human(tot)}</small></div></a></li>'
        for tot, chip, n, th in cards)
    grand = sum(c[0] for c in cards)
    body = (f'<h1>Die photography</h1><p class="lede">'
            f'{len(cards)} chips, {sum(c[2] for c in cards)} photographs, '
            f'{human(grand)}. Twenty-times microscope scans of the silicon, '
            f'many of them the only public images of the part.</p>{BANNER}'
            f'<ul class="chips">{lis}</ul>')
    (OUT / "index.html").write_text(
        shell("Die photography", body, depth=0))

    (OUT / "gallery-manifest.json").write_text(json.dumps(
        {"chips": [{"chip": c, "images": n, "bytes": t} for t, c, n, _ in cards],
         "total_bytes": grand}, indent=2) + "\n")

    print(f"built {len(cards)} chip pages, {len(dims)} images, {human(grand)}")
    if failed:
        print(f"!! {len(failed)} images failed:")
        for s, e in failed[:10]:
            print(f"   {Path(s).name}: {e}")


if __name__ == "__main__":
    main()
