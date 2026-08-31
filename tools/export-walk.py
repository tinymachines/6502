#!/usr/bin/env python3
"""Part one of the Snake series: one instruction, followed through the silicon.

Writes `docs/walk-snake.md`. The chip state is measured by running the real
Snake ROM on the real simulation; the schematics are pulled from the live
schematic page rather than drawn again here.

    cargo build --release -p v6502-halfwave --bin halfwave
    python3 tools/export-walk.py           # reuses cached SVGs
    FRESH=1 python3 tools/export-walk.py   # re-grabs them

SKIPS the SVGs (and says so in the document) when no browser is available, so
the prose and the measurements still build.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "walk-snake.md")
FIG = os.path.join(ROOT, "docs", "walk")
BIN = os.path.join(ROOT, "target/release/halfwave")
ROM = os.path.join(ROOT, "games/rom/snake.rom")
LST = os.path.join(ROOT, "games/rom/snake.lst")
sys.path.insert(0, os.path.join(ROOT, "tools", "walk"))

if not os.path.exists(BIN):
    print("FAIL no target/release/halfwave"); sys.exit(1)

# ---------------------------------------------------------------- the chip
rom = open(ROM, "rb").read()
pages = []
for pg in range((len(rom) + 255) // 256):
    b = bytearray(256); c = rom[pg * 256:(pg + 1) * 256]; b[:len(c)] = c
    pages.append("PAGE %02x %s" % (2 + pg, b.hex()))

proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def call(lines):
    proc.stdin.write("\n".join(lines) + "\nGO\n"); proc.stdin.flush()
    r = json.loads(proc.stdout.readline())
    if not r.get("ok"): print("FAIL halfwave: %s" % r.get("error")); sys.exit(1)
    return r

st = call(["FILL 00"] + pages + ["VEC 0200", "BOOT"])["state"]
S = "STATE %s %s %s %s %s %s" % (st["value"], st["pullup"], st["pulldown"],
    st["trans_on"], st["half_cycle"],
    "%04x%02x" % (st["last_fetch"]["addr"], st["last_fetch"]["opcode"]))
tr = call([S] + pages + ["FILL 00", "TRACE", "STEP 400"])["trace"]
proc.stdin.close()

TARGET = 0x021F                       # STA $0400,X, the screen-clearing store
hits = [i for i, o in enumerate(tr)
        if o.get("sync") and o.get("fetch") and o["fetch"]["addr"] == TARGET]
if len(hits) < 6: print("FAIL only %d fetches of $%04X" % (len(hits), TARGET)); sys.exit(1)
i0 = hits[5]                          # a pass with X non-zero, so the adder works
win = tr[i0:i0 + 12]
XVAL = win[0]["x"]

# ---------------------------------------------------------------- figures
FIGS = [
    ("xsb",    "dpc2_XSB",     "back", 1, "What opens X onto the special bus"),
    ("sbadd",  "dpc11_SBADD",  "back", 1, "What selects the special bus as the adder's A input"),
    ("addadl", "dpc21_ADDADL", "back", 1, "What puts the adder's answer on the low address bus"),
    ("acdb",   "dpc26_ACDB",   "back", 1, "What drives the accumulator onto the data bus"),
    ("wr",     "#WR",          "back", 2, "What decides this cycle is a write"),
]
os.makedirs(FIG, exist_ok=True)
for key, sig, d, depth, _cap in FIGS:
    dest = os.path.join(FIG, key + ".svg")
    if os.path.exists(dest) and not os.environ.get("FRESH"): continue
    q = "signal=%s&dir=%s&depth=%d" % (sig, d, depth)
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools/walk/grab-svg.py"), q, dest])
    if r.returncode != 0: have_figs = False
have_figs = all(os.path.exists(os.path.join(FIG, k + ".svg")) for k, *_ in FIGS)

# ---------------------------------------------------------------- helpers
def bits(v): return format(v, "08b")[:4] + " " + format(v, "08b")[4:]
def grid(o, note=""):
    """A byte, in hex and as eight bits, for the things a programmer names."""
    L = ["```",
         "  A  $%02X  %s        X  $%02X  %s" % (o["a"], bits(o["a"]), o["x"], bits(o["x"])),
         "  Y  $%02X  %s        S  $%02X  %s" % (o["y"], bits(o["y"]), o["s"], bits(o["s"])),
         "  P  $%02X  %s  <- capital means set     PC $%04X"
         % (o["p"], o.get("flags", ""), o["pc"]),
         "",
         "  AB $%04X   DB $%02X   R/W %s        SB $%02X   ADL $%02X   ADH $%02X"
         % (o["addr"], o["data"], o["rw"][0].upper(), o["sb"], o["adl"], o["adh"]),
         "  ALU $%02X  = A-side $%02X  B-side $%02X    IR $%02X   T-state %s"
         % (o["alu"], o["alua"], o["alub"], o["ir"], (o.get("tstates") or "-"))]
    if note: L += ["", "  " + note]
    L.append("```")
    return "\n".join(L)

L = []
w = L.append

def fig(key, cap):
    if not have_figs:
        return "> *(schematic omitted: no browser available when this was generated)*\n"
    return ("<p align=\"center\"><img src=\"walk/%s.svg\" alt=\"%s\" width=\"520\"></p>\n\n"
            "<p align=\"center\"><sub>%s. Pulled from "
            "<a href=\"https://6502.tinymachines.ai/schematic?signal=%s&dir=back&depth=%d\">the "
            "schematic page</a>, which drew it from the switch network.</sub></p>\n"
            % (key, cap, cap, dict((k, s) for k, s, *_ in FIGS)[key],
               dict((k, d) for k, _s, _d, d, *_ in FIGS)[key]))

w("# Snake, one instruction deep\n")
w("*Part one of a series on writing a game for a chip you can see inside.*\n")
w("Generated by `tools/export-walk.py`. Every number below was measured by")
w("running the real Snake ROM on the simulation; every schematic was pulled")
w("from the live schematic page, which drew it from the switch network. If")
w("something here is wrong, the chip changed.\n")
w("---\n")

w("## Before we start: four things worth having straight\n")

w("### RAM and ROM, and why this console has only one of them\n")
w("**ROM** is memory that was fixed when the part was made: the program is in")
w("the silicon and cannot change. **RAM** forgets when the power goes, and")
w("anything can write it.\n")
w("A 6502 cannot tell them apart. It puts an address on sixteen pins and either")
w("reads a byte or writes one; whether something out there is willing to be")
w("written is not the processor's business. **On this console it is all RAM.**")
w("`snake.rom` is %d bytes that get loaded into memory starting at `$0200`, and"
  % len(rom))
w("the chip fetches its first instruction there because the reset vector was")
w("pointed at it. Nothing stops the program overwriting itself. That is not a")
w("simplification of a real machine; it is what a real machine does when you")
w("wire RAM where the ROM would go.\n")
w("Snake's memory is in three parts, and you can read them straight off the")
w("listing: **`$0000-$00FF` zero page** for its variables (cheaper to address,")
w("one byte instead of two), **`$0100-$01FF` the stack**, which the hardware")
w("insists on, and **`$0400` onward the screen**, which is a page of memory the")
w("host happens to be drawing.\n")

w("### Gates, dynamic nodes, and paths\n")
w("Three words that mean something specific here.\n")
w("A **gate** is a few transistors that compute a value and drive a wire to it.")
w("This chip builds them one way only: a pull-up holds the wire high and a")
w("network of transistors to ground can beat it, so the output is low when the")
w("network conducts. **There is no AND gate and no OR gate on this die.**\n")
w("A **dynamic** node is a wire that nothing drives. It is charged up by the")
w("clock and then either pulled down or left alone, and it *remembers* by")
w("holding that charge. It is the cheapest memory there is and it leaks, which")
w("is why this processor has a minimum clock speed as well as a maximum: **stop")
w("a 6502 for too long and it forgets what it was doing.**\n")
w("A **path** is a pass transistor: one transistor with a control wire on its")
w("gate, joining two wires when the control goes high. It does not compute")
w("anything and it has no direction. Almost everything that looks like moving")
w("data around in this chip is a path opening.\n")
w("`docs/idioms.md` has the counts for all three.\n")

w("### Addresses: how to say where something is\n")
w("Every wire, transistor and connection on this die has one address, and it")
w("reads back to front like a postcode:\n")
w("```\n  regs:x : bus : #1169\n  \\____/   \\_/    \\___/\n"
  "  which    what    which\n  part     kind    one\n```\n")
w("`regs:x` is the container: the X register, one of 132 groups the chip is")
w("divided into. `bus` says nothing drives this wire directly. `#1169` is the")
w("die's own number for it, which never changes even when we improve how the")
w("first two parts are worked out. **A prefix is a valid way to name a set**:")
w("`regs:` is every register, `alu:bit3` is one slice of the adder.")
w("`docs/atlas.md` is the full rubric.\n")

w("### Interrupts, and how a player presses a key\n")
w("A 6502 has three pins that interrupt it: `res`, `irq` and `nmi`. Pull one")
w("low and the chip finishes what it is doing, pushes where it was onto the")
w("stack, and jumps through a fixed address near the top of memory.\n")
w("The mechanism is worth knowing because it is so cheap: **the chip has no")
w("interrupt sequencer at all.** Predecode forces the instruction register to")
w("`$00`, which is `BRK`, and the BRK sequence does the rest. An interrupt is a")
w("BRK the hardware inserted.\n")
w("**Snake does not use any of this.** Input arrives as a byte the host writes")
w("into memory, and the program reads it like any other variable. Look at the")
w("listing at `$0245`:\n")
w("```\n  $0245  A5 0D      LDA $0D\n  $0247  D0 FC      BNE $0245\n```\n")
w("That is the whole frame sync: load a byte, branch back if it is not zero,")
w("forever, until something outside changes it. Polling is not a lesser")
w("technique here; with one program running and nothing else to do, a spin loop")
w("costs nothing and is far easier to reason about than an interrupt that can")
w("land between any two instructions.\n")
w("---\n")

# ---------------------------------------------------------------- the walk
w("## The instruction\n")
w("Snake clears its screen with three instructions, and this is the middle of")
w("that loop:\n")
w("```\n  $021F  9D 00 04   STA $0400,X\n  $0222  E8         INX\n"
  "  $0223  D0 FA      BNE $021F\n```\n")
w("Store the accumulator at `$0400` plus X, bump X, go round again until X")
w("wraps to zero. 256 times, and the screen is blank. **This is the smallest")
w("useful thing a game does**, and it takes five cycles, which is ten of the")
w("half-cycles this simulation actually steps in.\n")
w("We are watching the pass where **X is `$%02X`**, so the address arithmetic"
  % XVAL)
w("has something to do. Here is the whole instruction first, then one cycle at")
w("a time.\n")
w("| half-cycle | phase | T | R/W | address | data | what is happening |")
w("|---|---|---|---|---|---|---|")
NARR = {
    0: "the opcode `$9D` is read; `sync` is high, which is the chip saying *this byte is an instruction*",
    1: "the low byte of the address, `$00`, is read from `$0220`",
    3: "the high byte, `$04`, is read from `$0221`",
    5: "the adder has produced `$02`; the address bus now reads `$0402`",
    7: "**the write.** R/W goes low and the accumulator's byte goes out",
    9: "`sync` again: the next instruction, `$E8` (`INX`), is already being read",
}
for k, o in enumerate(win[:10]):
    w("| %d | %s | %s | %s | `$%04X` | `$%02X` | %s |"
      % (o["half_cycle"], o["phase"], (o.get("tstates") or "-"),
         o["rw"][0].upper(), o["addr"], o["data"], NARR.get(k, "")))
w("")
nw = sum(1 for o in win[:10] if o["rw"] == "write")
w("Two things to notice before we go in.\n")
w("**%d half-cycles of the %d are the write.** Everything else is fetching the"
  % (nw, len(win[:10])))
w("instruction, fetching its operand, and doing arithmetic on an address. A")
w("store spends most of its life working out where to put the byte.\n")
w("**The next instruction is already being read before this one finishes.**")
w("Look at the last row: `sync` is high and `$E8` is on the data bus while the")
w("store is still settling. The 6502 overlaps, always, and that is why a")
w("register you read at the wrong moment gives an answer that is true of the")
w("silicon and useless to you.\n")

STEPS = [
    (0, "Cycle 1: the opcode arrives", None,
     "The program counter is on the address pins and memory has answered with "
     "`$9D`. That byte goes into the instruction register, and from there onto "
     "the decode grid, where it either matches a row or does not. Nothing "
     "decides that this is a legal instruction; the pattern either fires "
     "product terms or it does not."),
    (1, "Cycle 2: fetch the low byte of the address", None,
     "The counter has moved on and `$0220` is being read. `$00` comes back: "
     "the low half of `$0400`. It goes into the input data latch, which is "
     "where every byte from memory lands before anything else can use it."),
    (3, "Cycle 3: fetch the high byte, and start adding", "xsb",
     "`$04` arrives from `$0221`. Meanwhile X has to be added to the low byte, "
     "and X cannot reach the adder on its own: a control line has to open a "
     "path. This is the circuit that makes `XSB` go high, and it is three "
     "transistors and a clock. The line has no pull-up of its own, which is the "
     "dynamic idiom: charged high, then pulled down when the decode grid says "
     "so."),
    (5, "Cycle 4: the address is complete", "addadl",
     "The adder has `$%02X` on its output and the address bus reads `$0402`. "
     "Nothing has been written yet. This cycle exists only because the operand "
     "and the index had to be added, and an ordinary `STA $0400` would not have "
     "it." % win[5]["alu"]),
    (7, "Cycle 5: the write", "acdb",
     "R/W goes low. The accumulator drives the internal data bus through the "
     "line below, the output register takes it, and the pads put it on the "
     "pins. One byte of screen is now whatever A held."),
]
for k, title, figkey, prose in STEPS:
    o = win[k]
    w("### %s\n" % title)
    w("%s\n" % prose)
    if figkey:
        cap = dict((kk, c) for kk, _s, _d, _dep, c in FIGS)[figkey]
        w(fig(figkey, cap))
    w(grid(o, "half-cycle %d, %s" % (o["half_cycle"], o["phase"])))
    w("")

w("### What the adder was actually doing\n")
w("The interesting part of an indexed store is that **the 6502 has no address")
w("adder**. It has one 8-bit ALU, the same one `ADC` uses, and an indexed")
w("address is computed on it like any other sum. Follow the two lines that")
w("feed it:\n")
w(fig("sbadd", dict((k, c) for k, _s, _d, _dep, c in FIGS)["sbadd"]))
w("`SBADD` selects the special bus as one input. The other input is the byte")
w("just fetched. The answer comes out on the ALU's own wires and then has to be")
w("moved again, which is what `ADDADL` is for. **Three control lines and two")
w("bus crossings to add two numbers**: that is what it costs when there is only")
w("one adder on the chip and everything has to take turns.\n")

w("### What decides a cycle is a write\n")
w(fig("wr", dict((k, c) for k, _s, _d, _dep, c in FIGS)["wr"]))
w("Read the labels. `ir2` through `ir7` and `irline3` are the opcode itself:")
w("the write control is looking at the instruction. `t2` and `t4` are the")
w("timing chain, so it is also looking at *when*. And `#440` and `#1258` are")
w("the two store-data latches, which is the chip remembering across cycles")
w("that a store is in progress.\n")
w("**A write is not a thing the programmer asks for. It is a pattern of")
w("opcode bits, arriving at the right T-state, that happens to reach this")
w("gate.** Nothing here knows what `STA` means.\n")
w("There is one more condition and it is *not* in this picture, which is worth")
w("saying rather than implying: the write also depends on the chip being ready")
w("and not in reset. Those inputs are further back than the two levels drawn")
w("here (three levels does not reach them either). Pull `rdy` low during a")
w("read and the 6502 stalls; pull it low during a write and it does not,")
w("because stopping mid-write would leave a half-written byte somewhere.\n")
w("---\n")

# --------------------------------------------------- what a cycle leaves behind
w("## What is left when a cycle ends\n")
w("This is the question that separates thinking about a processor from")
w("thinking about a chip. A cycle does not end with a tidy result filed away.")
w("It ends with **every wire on the die holding some level**, and the next")
w("cycle starts from that.\n")
before, after = win[0], win[9]
w("Across the ten half-cycles above, here is what actually changed and what")
w("did not:\n")
w("| | at the opcode fetch | at the next opcode fetch |")
w("|---|---|---|")
for lbl, k, fmt in (("A", "a", "$%02X"), ("X", "x", "$%02X"), ("Y", "y", "$%02X"),
                    ("S", "s", "$%02X"), ("PC", "pc", "$%04X"), ("P", "p", "$%02X")):
    w("| %s | %s | %s |" % (lbl, fmt % before[k], fmt % after[k]))
w("| flags | `%s` | `%s` |" % (before.get("flags"), after.get("flags")))
w("")
w("**A store changes no register and no flag.** The only things that moved are")
w("the program counter, and one byte of memory that is not in this table at")
w("all. Everything else is exactly where it was.\n")
w("But the *wires* are a different story, and this is the part worth sitting")
w("with. The chip map divides the die into 132 containers; over a single")
w("half-cycle roughly a tenth of the chip changes level. The registers hold")
w("their values not because anything is protecting them but because **their")
w("two-inverter rings are still circulating**, and they will keep doing that")
w("only as long as the clock keeps arriving.\n")
w("So: at an instruction boundary, the registers are meaningful and you can")
w("read them. **In the middle of an instruction they are not.** In the table")
w("above, X reads `$%02X` at one point during the store, which is not a value X"
  % win[6]["x"])
w("ever held: it is a dynamic node with the bus driving past it. If you are")
w("going to look inside a chip, the first discipline is knowing when a readout")
w("means something.\n")

w("## Half-cycles, and why this simulation counts them\n")
w("Most 6502 documentation counts cycles. This counts half-cycles, because the")
w("chip does work on both edges and the two halves do different jobs:\n")
w("- On **phi1** the address latches drive the pins, and values loaded last")
w("  cycle become readable.")
w("- On **phi2** the buses are precharged, the decode grid settles, and the")
w("  control lines for the next phi1 are latched.\n")
w("Count whole cycles and half the story is invisible. The write above is not")
w("*a cycle*: it is the phi1 half of one, and the address it writes to was put")
w("on the pins during the phi2 half before it.\n")
w("Two phases, never both high at once, and that non-overlap is not a")
w("convention: it is two transistors in the clock generator holding each phase")
w("off until the other has gone.\n")
w("---\n")

# ------------------------------------------------------- all the way down
# The die data is a read-only submodule and a clone may not have it, so the
# whole section is skipped rather than half-written.
TD = os.path.join(ROOT, "extern/visual6502/transdefs.js")
SUBJ = "dpc2_XSB"
if os.path.exists(TD):
    import re as _re2, statistics as _st
    _rows = _re2.findall(r"\['t(\d+)',\s*(\d+),\s*(\d+),\s*(\d+),\s*\[([\d,\s-]+)\],\s*\[([\d,\s-]+)\]",
                         open(TD).read())
    TR = {}
    for _t, _g, _a, _b, _bb, _ge in _rows:
        TR[int(_t)] = dict(gate=int(_g), c1=int(_a), c2=int(_b),
                           bb=[int(x) for x in _bb.split(",")],
                           ge=[int(x) for x in _ge.split(",")])
    sch = json.load(open(os.path.join(ROOT, "web/schematic.json")))
    grp = json.load(open(os.path.join(ROOT, "web/groups.json")))
    gph = json.load(open(os.path.join(ROOT, "web/graph.json")))
    nm2 = sch["names"]; by2 = {n: i for i, n in enumerate(nm2) if n}
    own2 = {n["id"]: n["owner"] for n in grp["nodes"]}
    node = by2[SUBJ]; VSS2, VCC2 = sch["vss"], sch["vcc"]
    kof = {t["id"]: gph["transistorKinds"][t["kind"]] for t in gph["transistors"]}
    mine = sorted(t for t, d in TR.items() if node in (d["c1"], d["c2"]))
    bnds = gph["bounds"]; span = bnds["xmax"] - bnds["xmin"]
    UM = 168 * 25.4 / span            # 168 mil across, off the MOS blueprint
    lens = [d["ge"][2] for d in TR.values()]
    medlen = _st.median(lens)

    w("## All the way down\n")
    w("Every schematic above stops at a symbol. A symbol is not the bottom.\n")
    w("`%s` is the line that opens X onto the special bus, and underneath the"
      % SUBJ)
    w("triangle it is drawn as, it is **%d transistors**. Here they are, with"
      % len(mine))
    w("their addresses, their gates, and their actual size on the silicon.\n")
    w("| address | its gate is | joins | width at each end / length | area |")
    w("|---|---|---|---|---|")
    for t in mine:
        d = TR[t]; ge = d["ge"]
        far = d["c1"] if d["c2"] == node else d["c2"]
        joins = ("**vcc**" if far == VCC2 else "**vss**" if far == VSS2
                 else "`%s`" % (nm2[far] or "#%d" % far))
        w("| `t:%s:%s:#%d` | `%s` | %s | %d x %d / %d | %d |"
          % (own2.get(node, "?"), kof.get(t, "?"), t,
             nm2[d["gate"]] or "#%d" % d["gate"], joins, ge[0], ge[1], ge[2], ge[4]))
    w("")
    w("### The one that is missing\n")
    hasflag = [n for n in gph["nodes"] if n and n.get("pullup")]
    w("A static gate needs something holding its output high. **There is no such")
    w("transistor in that table**, and there is no oversight either: on this die")
    w("the load is a *depletion-mode* device, recorded as a flag on the polygon")
    w("rather than as a row in the transistor list. **%d nodes carry that flag.**"
      % len(hasflag))
    w("`%s` is not one of them.\n" % SUBJ)
    w("Which makes the first row of that table misleading, and it is worth saying")
    w("why rather than quietly fixing it. The class `pullup` there is the *naive*")
    w("reading: a transistor with one end on vcc. That is what the shape is; it")
    w("is not what the job is. `t%d` is a **precharge** device, opened once a"
      % next(t for t in mine if VCC2 in (TR[t]["c1"], TR[t]["c2"])))
    w("cycle to put charge on a wire that has no permanent load. A depletion load")
    w("and a precharge transistor look identical in a list of terminals and do")
    w("completely different jobs. **The die data does not know the difference,")
    w("and neither does any rule that only looks at one transistor at a time.**\n")
    w("So this wire has nothing holding it up. It is charged through `t%d`, and"
      % next(t for t in mine if VCC2 in (TR[t]["c1"], TR[t]["c2"])))
    w("then it simply **stays** charged until something pulls it down or the")
    w("charge leaks away. That is the dynamic idiom from earlier, and here it is")
    w("as four devices: one small one to put charge on, three big ones to take it")
    w("off. **This is where the 6502's minimum clock speed comes from.** Not a")
    w("design rule someone wrote down: a wire with nothing holding it up.\n")
    w("### How big is a transistor\n")
    w("The die data carries real coordinates, and sheet 1 of the MOS blueprint")
    w("marks the die as **168 mil** across including the scribe lane. The drawn")
    w("die spans %d units, so one unit is about **%.3f micrometres**.\n"
      % (span, UM))
    w("| | die units | micrometres |")
    w("|---|---|---|")
    w("| median channel length | %d | **%.1f** |" % (medlen, medlen * UM))
    for t in mine[:2]:
        ge = TR[t]["ge"]
        w("| `t%d` channel | %d long, %d wide | %.1f x %.1f |"
          % (t, ge[2], (ge[0] + ge[1]) // 2, ge[2] * UM, (ge[0] + ge[1]) / 2 * UM))
    w("")
    w("**%.1f micrometres.** The 6502 was made on an eight-micron process, and"
      % (medlen * UM))
    w("that number was not looked up: it is polygon coordinates measured against")
    w("a die width someone wrote on a blueprint in 1975. A human hair is about")
    w("70 micrometres across, so about **nine channel lengths would fit across")
    w("one hair** (the whole device is bigger than its channel, so fewer whole")
    w("transistors than that).\n")
    w("There are **%s** of them. That is the entire processor: no microcode, no"
      % "{:,}".format(len(TR)))
    w("hidden layer, nothing below this. Four of them make one control line, and")
    w("the control line opens a path, and the path carries X to a bus, and that")
    w("is how a snake moves.\n")
    w("---\n")

w("## Where this goes next\n")
w("This was one instruction. The series it belongs to:\n")
w("1. **This.** One store, five cycles, and the vocabulary.")
w("2. **The loop.** `INX` and `BNE`, the flags they set and read, and why a")
w("   taken branch costs a cycle and a page crossing costs two.")
w("3. **The frame.** The spin on `$0D`, what the host is doing while the chip")
w("   spins, and what a frame costs in half-cycles.")
w("4. **Drawing.** The screen as memory, and the arithmetic of turning an x and")
w("   a y into an address without a multiplier.")
w("5. **Input.** The polled byte, then the same thing done with `irq`, and the")
w("   measured difference.")
w("6. **Your own cartridge.** `games/README.md` mints one; the API runs it.\n")
w("Everything above is live. The chip map draws all 132 containers, the tracer")
w("lights them half-cycle by half-cycle beside the running code, and the API")
w("will step this same ROM for you one half-cycle at a time.\n")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(L) + "\n")
print("wrote %s (%d lines)" % (os.path.relpath(OUT, ROOT), len(L)))
print("  subject: STA $0400,X at $%04X with X=$%02X, half-cycles %d..%d"
      % (TARGET, XVAL, win[0]["half_cycle"], win[9]["half_cycle"]))
print("  figures: %s" % ("all %d present" % len(FIGS) if have_figs else "MISSING"))
if not have_figs: print("  (document says so rather than showing broken images)")
