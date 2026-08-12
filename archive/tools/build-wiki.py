#!/usr/bin/env python3
"""Rebuild the visual6502 wiki as a static site from recovered wikitext.

    python3 archive/tools/build-wiki.py            # -> archive/wiki-site/

Input is archive/wiki-raw/wikitext/*.wiki, extracted from archived MediaWiki
edit forms by harvest-wiki.py. Output is plain HTML with no database, no PHP and
no JavaScript -- the failure mode that killed the original is a running service,
so the rebuild deliberately has none.

This implements the subset of MediaWiki markup the wiki actually uses, measured
rather than assumed: headings, lists, tables, bold/italic, internal and external
links, file embeds, indents and rules. Unsupported constructs degrade to visible
text rather than vanishing, so a gap looks like a gap.

Link resolution is the interesting part. An internal [[link]] resolves three
ways: to a local page if we recovered it, to the Wayback snapshot if the page
existed but we only have it rendered, and otherwise to the dead original marked
as such. A reader can always tell what survived from what did not, which for an
archive matters more than looking complete.
"""

import html
import json
import re
import shutil
import sys
import urllib.parse as up
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "wiki-raw"
OUT = ROOT / "public" / "wiki"
MANIFEST = ROOT / "urls" / "wiki-manifest.json"

ORIGINAL = "http://visual6502.org/wiki/index.php?title="
ATTRIB = ("Visual6502 project &mdash; Greg James, Barry Silverman and "
          "Brian Silverman, and the Visual6502 team")
LICENCE = "https://creativecommons.org/licenses/by-nc-sa/3.0/"

# Simple inline HTML that appears in the source and is safe to pass through.
# Everything else stays escaped: this is archived third-party content and it is
# not worth rendering arbitrary markup to save a few line breaks.
SAFE_TAGS = ["br", "b", "i", "u", "s", "sub", "sup", "small", "tt", "code", "hr"]


# --------------------------------------------------------------------------
# Titles
# --------------------------------------------------------------------------

def norm(title: str) -> str:
    """MediaWiki title normalisation: spaces are underscores, first char upper."""
    t = up.unquote(title.strip()).replace(" ", "_")
    t = re.sub(r"_+", "_", t).strip("_")
    if not t:
        return t
    # Only the first character of the page name is auto-capitalised, and the
    # namespace prefix is separate, so Foo:bar -> Foo:Bar.
    if ":" in t:
        ns, rest = t.split(":", 1)
        return f"{ns}:{rest[:1].upper()}{rest[1:]}" if rest else t
    return t[:1].upper() + t[1:]


def slug(title: str) -> str:
    """Filename for a title, matching harvest-wiki.py's on-disk convention."""
    return norm(title).replace(":", "__").replace("/", "___")


def page_href(title: str) -> str:
    return slug(title) + ".html"


# --------------------------------------------------------------------------
# Inline markup
# --------------------------------------------------------------------------

class Converter:
    def __init__(self, local: set, known: dict, images: dict):
        self.local = local          # titles we hold as wikitext
        self.known = known          # title -> manifest entry (all 169)
        self.images = images        # filename -> path relative to OUT
        self.missing = defaultdict(set)   # title -> set of pages linking to it

    # -- links -----------------------------------------------------------
    def link_internal(self, target: str, label: str, src: str) -> str:
        # inline() escapes before parsing, so a title containing an apostrophe
        # ("Atari's 6507 Schematics") arrives here as an entity and would be
        # normalised into a different, nonexistent page.
        target = html.unescape(target).strip()
        if not target:
            return label
        # Some pages wrap an external URL in [[...]]; treat it as external.
        if re.match(r"^(https?:|//)", target):
            return f'<a class="ext" href="{target}" rel="noopener">{label}</a>'
        # Special: is navigation MediaWiki generates for itself. There is
        # nothing to link to and never was a stored page, so it is not a gap.
        if target.split(":")[0].lower() == "special":
            return f'<span class="tmpl">{label}</span>'
        t = norm(target.split("#")[0])
        frag = target.split("#", 1)[1] if "#" in target else ""
        anchor = "#" + re.sub(r"[^\w-]", "_", norm(frag)) if frag else ""
        if not t:
            return f'<a href="{anchor}">{label}</a>'   # [[#Section]], same page
        if t in self.local:
            return f'<a href="{page_href(t)}{anchor}">{label}</a>'
        entry = self.known.get(t)
        if entry:
            # Existed, but we only have it as a rendering.
            return (f'<a class="wb" href="{entry["rendered"]["url"]}" '
                    f'title="not recovered as source; Wayback snapshot '
                    f'{entry["rendered"]["timestamp"][:8]}">{label}</a>')
        self.missing[t].add(src)
        return (f'<a class="dead" href="{ORIGINAL}{up.quote(t)}" '
                f'title="page not archived; original is offline">{label}</a>')

    def embed_file(self, body: str, src: str) -> str:
        parts = html.unescape(body).split("|")
        name = parts[0].split(":", 1)[1].strip() if ":" in parts[0] else parts[0]
        name = norm(name)
        caption = parts[-1] if len(parts) > 1 else ""
        # Drop MediaWiki's layout keywords; they are not meaningful here.
        if re.fullmatch(r"(thumb|frame|border|right|left|center|none|\d+px)", caption.strip(), re.I):
            caption = ""
        path = self.images.get(name) or self.images.get(name.replace("_", " "))
        cap = self.inline(caption, src) if caption else ""
        if path:
            img = (f'<a href="{path}"><img loading="lazy" src="{path}" '
                   f'alt="{html.escape(caption or name)}"></a>')
        else:
            img = (f'<p class="lost">Image not archived: '
                   f'<code>{html.escape(name)}</code></p>')
        return (f'<figure>{img}' + (f"<figcaption>{cap}</figcaption>" if cap else "")
                + "</figure>")

    def inline(self, text: str, src: str) -> str:
        text = html.escape(text)
        out, i = [], 0
        # [[...]] first: labels may contain [ ] which would confuse the
        # external-link pattern if it ran first.
        pat = re.compile(r"\[\[(.+?)\]\]|\[(https?://\S+?)(?:\s+([^\]]*))?\]", re.S)
        for m in pat.finditer(text):
            out.append(self._fmt(text[i:m.start()]))
            i = m.end()
            if m.group(1) is not None:
                body = m.group(1)
                if re.match(r"\s*(File|Image)\s*:", body, re.I):
                    out.append(self.embed_file(body, src))
                else:
                    tgt, _, lab = body.partition("|")
                    out.append(self.link_internal(
                        tgt, self._fmt(lab or tgt), src))
            else:
                url = m.group(2)
                lab = self._fmt(m.group(3) or url)
                out.append(f'<a class="ext" href="{url}" rel="noopener">{lab}</a>')
        out.append(self._fmt(text[i:]))
        return "".join(out)

    @staticmethod
    def _fmt(t: str) -> str:
        t = re.sub(r"'''(.+?)'''", r"<strong>\1</strong>", t, flags=re.S)
        t = re.sub(r"''(.+?)''", r"<em>\1</em>", t, flags=re.S)
        # Bare URLs, avoiding ones already inside an attribute we just built.
        t = re.sub(r'(?<![">=\w])(https?://[^\s<]+[^\s<.,;:)\]])',
                   r'<a class="ext" href="\1" rel="noopener">\1</a>', t)
        for tag in SAFE_TAGS:
            t = re.sub(rf"&lt;\s*({tag})\s*/?\s*&gt;", r"<\1>", t, flags=re.I)
            t = re.sub(rf"&lt;/\s*({tag})\s*&gt;", r"</\1>", t, flags=re.I)
        # Templates are not implemented; show the call rather than dropping it.
        t = re.sub(r"\{\{([^}]*)\}\}", r'<span class="tmpl">{{\1}}</span>', t)
        return t

    # -- blocks ----------------------------------------------------------
    def convert(self, text: str, src: str) -> tuple:
        text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        lines = text.replace("\r\n", "\n").split("\n")
        out, toc, i = [], [], 0
        para: list = []

        def flush():
            if para:
                out.append(f"<p>{self.inline(' '.join(para), src)}</p>")
                para.clear()

        while i < len(lines):
            ln = lines[i]
            s = ln.strip()

            if not s:
                flush(); i += 1; continue

            m = re.match(r"^(={2,6})\s*(.+?)\s*\1\s*$", s)
            if m:
                flush()
                lvl, txt = len(m.group(1)), m.group(2)
                aid = re.sub(r"[^\w-]", "_", norm(re.sub(r"\[\[|\]\]|'''|''", "", txt)))
                toc.append((lvl, txt, aid))
                out.append(f'<h{lvl} id="{aid}">{self.inline(txt, src)}</h{lvl}>')
                i += 1; continue

            if re.match(r"^-{4,}$", s):
                flush(); out.append("<hr>"); i += 1; continue

            if s.startswith("{|"):
                flush()
                j = i
                depth = 0
                while j < len(lines):
                    t = lines[j].strip()
                    if t.startswith("{|"): depth += 1
                    if t.startswith("|}"):
                        depth -= 1
                        if depth == 0: break
                    j += 1
                out.append(self.table(lines[i:j + 1], src))
                i = j + 1; continue

            if s[0] in "*#:;":
                flush()
                j = i
                while j < len(lines) and lines[j].strip() and lines[j].strip()[0] in "*#:;":
                    j += 1
                out.append(self.lists(lines[i:j], src))
                i = j; continue

            if ln.startswith(" ") and s:
                flush()
                j = i
                while j < len(lines) and lines[j].startswith(" "):
                    j += 1
                body = "\n".join(l[1:] for l in lines[i:j])
                out.append(f"<pre>{html.escape(body)}</pre>")
                i = j; continue

            para.append(s)
            i += 1

        flush()
        return "\n".join(out), toc

    def lists(self, lines: list, src: str) -> str:
        """Nested lists. MediaWiki encodes depth as prefix length, not indent."""
        html_out, stack = [], []
        kind = {"*": "ul", "#": "ol", ":": "dl", ";": "dl"}
        for ln in lines:
            s = ln.strip()
            pre = re.match(r"^([*#:;]+)", s).group(1)
            body = s[len(pre):].strip()
            while len(stack) > len(pre) or (stack and stack[-1] != kind[pre[len(stack) - 1]]
                                            and len(stack) == len(pre)):
                html_out.append(f"</{stack.pop()}>")
            while len(stack) < len(pre):
                t = kind[pre[len(stack)]]
                html_out.append(f"<{t}>")
                stack.append(t)
            tag = "dt" if pre[-1] == ";" else ("dd" if pre[-1] == ":" else "li")
            html_out.append(f"<{tag}>{self.inline(body, src)}</{tag}>")
        while stack:
            html_out.append(f"</{stack.pop()}>")
        return "".join(html_out)

    def table(self, lines: list, src: str) -> str:
        rows, cur, caption = [], None, ""
        for ln in lines[1:]:
            s = ln.strip()
            if s.startswith("|}"):
                break
            if s.startswith("|+"):
                caption = s[2:].strip(); continue
            if s.startswith("|-"):
                if cur is not None:
                    rows.append(cur)
                cur = []
                continue
            if cur is None:
                cur = []
            if s.startswith("!"):
                cells = re.split(r"\s*!!\s*", s[1:])
                cur += [("th", c) for c in cells]
            elif s.startswith("|"):
                cells = re.split(r"\s*\|\|\s*", s[1:])
                cur += [("td", c) for c in cells]
            elif cur:
                # Continuation of the previous cell.
                tag, prev = cur[-1]
                cur[-1] = (tag, prev + " " + s)
        if cur:
            rows.append(cur)

        body = []
        for r in rows:
            if not r:
                continue
            tds = []
            for tag, cell in r:
                # Strip cell attributes: `style="..." | value`.
                if "|" in cell and "=" in cell.split("|")[0]:
                    cell = cell.split("|", 1)[1]
                tds.append(f"<{tag}>{self.inline(cell.strip(), src)}</{tag}>")
            body.append("<tr>" + "".join(tds) + "</tr>")
        cap = f"<caption>{self.inline(caption, src)}</caption>" if caption else ""
        return f'<div class="tablewrap"><table>{cap}{"".join(body)}</table></div>'


# --------------------------------------------------------------------------
# Page shell
# --------------------------------------------------------------------------

CSS = """
:root{--space:#0b1120;--surface:#131c2f;--subtle:#1a2740;--line:#3d5573;
--fg:#eaf2ff;--muted:#9fb3cc;--accent:#22d3ee;--gold:#7dd3fc;--warn:#fb7185;
--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--mono:"SFMono-Regular","SF Mono",ui-monospace,Consolas,monospace;
--hard:5px 5px 0 rgba(2,6,16,.5)}
*{box-sizing:border-box}
body{margin:0;color:var(--fg);font-family:var(--sans);font-size:16px;line-height:1.65;
background:radial-gradient(circle at 12% 6%,#22d3ee1f,transparent 30rem),
radial-gradient(circle at 88% 10%,#7dd3fc16,transparent 28rem),
linear-gradient(135deg,var(--space),#0e1830 56%,var(--subtle));background-attachment:fixed}
.wrap{max-width:64rem;margin:0 auto;padding:0 1.25rem 5rem}
header.top{position:sticky;top:0;z-index:5;background:#0b1120ee;
backdrop-filter:blur(8px);border-bottom:2px solid var(--line)}
header.top .wrap{display:flex;gap:1rem;align-items:center;justify-content:space-between;
padding-top:.75rem;padding-bottom:.75rem}
header.top a{color:var(--fg);text-decoration:none;font-weight:800}
header.top nav a{color:var(--muted);font-weight:600;margin-left:1rem;font-size:.9rem}
header.top nav a:hover{color:var(--accent)}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.14em;
text-transform:uppercase;color:var(--accent)}
h1{font-weight:900;font-size:clamp(1.7rem,4vw,2.6rem);line-height:1.1;margin:.4rem 0 1rem}
h2,h3,h4,h5,h6{font-weight:800;line-height:1.25;margin:2rem 0 .6rem}
h2{font-size:1.5rem;padding-bottom:.35rem;border-bottom:2px solid var(--line)}
h3{font-size:1.2rem}
a{color:var(--accent)}
a.ext::after{content:" \\2197";font-size:.8em;opacity:.7}
a.dead{color:var(--warn);text-decoration:line-through dotted}
a.wb{color:var(--gold);border-bottom:1px dotted currentColor;text-decoration:none}
.banner{border:2px solid var(--line);background:var(--surface);box-shadow:var(--hard);
padding:1rem 1.1rem;margin:1.5rem 0 2rem;font-size:.9rem;color:var(--muted)}
.banner strong{color:var(--fg)}
.banner .row{margin-top:.5rem;font-family:var(--mono);font-size:.78rem;word-break:break-all}
article{padding-top:2rem}
figure{margin:1.5rem 0;border:2px solid var(--line);background:var(--surface);
box-shadow:var(--hard);padding:.6rem}
figure img{max-width:100%;height:auto;display:block}
figcaption{color:var(--muted);font-size:.86rem;padding:.5rem .2rem 0}
.lost{color:var(--warn);font-size:.9rem;margin:.3rem}
code,pre{font-family:var(--mono);font-size:.88em}
pre{background:#0a1526;border:2px solid var(--line);padding:.9rem;overflow-x:auto}
code{background:#0a1526;padding:.1rem .3rem;border-radius:3px}
.tablewrap{overflow-x:auto;border:2px solid var(--line);box-shadow:var(--hard);
background:var(--surface);margin:1.5rem 0}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{border:1px solid var(--line);padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:var(--subtle);font-weight:700;position:sticky;top:0}
tr:nth-child(even) td{background:#0f1930}
ul,ol{padding-left:1.4rem}
li{margin:.25rem 0}
.tmpl{font-family:var(--mono);font-size:.8em;color:var(--muted);opacity:.7}
.toc{border:2px solid var(--line);background:var(--surface);padding:.9rem 1.1rem;
margin:1.5rem 0;box-shadow:var(--hard)}
.toc div{font-family:var(--mono);font-size:.72rem;letter-spacing:.12em;
text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:.12rem 0}
.toc a:hover{color:var(--accent)}
.toc .l3{padding-left:1rem;font-size:.92em}
.idx{display:grid;gap:.5rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr));
padding:0;list-style:none}
.idx a{display:block;border:2px solid var(--line);background:var(--surface);
padding:.6rem .75rem;text-decoration:none;color:var(--fg);font-weight:600;font-size:.92rem}
.idx a:hover{border-color:var(--accent);box-shadow:var(--hard)}
.idx a small{display:block;color:var(--muted);font-weight:400;font-family:var(--mono);
font-size:.7rem;margin-top:.15rem}
footer{margin-top:4rem;padding-top:1.5rem;border-top:2px solid var(--line);
color:var(--muted);font-size:.85rem}
@media(max-width:40rem){header.top nav a{margin-left:.6rem;font-size:.8rem}}
"""


def shell(title: str, body: str, *, banner: str, home: str = "index.html",
          desc: str = "") -> str:
    if "Archived copy" not in banner:
        # The banner carries the CC BY-NC-SA attribution. A page without it is a
        # licence violation, so this fails the build rather than shipping.
        raise SystemExit("build-wiki: refusing to emit a page without attribution")
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} — visual6502 wiki (archived)</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="stylesheet" href="wiki.css">
</head><body>
<header class="top"><div class="wrap">
  <a href="{home}">visual6502 wiki <span class="eyebrow">archived</span></a>
  <nav>
    <a href="{home}">Index</a>
    <a href="http://visual6502.org/">Original site</a>
    <a href="/">Simulator</a>
  </nav>
</div></header>
<div class="wrap"><article>
{banner}
{body}
<footer>
  Content &copy; the {ATTRIB}, licensed
  <a class="ext" href="{LICENCE}" rel="noopener">CC BY-NC-SA 3.0</a>.
  Mirrored for preservation; not affiliated with the Visual6502 project.
</footer>
</article></div>
</body></html>
"""


def banner_for(title: str, entry: dict | None, kind: str) -> str:
    if entry:
        src = entry["wikitext"] or entry["rendered"]
        ts = src["timestamp"]
        when = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"
        snap, orig = src["url"], src["original"]
    else:
        when, snap, orig = "unknown", "", ORIGINAL + up.quote(title)
    return f"""<div class="banner">
<strong>Archived copy.</strong> The original page at visual6502.org has been
returning HTTP 500 since the wiki's MediaWiki installation failed. This is a
static reconstruction from {kind} captured by the Internet Archive on
<strong>{when}</strong>, by the {ATTRIB}, licensed
<a class="ext" href="{LICENCE}" rel="noopener">CC BY-NC-SA 3.0</a>.
<div class="row">original: <a class="ext" href="{orig}" rel="noopener">{html.escape(orig)}</a></div>
{f'<div class="row">snapshot: <a class="ext" href="{snap}" rel="noopener">{html.escape(snap)}</a></div>' if snap else ''}
</div>"""


# --------------------------------------------------------------------------

def main() -> None:
    srcdir = RAW / "wikitext"
    if not srcdir.exists() or not any(srcdir.glob("*.wiki")):
        sys.exit("no wikitext yet -- run archive/tools/harvest-wiki.py first")

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"pages": []}
    known = {norm(p["title"]): p for p in manifest["pages"]}

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "images").mkdir(parents=True)

    # Copy recovered images and index them by filename for [[File:...]].
    images = {}
    srcimg = RAW / "images"
    if srcimg.exists():
        for f in srcimg.rglob("*"):
            if f.is_file():
                dest = OUT / "images" / f.name
                shutil.copy2(f, dest)
                images[norm(f.name)] = f"images/{f.name}"
    print(f"images: {len(images)}")

    pages = {}
    for f in sorted(srcdir.glob("*.wiki")):
        title = f.stem.replace("___", "/").replace("__", ":")
        pages[norm(title)] = f.read_text(encoding="utf-8", errors="replace")

    conv = Converter(set(pages), known, images)

    for title, text in sorted(pages.items()):
        body, toc = conv.convert(text, title)
        if len(toc) > 3:
            items = "".join(
                '<a class="l%d" href="#%s">%s</a>'
                % (min(l, 3), a, html.escape(re.sub(r"\[\[|\]\]", "", t)))
                for l, t, a in toc)
            body = f'<div class="toc"><div>On this page</div>{items}</div>\n' + body
        entry = known.get(title)
        page = shell(title.replace("_", " "),
                     f"<h1>{html.escape(title.replace('_', ' '))}</h1>\n{body}",
                     banner=banner_for(title, entry, "the page's original wikitext"),
                     desc=f"Archived visual6502 wiki page: {title.replace('_', ' ')}")
        (OUT / page_href(title)).write_text(page, encoding="utf-8")

    # Index, grouped by namespace.
    groups = defaultdict(list)
    for t in sorted(pages):
        ns = t.split(":")[0] if ":" in t else "Articles"
        groups[ns].append(t)
    order = ["Articles"] + sorted(k for k in groups if k != "Articles")
    sections = []
    for ns in order:
        items = "".join(
            f'<li><a href="{page_href(t)}">{html.escape(t.split(":", 1)[-1].replace("_", " "))}'
            f"</a></li>" for t in groups[ns])
        sections.append(f'<h2 id="{ns}">{html.escape(ns)} '
                        f'<span class="eyebrow">{len(groups[ns])}</span></h2>'
                        f'<ul class="idx">{items}</ul>')

    only_rendered = sorted(set(known) - set(pages))
    if only_rendered:
        items = "".join(
            f'<li><a class="wb" href="{known[t]["rendered"]["url"]}">'
            f'{html.escape(t.replace("_", " "))}<small>Wayback only</small></a></li>'
            for t in only_rendered)
        sections.append('<h2 id="rendered">Recovered as rendering only '
                        f'<span class="eyebrow">{len(only_rendered)}</span></h2>'
                        "<p>No wikitext was archived for these, so they are linked "
                        "to the Internet Archive rather than rebuilt.</p>"
                        f'<ul class="idx">{items}</ul>')

    intro = f"""<h1>The visual6502 wiki, rebuilt</h1>
<p>The Visual6502 project's wiki has been returning HTTP 500 on every page since
its MediaWiki installation failed. This is a static reconstruction of
<strong>{len(pages)}</strong> pages from source recovered out of the Internet
Archive, so that a decade of research on the 6502 and its contemporaries stays
readable.</p>
<p>Pages are rebuilt from the original wikitext where it survived. Links are
marked to show what survived: <a class="wb" href="#">gold</a> means the page
exists only as a Wayback rendering, <a class="dead" href="#">struck red</a>
means no copy was archived at all.</p>"""

    (OUT / "index.html").write_text(shell(
        "Index", intro + "".join(sections),
        banner=banner_for("Main_Page", known.get("Main_Page"), "archived pages"),
        desc="Static reconstruction of the visual6502.org wiki."),
        encoding="utf-8")
    (OUT / "wiki.css").write_text(CSS, encoding="utf-8")

    print(f"pages: {len(pages)} rebuilt, {len(only_rendered)} rendering-only")
    if conv.missing:
        print(f"links to pages never archived: {len(conv.missing)}")
        for t, srcs in sorted(conv.missing.items())[:10]:
            print(f"    {t}  <- {', '.join(sorted(srcs)[:3])}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
