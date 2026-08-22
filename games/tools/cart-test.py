"""The loop, closed: a cartridge minted by the API, loaded from a file by the
page, playing on the chip. Drives the real page over CDP.

    python3 games/tools/mint.py --api http://127.0.0.1:6510
    python3 -m http.server 8899 --directory games &
    chromium --headless=new --remote-debugging-port=9346 --remote-allow-origins='*' \
             --user-data-dir=$HOME/.cart-cdp about:blank &
    python3 games/tools/cart-test.py

**Point `?api=` at a port you started yourself.** 6502 is held by the live
`6502-api` service on this box, so a local uvicorn silently fails to bind and
every request goes to production: the first run of this test passed against
the deployed API while claiming to test the build in the tree. `ss -ltn` before
believing a local server is yours.

The point of each assertion is that it could fail. The cartridge carries the
tiles, so the palette check would go red on a sheet that did not travel; the
ROM bytes come out of the file rather than a .rom beside the page, so booting
proves the hex made it; and the frames-run check is what says the eight
contract addresses in the file were the right eight.
"""
import json, time, urllib.request, websocket

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
def wait(e, ms=120000):
    t0 = time.time()
    while time.time() - t0 < ms / 1000.0:
        if ev(e): return True
        time.sleep(0.5)
    return False

R = []
def ok(n, c, x=""): R.append(("OK   " if c else "FAIL ") + n + (" [" + str(x) + "]" if x else ""))

URL = ("http://127.0.0.1:8899/?api=http://127.0.0.1:6510"
       "&cart=http://127.0.0.1:8899/dierunner.cart.gz&t=%d" % int(time.time()))
send("Page.enable"); send("Page.navigate", {"url": URL}); time.sleep(4)

ok("the cartridge loads from the file",
   wait("document.querySelector('#k-cart').textContent.indexOf('Die Runner')>=0"),
   ev("document.querySelector('#k-cart').textContent"))
ok("...and it says how big the ROM in it is",
   ev("/\\d+B/.test(document.querySelector('#k-cart').textContent)"),
   ev("document.querySelector('#k-cart').textContent"))
ok("the picker gained an entry rather than lying about what is on screen",
   ev("document.querySelector('#cart').selectedOptions[0].textContent.indexOf('(loaded)')>=0"),
   ev("document.querySelector('#cart').selectedOptions[0].textContent"))
ok("the blurb came out of the file",
   ev("document.querySelector('#note').textContent.indexOf('Thread the gates')>=0"))

COLS = """(()=>{const cv=document.querySelector('#screen'),g=cv.getContext('2d');
 const d=g.getImageData(0,0,cv.width,cv.height).data,c={};
 for(let i=0;i<d.length;i+=4){const k=d[i]+','+d[i+1]+','+d[i+2];c[k]=(c[k]||0)+1;}
 return JSON.stringify(c)})()"""
PAL = {"11,17,32", "62,147,166", "224,162,75", "79,191,212"}
cols = json.loads(ev(COLS))
ok("the tiles travelled in the cartridge and draw in the palette", set(cols) <= PAL,
   " ".join(sorted(cols, key=lambda k: -cols[k])))

ev("document.querySelector('#b-power').click()")
ok("it boots from bytes that came out of the file",
   wait("document.querySelector('#k-frames') && +document.querySelector('#k-frames').textContent>=1"),
   ev("document.querySelector('#err').textContent || 'no error'"))
ok("frames run, so the contract in the file was the right contract",
   wait("+document.querySelector('#k-frames').textContent>=12"),
   ev("document.querySelector('#k-frames').textContent+' frames'"))
ok("one request a frame, as the format's frame_cost promises",
   abs(int(ev("+document.querySelector('#k-req').textContent"))
       - int(ev("+document.querySelector('#k-frames').textContent"))) <= 3,
   "%s requests / %s frames" % (ev("document.querySelector('#k-req').textContent"),
                                ev("document.querySelector('#k-frames').textContent")))
cols = json.loads(ev(COLS))
ok("the die is drawn, in the palette and nothing else", set(cols) <= PAL and len(cols) >= 3,
   "%d colours" % len(cols))
ok("the gates are lit off the running chip",
   ev("document.querySelectorAll('#gates .gate').length>=8"),
   ev("document.querySelectorAll('#gates .gate.hi').length+' of '+document.querySelectorAll('#gates .gate').length+' high'"))
ok("no engine error", "engine" not in (ev("document.querySelector('#err').textContent") or ""),
   ev("document.querySelector('#err').textContent") or "clean")

print("\n".join(R))
print("\n" + ("ALL PASS" if all(x.startswith("OK") for x in R) else "RED"))
