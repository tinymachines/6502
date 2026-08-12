# visual6502.org — preservation archive

This directory rebuilds a copy of <http://visual6502.org/>, the website of the
Visual6502 project by Greg James, Barry Silverman and Brian Silverman, together
with the Visual6502 team and contributors.

**This is not our work.** It is someone else's, mirrored because it is decaying,
and presented with attribution and links back to the original wherever it still
resolves. The simulator in the rest of this repository was built *from* their
data; this directory is an attempt to make sure the source of it survives.

## Why

As of August 2026:

| | |
|---|---|
| Main site | Serves. 36 files reachable by crawling. |
| **Wiki** | **HTTP 500 on every page.** MediaWiki is failing; all 169 pages are unreachable. |
| **Die photography** | **Serves, but nothing links to it.** 548 files, 2.3 GB, 41 chips. |

The wiki is the visible loss — a decade of research notes on the 6502, its
decimal mode, interrupt behaviour, timing states and decode ROM, plus the
project's chip collection index. It returns 500 rather than 404, which suggests
the pages are still on disk behind a broken database.

The quieter loss is the photography. Those 2.3 GB of 20× microscope die scans
are still served, but the wiki pages that linked to them are dead and the
directory listings return 403 — so nothing on the open web points at them any
more. They are intact and unreachable at the same time, which is how this kind
of material usually disappears: not deleted, just orphaned. The file list here
had to be reconstructed from the Wayback Machine's index even though the bytes
came from the live server.

## What is here

Committed — the index, which is ours and is what makes the mirror reproducible:

```
urls/wiki-wikitext.txt          166 pages, raw source from action=edit captures
urls/wiki-rendered.txt          169 pages as rendered
urls/wiki-images.txt             80 uploaded images, full size
urls/wiki-images-thumb-only.txt   3 images archived only as thumbnails
urls/wiki-manifest.json         per-page metadata: title, namespace, timestamps
urls/site-images.txt            548 die photographs (origin URLs)
urls/site-other.txt              76 other files: JSSim, /sim/ ARM simulator, docs
urls/site-manifest.json         sizes and per-file origin/Wayback URL pairs
```

Not committed (see `.gitignore`) — the fetched payload, because this repository
does not redistribute CC BY-NC-SA material, it points at it:

```
mirror/         the live site, including the die photography
wiki-raw/       wikitext, rendered HTML and images recovered from Wayback
cdx/            cached Wayback CDX index responses
```

## Reproducing it

```bash
python3 archive/tools/wayback-index.py --refetch   # rebuild the URL lists
bash     archive/tools/mirror-live.sh              # crawl what the site links
bash     archive/tools/harvest-site.sh             # the 2.3 GB nothing links to
python3  archive/tools/harvest-wiki.py             # the wiki, out of Wayback
python3  archive/tools/build-wiki.py               # wikitext -> static site
```

Every fetch is rate-limited and resumable. `harvest-site.sh` in particular is
deliberately slow: visual6502.org is a hobbyist server that has stayed up for
fifteen years, and the one way this exercise could do real harm is by knocking
it over. If you re-run these, please leave the limits alone.

## Recovery notes

- **163 of 169 pages have raw wikitext**, recovered from archived `action=edit`
  forms, where MediaWiki puts page source in a `<textarea>`. This is why the
  rebuild is a real recovery rather than a screenshot: wikitext is re-renderable
  and convertible, where captured HTML is only viewable.
- Six pages exist as rendered HTML only, among them `6502_Timing_States` and
  `Decode_ROM`.
- **Nothing is known to be lost.** Two filenames initially looked like the
  archive's one real gap — `6502_dc_sheet2-8-12-75.id.jpeg` and
  `6502_rb_sheet1-11-74.id.jpeg`, apparently scans of hand-drawn 6502 schematic
  sheets, with description pages but no binary at any resolution. They are not
  losses: the archived pages read *"No file by this name exists"*, and Wayback
  has **zero rows for either name at any status or date**. They were red links —
  filenames referenced but never uploaded.

  The schematics themselves survive under different names, and are here:
  `6502_schematic_sheet1-11-74.id.jpeg` (2593×873) and
  `6502_schematic_sheet2-8-12-75.id.jpeg` (2597×877), each with a lower-
  resolution variant. Worth knowing generally: a MediaWiki `File:` page proves a
  filename was *referenced*, not that anything was ever stored under it, and from
  a CDX index alone a red link is indistinguishable from a deletion.
- The `Special:` namespace is skipped. It is navigation a wiki regenerates for
  itself; capturing it means capturing 410 permutations of RecentChanges.

## Attribution and licensing

The Visual6502 project's die images, polygon data and wiki content are licensed
**CC BY-NC-SA 3.0**, attributed to **Greg James, Barry Silverman and Brian
Silverman / visual6502.org**. Mirroring is permitted under that licence provided
attribution is preserved, the material stays NonCommercial, and derivatives are
shared alike. All three conditions bind anything published from this directory.

- Original site: <http://visual6502.org/>
- Project blog: <http://blog.visual6502.org/>
- Source data: <https://github.com/trebonian/visual6502>
- Licence: <https://creativecommons.org/licenses/by-nc-sa/3.0/>

Every page produced by `build-wiki.py` carries a banner identifying it as an
archived copy, naming the source and the capture date, and linking to the
original URL and to the Wayback snapshot it came from. That banner is not
decoration — it is the attribution requirement, and it is why the build fails
rather than emits a page without it.

See `../NOTICE.md` for how this interacts with the rest of the repository, whose
own code is MIT.
