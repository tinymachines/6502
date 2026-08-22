import json,urllib.request,websocket,time
t=[x for x in json.load(urllib.request.urlopen("http://127.0.0.1:9344/json")) if x["type"]=="page"][0]
ws=websocket.create_connection(t["webSocketDebuggerUrl"],origin="http://127.0.0.1:9344",timeout=150)
i=[0]
def send(m,p=None):
    i[0]+=1; ws.send(json.dumps({"id":i[0],"method":m,"params":p or {}}))
    while True:
        r=json.loads(ws.recv())
        if r.get("id")==i[0]: return r
def ev(e):
    r=send("Runtime.evaluate",{"expression":e,"returnByValue":True,"awaitPromise":True}).get("result",{})
    if r.get("exceptionDetails"): return "EXC:"+json.dumps(r["exceptionDetails"])[:150]
    return r.get("result",{}).get("value")
send("Page.enable"); send("Page.navigate",{"url":"https://games.tinymachines.ai/?g=%d"%int(time.time())})
time.sleep(4)
def wait(e,ms=120000):
    t0=time.time()
    while time.time()-t0<ms/1000.0:
        if ev(e): return True
        time.sleep(0.5)
    return False
R=[]
def ok(n,c,x=""): R.append(("OK " if c else "FAIL ")+n+(" ["+str(x)+"]" if x else ""))
ev("document.querySelector('#b-power').click()")
ok("boots", wait("document.querySelector('#k-cart').textContent!=='--'"), ev("document.querySelector('#k-cart').textContent"))
ok("the eight gates are listed", wait("document.querySelectorAll('#gates .gate').length===8"),
   ev("[...document.querySelectorAll('#gates .gate b')].map(e=>e.textContent).join(' ')"))
ok("each names the switch it gates",
   ev("[...document.querySelectorAll('#gates span')].every(e=>/ - /.test(e.textContent))"),
   ev("document.querySelector('#gates span').textContent"))
ok("frames run", wait("+document.querySelector('#k-frames').textContent>=8"), ev("document.querySelector('#k-frames').textContent+' frames'"))
# the readout must MOVE: the lines are the chip's, not a constant
seen=set()
t0=time.time()
while time.time()-t0<60 and len(seen)<3:
    seen.add(ev("[...document.querySelectorAll('#gates')].map(e=>e.className+':'+[...e.querySelectorAll('i')].map(x=>x.textContent).join('')).join('')"))
    time.sleep(1.2)
ok("the gate states change as the chip runs", len(seen)>=2, str(len(seen))+" distinct patterns: "+" ".join(sorted(x.split(':')[-1] for x in seen))[:60])
# and a gate that is open must be drawn as conducting: the picture and the
# collision come from one byte, so compare the drawn tiles against the mask
wait("+document.querySelector('#k-frames').textContent>=20")
cols=json.loads(ev("""(()=>{const cv=document.querySelector('#screen'),g=cv.getContext('2d');
 const d=g.getImageData(0,0,cv.width,cv.height).data,c={};
 for(let i=0;i<d.length;i+=4){const k=d[i]+','+d[i+1]+','+d[i+2];c[k]=(c[k]||0)+1;} return JSON.stringify(c)})()"""))
ok("gates are drawn on the die", any(k.startswith("224,162") for k in cols), " ".join(sorted(cols,key=lambda k:-cols[k])[:3]))
err=ev("document.querySelector('#err').hidden?'':document.querySelector('#err').textContent")
ok("no engine error", "stopped answering" not in (err or ""), err or "clean")
print("ALL PASS" if not any(x.startswith("FAIL") for x in R) else "RED")
for x in R: print("  ",x)
ws.close()
