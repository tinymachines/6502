"""The registry pages, driven for real: the index, a builder page, and the
console playing a published ROM.

    chromium --headless=new --remote-debugging-port=9346 \
             --remote-allow-origins='*' --user-data-dir=$HOME/.cart-cdp about:blank &
    python3 games/tools/registry-test.py

Every assertion here is about something the API alone cannot tell you: that
the art decoded and drew, that the pretty URLs reach the right document, and
that a published ROM plays from its own address. Checking the JSON would only
say the JSON is right.
"""
import json, time, urllib.request, websocket

SITE = "https://games.tinymachines.ai"
HANDLE, SLUG = "tinymachines", "die-runner"

t = [x for x in json.load(urllib.request.urlopen("http://127.0.0.1:9346/json"))
     if x["type"] == "page"][0]
ws = websocket.create_connection(t["webSocketDebuggerUrl"],
                                 origin="http://127.0.0.1:9346", timeout=180)
i = [0]
def send(m, p=None):
    i[0] += 1; ws.send(json.dumps({"id": i[0], "method": m, "params": p or {}}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == i[0]: return r
def ev(e):
    r = send("Runtime.evaluate", {"expression": e, "returnByValue": True,
                                  "awaitPromise": True}).get("result", {})
    if r.get("exceptionDetails"): return "EXC:" + json.dumps(r["exceptionDetails"])[:200]
    return r.get("result", {}).get("value")
def go(path):
    send("Page.navigate", {"url": f"{SITE}{path}?t={int(time.time())}"}); time.sleep(3)
def wait(e, ms=90000):
    """An exception is not a pass, and this is why the check is spelled out.

    `ev` reports a thrown expression as the string "EXC:...", and a non-empty
    string is truthy: the first version of this harness reported "it boots" and
    "frames run on the chip" as OK on a page whose script had thrown, because
    the probe itself threw and the throw was the truthy value. A check that
    passes on an exception is worse than no check."""
    t0 = time.time()
    while time.time() - t0 < ms / 1000.0:
        v = ev(e)
        if isinstance(v, str) and v.startswith("EXC:"):
            return False
        if v:
            return True
        time.sleep(0.5)
    return False

R = []
def ok(n, c, x=""):
    if isinstance(c, str) and c.startswith("EXC:"):
        c = False                       # see wait(): a throw is never a pass
    R.append(("OK   " if c else "FAIL ") + n + (" [" + str(x)[:120] + "]" if x else ""))

# Every canvas on the page, as the set of colours it actually painted. The
# palette check is the one that says the art DECODED rather than that an
# element exists.
COLS = """(()=>{const out=[];for(const cv of document.querySelectorAll('canvas')){
 const g=cv.getContext('2d');if(!cv.width||!cv.height){out.push(null);continue;}
 const d=g.getImageData(0,0,cv.width,cv.height).data,c={};
 for(let i=0;i<d.length;i+=4){const k=d[i]+','+d[i+1]+','+d[i+2];c[k]=(c[k]||0)+1;}
 out.push(Object.keys(c));} return JSON.stringify(out)})()"""
PAL = {"11,17,32", "62,147,166", "224,162,75", "79,191,212"}

send("Page.enable")

# -- the index --------------------------------------------------------------
go("/builders")
ok("the index lists a builder",
   wait("document.querySelectorAll('#builders .b-card').length>=1"),
   ev("document.querySelector('#builders-head').textContent"))
ok("...and the newest ROM",
   ev("document.querySelectorAll('#latest .r-card').length>=1"),
   ev("document.querySelector('#latest-head').textContent"))
cols = [set(c) for c in json.loads(ev(COLS)) if c]
ok("the art on it decoded and drew in the palette",
   bool(cols) and all(c <= PAL for c in cols), f"{len(cols)} canvases")
ok("a builder card links to the page", ev(
   "!!document.querySelector('#builders .b-card h3 a[href=\\\"/b/%s\\\"]')" % HANDLE))
ok("nothing threw", "EXC" not in str(ev("document.querySelector('#err').textContent")),
   ev("document.querySelector('#err').textContent") or "clean")

# -- a builder page ---------------------------------------------------------
go(f"/b/{HANDLE}")
ok("the pretty URL reaches the builder document",
   wait("!document.querySelector('#profile').hidden"),
   ev("document.querySelector('#name').textContent"))
ok("the handle came out of the PATH, not a query",
   ev("location.search.indexOf('b=')<0 && location.pathname==='/b/%s'" % HANDLE),
   ev("location.pathname"))
ok("the bio and the links are on it",
   ev("document.querySelector('#bio').textContent.length>40 && "
      "document.querySelectorAll('#links a').length>=1"),
   ev("document.querySelectorAll('#links a').length+' links'"))
ok("outbound links cannot reach this page's opener",
   ev("[...document.querySelectorAll('#links a')].every(a=>a.rel.includes('noopener'))"))
ok("the ROM is listed with what the REGISTRY measured",
   ev("document.querySelector('#roms .r-card b') && "
      "document.body.textContent.indexOf('8,704')>=0"),
   ev("document.querySelector('#roms-head').textContent"))
cols = [set(c) for c in json.loads(ev(COLS)) if c]
ok("the avatar and the cover drew in the palette",
   len(cols) >= 2 and all(c <= PAL for c in cols), f"{len(cols)} canvases")
go("/b/no-such-builder-here")
ok("a missing builder says so rather than looking broken",
   wait("document.querySelector('#err') && "
        "document.querySelector('#err').textContent.indexOf('no builder')>=0"),
   ev("document.querySelector('#err').textContent"))

# -- playing it -------------------------------------------------------------
go(f"/b/{HANDLE}/{SLUG}")
ok("a ROM URL reaches the console",
   wait("document.querySelector('#k-cart') && "
        "document.querySelector('#k-cart').textContent.indexOf('Die Runner')>=0"),
   ev("document.querySelector('#k-cart').textContent"))
ok("...loaded from the registry, not from a file beside the page",
   ev("performance.getEntriesByType('resource').some(r=>r.name.indexOf('/v1/registry/')>=0)"))
ok("it credits whoever published it",
   ev("!!document.querySelector('header a[href=\\\"/b/%s\\\"]')" % HANDLE))
ev("document.querySelector('#b-power').click()")
ok("it boots", wait("+document.querySelector('#k-frames').textContent>=1"),
   ev("document.querySelector('#err').textContent") or "no error")
ok("frames run on the chip", wait("+document.querySelector('#k-frames').textContent>=10"),
   ev("document.querySelector('#k-frames').textContent+' frames'"))
ok("no engine error",
   "engine" not in (ev("document.querySelector('#err').textContent") or ""),
   ev("document.querySelector('#err').textContent") or "clean")

# -- the editor -------------------------------------------------------------
go("/manage")
ok("the editor asks for a token and shows nothing else",
   ev("!!document.querySelector('#token') && document.querySelector('#editor').hidden "
      "&& document.querySelector('#claim').hidden"))
ok("the token field is a password field, not a text one",
   ev("document.querySelector('#token').type==='password'"))

print("\n".join(R))
print("\n" + ("ALL PASS" if all(x.startswith("OK") for x in R) else "RED"))
