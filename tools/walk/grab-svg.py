#!/usr/bin/env python3
"""Pull a real schematic out of the live page, as a standalone SVG.

The site draws its schematics with `sch-draw.js` and styles them from
`style.css`. Rather than reimplement either (a second drawing of an NMOS gate
would eventually draw it differently, which is the failure this project keeps
finding), this drives the actual page and inlines the actual rules.

    python3 tools/walk/grab-svg.py 'signal=dpc3_SBX&dir=back&depth=1' out.svg
"""
import os, re, subprocess, sys, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOST = os.environ.get("HOST", "https://6502.tinymachines.ai")
CHROME = os.environ.get("CHROME", "/snap/bin/chromium")

def styles():
    """The .sch-* rules, with :root custom properties substituted in.

    A standalone SVG inherits no stylesheet, so every var() has to be resolved
    or the whole declaration is dropped and the drawing comes out unstyled --
    the same silent failure a mistyped token causes on the site itself.
    """
    css = open(os.path.join(ROOT, "web", "style.css")).read()
    root = dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", css[css.find(":root"):css.find("}", css.find(":root"))]))
    out = []
    for m in re.finditer(r"(^[ \t]*(?:\.sch-|\.solo )[^{}]*)\{([^}]*)\}", css, re.M):
        sel, body = m.group(1).strip(), m.group(2)
        if sel.startswith(".sch-controls") or "input" in sel or "select" in sel:
            continue
        for _ in range(3):
            body = re.sub(r"var\((--[\w-]+)(?:\s*,[^)]*)?\)",
                          lambda mm: root.get(mm.group(1), "inherit").strip(), body)
        out.append("%s{%s}" % (sel, " ".join(body.split())))
    return "\n".join(out)

def grab(query, dest):
    # Encode each value. A die name can contain `#` (115 of them do), and a
    # raw `#` in a URL starts the FRAGMENT: the query is truncated, the page
    # falls back to its default signal, and you get a perfectly good schematic
    # of the wrong wire. Which is what happened, and it looked fine.
    parts = []
    for kv in query.split("&"):
        k, _, v = kv.partition("=")
        parts.append("%s=%s" % (k, urllib.parse.quote(v, safe="")))
    url = "%s/schematic?%s" % (HOST, "&".join(parts))
    dom = subprocess.run(
        [CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
         "--virtual-time-budget=30000", "--dump-dom", url],
        capture_output=True, text=True).stdout
    m = re.search(r'<svg id="sch-svg".*?</svg>', dom, re.S)
    if not m:
        print("FAIL no #sch-svg at %s" % url); return False
    svg = m.group(0)
    # The camera transform belongs to the page's pan and zoom, not to the
    # drawing; a captured SVG must sit at its own origin.
    svg = re.sub(r'(<g class="sch-cam") transform="[^"]*"', r"\1", svg)
    svg = svg.replace(">", '><style>%s</style>' % styles(), 1)
    svg = svg.replace('<svg id="sch-svg"',
                      '<svg xmlns="http://www.w3.org/2000/svg" id="sch-svg"', 1)
    # An SVG on a light page needs its own ground: the site paints the stage.
    m2 = re.search(r'viewBox="([\d.\- ]+)"', svg)
    if m2:
        x, y, w, h = (float(v) for v in m2.group(1).split())
        svg = re.sub(r"(</style>)",
                     r'\1<rect x="%g" y="%g" width="%g" height="%g" fill="#0b1120"/>'
                     % (x - 2, y - 2, w + 4, h + 4), svg, count=1)
    # The page draws the signal it was given; check the drawing says so,
    # because a fallback to the default renders perfectly and is wrong.
    want = dict(kv.split("=", 1) for kv in query.split("&")).get("signal")
    if want and (">%s<" % want) not in svg:
        print("FAIL asked for %s but the drawing does not name it" % want)
        return False
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    open(dest, "w").write(svg)
    print("wrote %s (%d bytes) from ?%s" % (dest, len(svg), query))
    return True

if __name__ == "__main__":
    if len(sys.argv) < 3: print(__doc__); sys.exit(2)
    sys.exit(0 if grab(sys.argv[1], sys.argv[2]) else 1)
