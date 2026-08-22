import json,urllib.request,websocket,time
t=[x for x in json.load(urllib.request.urlopen("http://127.0.0.1:9346/json")) if x["type"]=="page"][0]
ws=websocket.create_connection(t["webSocketDebuggerUrl"],origin="http://127.0.0.1:9346",timeout=150)
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
send("Page.enable"); send("Page.navigate",{"url":"https://games.tinymachines.ai/?a=%d"%int(time.time())})
time.sleep(5)
def wait(e,ms=120000):
    t0=time.time()
    while time.time()-t0<ms/1000.0:
        if ev(e): return True
        time.sleep(0.5)
    return False
R=[]
def ok(n,c,x=""): R.append(("OK " if c else "FAIL ")+n+(" ["+str(x)+"]" if x else ""))
ok("the sheet loads", wait("document.querySelector('#err').textContent.indexOf('16 tiles')>=0"),
   ev("document.querySelector('#err').textContent"))
COLS="""(()=>{const cv=document.querySelector('#screen'),g=cv.getContext('2d');
 const d=g.getImageData(0,0,cv.width,cv.height).data,c={};
 for(let i=0;i<d.length;i+=4){const k=d[i]+','+d[i+1]+','+d[i+2];c[k]=(c[k]||0)+1;} return JSON.stringify(c)})()"""
cols=json.loads(ev(COLS))
ok("the preview draws in the four palette colours", set(cols)<= {"11,17,32","62,147,166","224,162,75","79,191,212"},
   " ".join(sorted(cols,key=lambda k:-cols[k])))
ok("...and all four are present", len(cols)==4, str(len(cols))+" colours")
ev("document.querySelector('#b-power').click()")
ok("Die Runner boots with the art", wait("document.querySelector('#k-cart').textContent!=='--'"),
   ev("document.querySelector('#k-cart').textContent"))
ok("frames run", wait("+document.querySelector('#k-frames').textContent>=14"),
   ev("document.querySelector('#k-frames').textContent+' frames'"))
cols=json.loads(ev(COLS))
ok("the die is drawn in the palette and nothing else", set(cols)<={"11,17,32","62,147,166","224,162,75","79,191,212"},
   " ".join(sorted(cols,key=lambda k:-cols[k])))
ok("gates are on screen", any(k.startswith("224,162") for k in cols))
ok("the gate readout still tracks the chip", ev("document.querySelectorAll('#gates .gate').length")==8)
err=ev("document.querySelector('#err').hidden?'':document.querySelector('#err').textContent")
ok("no engine error", "stopped answering" not in (err or ""), err or "clean")
print("ALL PASS" if not any(x.startswith("FAIL") for x in R) else "RED")
for x in R: print("  ",x)
ws.close()
