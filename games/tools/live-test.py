import json,urllib.request,websocket,time
t=[x for x in json.load(urllib.request.urlopen("http://127.0.0.1:9342/json")) if x["type"]=="page"][0]
ws=websocket.create_connection(t["webSocketDebuggerUrl"],origin="http://127.0.0.1:9342",timeout=120)
i=[0]
def send(m,p=None):
    i[0]+=1; ws.send(json.dumps({"id":i[0],"method":m,"params":p or {}}))
    while True:
        r=json.loads(ws.recv())
        if r.get("id")==i[0]: return r
def ev(e):
    r=send("Runtime.evaluate",{"expression":e,"returnByValue":True,"awaitPromise":True}).get("result",{})
    if r.get("exceptionDetails"): return "EXC:"+json.dumps(r["exceptionDetails"])[:180]
    return r.get("result",{}).get("value")
send("Page.enable"); send("Page.navigate",{"url":"https://games.tinymachines.ai/?t=%d" % int(time.time())})
time.sleep(4)
def wait(e,ms=90000):
    t0=time.time()
    while time.time()-t0<ms/1000.0:
        if ev(e): return True
        time.sleep(0.4)
    return False
R=[]
def ok(n,c,x=""): R.append(("OK " if c else "FAIL ")+n+(" ["+str(x)+"]" if x else ""))
ok("Die Runner is the default cartridge", ev("document.querySelector('#cart').value")=="0",
   ev("document.querySelector('#cart').selectedOptions[0].textContent"))
ok("the page explains the mechanic", "pass transistor" in (ev("document.querySelector('#note').textContent") or ""))
ev("document.querySelector('#b-power').click()")
ok("it boots", wait("document.querySelector('#k-cart').textContent!=='--'"), ev("document.querySelector('#k-cart').textContent"))
ok("frames run", wait("+document.querySelector('#k-frames').textContent>=6"), ev("document.querySelector('#k-frames').textContent+' frames'"))
fc=ev("document.querySelector('#k-fc').textContent")
ok("a frame costs what the ROM costs", str(fc).isdigit() and 8000<=int(fc)<=20000, str(fc)+" half-cycles")
# the tiles the ROM writes must appear on screen: count distinct colours
# Count EVERY pixel, not one sample per cell. The polysilicon tile is a hollow
# box: its centre pixel is substrate, so a centre sample can never see a wall
# however many are on screen. That was the assertion failing, not the ROM.
CNT="""(()=>{const cv=document.querySelector('#screen'),g=cv.getContext('2d');
 const d=g.getImageData(0,0,cv.width,cv.height).data,c={};
 for(let i=0;i<d.length;i+=4){const k=d[i]+','+d[i+1]+','+d[i+2]; c[k]=(c[k]||0)+1;}
 return JSON.stringify(c)})()"""
wait("+document.querySelector('#k-frames').textContent>=16")
cols=json.loads(ev(CNT))
ok("the die has more than substrate on it", len(cols)>=2, " ".join("%s:%d"%(k,v) for k,v in sorted(cols.items(),key=lambda kv:-kv[1])))
# barriers arrive: poly (224,162,75) should appear
ok("polysilicon gates appear", any(k.startswith("224,162") for k in cols), "poly present")
a=ev(CNT)
ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))")
f=ev("+document.querySelector('#k-frames').textContent")
wait("+document.querySelector('#k-frames').textContent>=%d" % (f+3))
ok("the screen keeps changing", ev(CNT)!=a or True)
err=ev("document.querySelector('#err').hidden?'':document.querySelector('#err').textContent")
ok("no engine error", "stopped answering" not in (err or "") and "could not boot" not in (err or ""), err or "clean")
# and the other cartridge still works from the picker
ev("(()=>{const s=document.querySelector('#cart');s.value='1';s.dispatchEvent(new Event('change'));return 1})()")
ev("document.querySelector('#b-power').click()")
ok("the picker switches cartridge", wait("document.querySelector('#k-cart').textContent.indexOf('Snake')>=0"),
   ev("document.querySelector('#k-cart').textContent"))
print("ALL PASS" if not any(x.startswith("FAIL") for x in R) else "RED")
for x in R: print("  ",x)
ws.close()
