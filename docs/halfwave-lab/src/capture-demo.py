#!/usr/bin/env python3
"""Regenerate src/demo.json — the trace the Lab falls back to with no API.

The packed demo is deliberately a *saved API response*, not a hand-made fixture:
the same parser reads it and the live path, so a serialisation change cannot make
the two drift apart.

One step call: the latches became first-class Observation fields and rows
columns (issues/03 shipped), so the second 40-watch call and the merge this
file used to carry went the way their comment predicted. The watch mask is a
hex bitset now (issues/01 shipped), which the Lab's wbit() decodes.

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

    # The decode terms ride along, exactly as the live page fetches them:
    # the /v1/nodes decode group, sorted, appended to the control-line watch.
    nodes = json.load(urllib.request.urlopen(base + "nodes"))
    decode = sorted(nodes["groups"]["decode"])
    watch = WATCH + decode

    boot = post("boot", {"rom": {"source": SRC}, "watch": WATCH})
    a = post("step", {"machine": boot["machine"], "half_cycles": HALF_CYCLES,
                      "trace": True, "format": "rows", "watch": watch})["trace_rows"]
    assert len(a["rows"]) == HALF_CYCLES
    assert a["watch_names"] == watch, "watch order is not as requested"
    assert a.get("watch_encoding") == "hex", "expected the hex watch bitset"
    for col in ("abl", "abh", "pclp", "pchp", "idl", "alua"):
        assert col in a["cols"], f"missing latch column {col}"

    json.dump({"cols": a["cols"], "watch_names": a["watch_names"], "rows": a["rows"],
               "mem": boot["machine"]["memory"], "asm": boot["assembled"], "src": SRC},
              open(args.out, "w"), separators=(",", ":"))
    print(f"wrote {args.out}: {len(a['rows'])} rows, {len(a['cols'])} cols, "
          f"{os.path.getsize(args.out):,} bytes")


if __name__ == "__main__":
    main()
