#!/usr/bin/env python3
"""Regenerate src/demo.json — the trace the Lab falls back to with no API.

The packed demo is deliberately a *saved API response*, not a hand-made fixture:
the same parser reads it and the live path, so a serialisation change cannot make
the two drift apart.

Two step calls are merged because a `rows` watch mask past 53 names exceeds JS
safe integers (see issues/01). If idl/idb/dor/alua/alub ever become first-class
Observation fields (issues/03), the second call and the merge below can go.

    python3 src/capture-demo.py [--api https://6502.tinymachines.ai/api]
"""
import argparse, json, os, urllib.request

SRC = """        .org $0200
start:  LDA #$2E
        STA $80
        LDA #$14
        STA $81
sum:    CLC
        LDA $80
        ADC $81
        STA $82
        JMP start"""

# Datapath control lines, plus the clock pins and RDY for the scope. The clock
# phases are read as pins rather than derived from `phase` so their non-overlap
# is measured rather than drawn.
WATCH = [
    "dpc38_PCLADL", "dpc32_PCHADH", "dpc25_SBDB", "dpc23_SBAC", "dpc9_DBADD",
    "dpc11_SBADD", "dpc10_ADLADD", "dpc21_ADDADL", "dpc20_ADDSB06", "dpc19_ADDSB7",
    "dpc40_ADLPCL", "dpc39_PCLPCL", "dpc31_PCHPCH", "dpc30_ADHPCH", "dpc37_PCLDB",
    "dpc33_PCHDB", "dpc1_SBY", "dpc3_SBX", "dpc6_SBS", "dpc27_SBADH",
    "dpc17_SUMS", "dpc12_0ADD", "clk1out", "clk2out", "rdy",
]
FAM = ["idb", "idl", "dor", "alua", "alub"]      # one watch per bit, 40 names
WATCH2 = [f"{f}{i}" for f in FAM for i in range(8)]
HALF_CYCLES = 132


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="https://6502.tinymachines.ai/api")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "demo.json"))
    args = ap.parse_args()
    base = args.api.rstrip("/") + "/v1/"

    def post(path, body):
        req = urllib.request.Request(
            base + path, json.dumps(body).encode(), {"content-type": "application/json"})
        return json.load(urllib.request.urlopen(req))

    boot = post("boot", {"rom": {"source": SRC}, "watch": WATCH})
    common = {"machine": boot["machine"], "half_cycles": HALF_CYCLES,
              "trace": True, "format": "rows"}
    a = post("step", dict(common, watch=WATCH))["trace_rows"]
    b = post("step", dict(common, watch=WATCH2))["trace_rows"]

    for n, name in enumerate(WATCH2):
        assert b["watch_names"][n] == name, "watch order is not as requested"
    assert len(a["rows"]) == len(b["rows"]) == HALF_CYCLES

    ci = {c: i for i, c in enumerate(b["cols"])}
    idx = [[b["watch_names"].index(f"{f}{i}") for i in range(8)] for f in FAM]
    rows = [
        r + [sum(((b["rows"][n][ci["watch"]] >> p) & 1) << k for k, p in enumerate(bits))
             for bits in idx]
        for n, r in enumerate(a["rows"])
    ]

    json.dump({"cols": a["cols"] + FAM, "watch_names": a["watch_names"], "rows": rows,
               "mem": boot["machine"]["memory"], "asm": boot["assembled"], "src": SRC},
              open(args.out, "w"), separators=(",", ":"))
    print(f"wrote {args.out}: {len(rows)} rows, {len(a['cols']) + len(FAM)} cols, "
          f"{os.path.getsize(args.out):,} bytes")


if __name__ == "__main__":
    main()
