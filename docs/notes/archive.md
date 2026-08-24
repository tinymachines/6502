# The preservation archive

visual6502.org, preserved. Split out of `CLAUDE.md`; see also `archive/README.md` for the full account.

## The preservation archive (`archive/`)

A mirror of visual6502.org, which is decaying. **Live at
<https://6502.tinymachines.ai/archive/>.** Deployed separately from the
simulator; see `archive/README.md` for the full account.

What is wrong with the source site, as of August 2026:

| | |
|---|---|
| Wiki | **HTTP 500 on every page.** MediaWiki is failing. 169 pages unreachable. |
| Die photography | **Serves fine, but nothing links to it.** 548 files, 2.3 GB, 41 chips. |
| JSSim, docs, `/sim/` | Still working. 36 files reachable by crawling. |

The wiki returning **500 rather than 404** suggests the pages are still on disk
behind a broken database — worth asking the maintainers before treating Wayback
as the only route. The photography is the subtler loss: every byte is served
correctly, but the wiki pages that linked to it are dead and the directory
listings are 403, so nothing on the open web points at it. The file list had to
be reconstructed from the Wayback CDX index even though the bytes come from the
live origin.

What is recovered: **127 wiki pages** rebuilt from wikitext (42 more linked to
Wayback), **83 wiki images**, **40 chips / 516 photographs / 2.2 GB**, and the
live site's other 71 files.

```bash
python3 archive/tools/wayback-index.py --refetch   # rebuild the URL manifests
bash     archive/tools/mirror-live.sh              # crawl what the site links
bash     archive/tools/harvest-site.sh             # the 2.3 GB nothing links to
python3  archive/tools/harvest-wiki.py             # the wiki, out of Wayback
python3  archive/tools/fill-gaps.py                # backfill what the origin lost
python3  archive/tools/build-archive.py            # -> archive/public/
bash     deploy/archive-deploy.sh                  # publish to /archive/

# The completionist pass: the entire Wayback index for the domain.
python3 archive/tools/drip.py --index              # 24,442 URLs into SQLite
python3 archive/tools/drip.py --delay 1.5          # done: 24,429 of 24,442
                                                   # (nohup it: survives the session)
python3 archive/tools/drip.py --status             # progress, ETA, failures
```

## The drip (`drip.py`) — complete

The targeted harvest took what was known to be worth having. The drip took the
whole domain index — 24,442 URLs, mostly MediaWiki navigation permutations and
some spam pages from an old compromise — on the principle that the cheapest
moment to collect something is before anyone has decided it matters. Sorting
comes later; collection comes first.

It finished: **24,429 fetched, 13 permanently failed, 3.01 GB** (the estimate
beforehand was ~2.5 GB). The 13 are 9 × 404 and 4 × 500, server-side, and a
re-run fails on them identically.

- State is **SQLite, one row per URL**, committed as it goes. A kill loses at
  most the request in flight. Failures stay pending with their error and attempt
  count, so a re-run retries only those.
- **Digest hardlinking**: CDX carries a content digest, so a URL whose bytes we
  already hold is linked rather than refetched. It deduplicated 471 of 24,442
  (~2%) — these pages differ in small ways — but it is free and would matter on
  a duplicated corpus.
- **Query strings are kept in the on-disk path.** MediaWiki puts the entire page
  identity in the query string; dropping it collapses thousands of pages onto one
  file. Over-long names are truncated with a hash suffix.
- **Do not raise the rate limits.** The Internet Archive is a charity preserving
  this for everyone, and one request at a time with backoff on 429 is the deal.

Pulls **one snapshot per URL**, not full version history — that is a much larger
second pass. `blog.visual6502.org` is on Blogger and is not in this domain index;
it needs its own run.

## What makes the recovery work

**163 of 169 pages have archived `action=edit` captures, and MediaWiki puts page
source in a `<textarea>` on its edit form.** So the wiki rebuilds from *wikitext*
rather than from rendered HTML — re-renderable and convertible instead of merely
viewable. This is the single fact the whole rebuild rests on.

A naive `url=visual6502.org/wiki*` CDX query returns ~90k rows that are almost
entirely navigation: `Special:RecentChanges` in every permutation of
hideminor/hideliu/hidemyself/hideanons, login redirects carrying `returnto=`, and
thousands of oldid/diff pairs. Under 1 row in 100 is content.
`wayback-index.py` filters that to a few hundred URLs, one best snapshot each.

Snapshot URLs use the **`id_` modifier** (`/web/<ts>id_/<url>`), which returns the
originally archived bytes — no Wayback toolbar, no link rewriting to undo later.

## Recovery gaps, deliberately visible

- **39 `File:` pages have no source in any capture.** The wiki refused anonymous
  edits there, so the Archive captured a permission-denied form with an empty
  readonly textarea. This is permanent, not transient — `harvest-wiki.py` records
  them in `harvest-wiki-nosource.txt`, apart from real failures, so nobody
  re-runs them hoping for a different answer. They fall back to rendered HTML.
- **Nothing is known to be lost.** Two filenames looked like the one real gap —
  `6502_dc_sheet2-8-12-75.id.jpeg` and `6502_rb_sheet1-11-74.id.jpeg`, with
  description pages but no binary at any resolution. They are **red links**: the
  archived pages read "No file by this name exists" and Wayback has zero rows for
  either name at any status or date. The schematics survive under
  `6502_schematic_sheet{1-11-74,2-8-12-75}.id.jpeg` (2593×873, 2597×877).
  A MediaWiki `File:` page proves a filename was *referenced*, not that anything
  was stored under it — from a CDX index alone a red link and a deletion look
  identical. `wayback-index.py` now separates them using the rendered capture,
  so this needs `harvest-wiki.py` to have run first.
- The build marks these rather than hiding them: gold links are Wayback-only,
  struck-red links were never archived. An archive that hides its gaps is worth
  less than one that shows them.

## Invariants

- **`build-wiki.py` fails rather than emit a page without the attribution
  banner**, and `archive-deploy.sh` refuses to publish an `index.html` missing the
  licence or the authors' names. This is CC BY-NC-SA material; the banner *is*
  the licence compliance, not decoration.
- **Full-size image links point at our own mirror, not at visual6502.org.** An
  archive that sources originals from the site it is archiving stops working the
  moment that site does. This is not theoretical: `fill-gaps.py` found two Atari
  TIA scans that the origin now 404s and only the Archive still holds.
- **`archive/public/full` is a relative symlink** to the *whole*
  `../mirror/visual6502.org` tree, not just `images/`, so `mirror/` must be
  published as a *sibling* of `archive/`. The site's own per-chip pages live at
  `images/pages/*.html` and reference `../<chip>/photo.jpg` and `../../main.css`;
  serving the tree intact makes every relative link resolve as it did originally,
  with no rewriting to get wrong. `rsync -a` preserves the symlink rather than
  copying 2.3 GB through it.
- **Everything served must be reachable by clicking.** `File:` pages embed their
  image (their wikitext is only the description — MediaWiki supplied the picture),
  and `wiki/images.html` is a contact sheet of all 83 so the ones whose articles
  survive only as renderings still have a home. Reachable only as a thumbnail is a
  quieter version of not reachable at all.
- **The simulator links to the archive** (header nav and credit section), and the
  archive carries the **same header back** (`archive/tools/shell.py`). It did not
  at first, which reproduced the exact failure the archive exists to undo. The
  three builders each emit their own stylesheet, so without a shared header they
  grew three, and the archive read as three sites stapled together. The markup
  matches `web/index.html` exactly so `web/site-nav.js` drives the disclosure
  menu on both.
  - **Import it by name, not as a module.** `build-wiki.py` and
    `build-gallery.py` each define their own `shell()` function, which rebinds
    the module-level name and turns `shell.header` into an `AttributeError` at
    build time.
  - The **mirrored original pages under `full/` deliberately keep no header** —
    they are third-party archived content, and rewriting them would misrepresent
    what was captured.
- **`archive/public/` is not cleaned between builds.** A stale `site/` directory
  survived there from before the `full/` symlink existed: 17 MB that nothing
  linked to, which is precisely the orphaned-content failure being undone. Check
  for top-level entries no builder writes.
- **Nothing fetched is committed** — only `archive/urls/` (the manifests, which
  are ours) and the tools. Same reasoning as the `extern/` submodule: this repo
  points at NC-SA data rather than redistributing it.
- **Harvesting is deliberately slow** (`--wait`, `--limit-rate`, resumable).
  visual6502.org is a fragile fifteen-year-old server and the one way this
  exercise could do real harm is by knocking it over. Do not "optimise" the rate
  limits.
- The archive deploys **beside** `releases/`, not inside one: it is ~2.5 GB that
  changes only when something new is recovered, and copying that on every
  front-end deploy would be absurd.
