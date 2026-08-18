#!/usr/bin/env python3
"""Check every measured cycle count and byte length against the published table.

`tests/timing.rs` and `_timing-test.html` already cross-check 33 documented
opcodes against figures typed in by hand. This checks **117** against the table
in Appendix B of the MCS6500 family programming manual, which is a far stronger
statement of the same thing: the measurement path consults no instruction table
at all, so agreeing with a published one is evidence rather than tautology.

The manual is not in this repository and is not redistributed by it. This reads
whatever is in `reference/`, exactly as the golden test reads a trace generated
on demand, and SKIPS when it is absent. `REQUIRE_MANUAL=1` makes its absence a
failure instead.

    python3 tools/check-timing-vs-manual.py

Only facts are taken out of it -- opcode, byte count, cycle count -- and only to
verify our own numbers. Nothing from the manual is published by this project.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "reference" / "mcs6500_family_programming_manual.pdf"
TIMING = ROOT / "web" / "timing.json"

MNEMONICS = set("""ADC AND ASL BCC BCS BEQ BIT BMI BNE BPL BRK BVC BVS CLC CLD CLI CLV CMP
CPX CPY DEC DEX DEY EOR INC INX INY JMP JSR LDA LDX LDY LSR NOP ORA PHA PHP PLA PLP ROL
ROR RTI RTS SBC SEC SED SEI STA STX STY TAX TAY TSX TXA TXS TYA""".split())

# Characters the scan confuses, and only the ones actually observed in this
# document: a lowercase L and a capital I both read as a 1. The mapping is from
# the SHAPE OF THE SCAN and never from what we know the chip to be -- repairing
# an opcode by consulting our own tables would make the comparison circular, and
# a manual we corrected against ourselves would agree with us for free.
#
# The trailing comma is the same class: "4," is a cycle count with punctuation.
# `IE` -> `1E` is deliberately NOT here. The opcode repairs correctly and the
# figures beside it do not: the scan has run two rows' number columns together
# there, so the repair turns an unreadable row into a WRONG one, which is worse.
# It was caught because the guard failed loudly rather than absorbing it.
SCAN_FIXES = {
    "Cl": "C1", "El": "E1", "FI": "F1", "ID": "1D",
    "4,": "4", "3,": "3", "2,": "2", "5,": "5", "6,": "6",
}

# A token is this row's instruction if it IS a mnemonic or merely begins with
# one: the scan writes "ASL A" and "LDA # Oper" as single tokens.
MNEMONIC_AT_START = re.compile(r"^(" + "|".join(sorted(MNEMONICS)) + r")(?:$|\s)")

# Longest first: "Zero Page, X" must win over "Zero Page".
MODES = ["Zero Page, X", "Zero Page,X", "Zero Page, Y", "Zero Page,Y",
         "Absolute, X", "Absolute,X", "Absolute, Y", "Absolute,Y",
         "(Indirect, X)", "(Indirect), Y", "Immediate", "Zero Page", "Absolute",
         "Indirect", "Accumulator", "Implied", "Relative"]

# The eight branches, and the flag each one branches ON being clear or set. The
# published figure for a branch is the NOT-TAKEN case; a taken branch costs one
# more, and crossing a page costs another. Our measurement runs one scenario, so
# a branch it happened to take is measured one higher and is not a disagreement.
BRANCHES = {0x10: "BPL", 0x30: "BMI", 0x50: "BVC", 0x70: "BVS",
            0x90: "BCC", 0xB0: "BCS", 0xD0: "BNE", 0xF0: "BEQ"}


def appendix_b(text):
    """The instruction table, as facts. Returns {opcode: (mnemonic, mode, bytes, cycles)}."""
    start = text.find("APPENDIX B")
    if start < 0:
        raise SystemExit("check-timing: no Appendix B in the extracted text")
    toks = [t.strip() for t in text[start:].splitlines() if t.strip()]

    out, i, seen = {}, 0, 0
    repaired = set()
    dropped = {"no mnemonic in the row": 0, "numbers unreadable": 0,
               "opcode read twice": 0}
    while i < len(toks):
        mode = next((m for m in MODES if toks[i] == m), None)
        if mode is None:
            i += 1
            continue
        seen += 1
        mne, j = None, i + 1
        while j < len(toks):
            # The scan does not always split the mnemonic from the assembly
            # form it is written with, so a row can arrive as one token: "ASL A"
            # for the accumulator forms, "LDA # Oper" for the immediates. An
            # exact match drops every one of those, which is why the immediate
            # and accumulator rows were missing wholesale.
            m = MNEMONIC_AT_START.match(toks[j])
            if m:
                mne = m.group(1)
                break
            if any(toks[j] == m2 for m2 in MODES):
                break          # the next row started; this one has no mnemonic
            j += 1
        if mne is None:
            dropped["no mnemonic in the row"] += 1
            i += 1
            continue

        # The accumulator forms are written "ASL A", and a lone "A" is also a
        # valid hex digit -- so the numeric scan below eats the operand and
        # every column shifts by one. Stepping over it is structural: it does
        # not look at any data, only at where the operand sits.
        nums, k = [], j + 1
        if mode == "Accumulator" and k < len(toks) and toks[k] == "A":
            k += 1
        while k < len(toks) and len(nums) < 6:
            t = toks[k]
            if t in SCAN_FIXES:
                repaired.add(t)
                t = SCAN_FIXES[t]
            if re.fullmatch(r"[0-9A-F]{1,2}\*?", t):
                nums.append(t)
            elif t in MODES or t in MNEMONICS:
                break
            k += 1

        # The scan splits some opcodes across two lines: "6D" arrives as "6"
        # then "D". Two single characters that form a byte, followed by a
        # plausible byte count, are one opcode rather than two numbers.
        if len(nums) >= 4 and len(nums[0]) == 1 and len(nums[1]) == 1:
            merged = nums[0] + nums[1]
            if re.fullmatch(r"[0-9A-F]{2}", merged) and nums[2] in "123":
                nums = [merged] + nums[2:]

        if len(nums) >= 3 and re.fullmatch(r"[0-9A-F]{2}", nums[0]) \
                and nums[1].isdigit() and re.fullmatch(r"\d\*?", nums[2]):
            op = int(nums[0], 16)
            if op in out:
                dropped["opcode read twice"] += 1
            else:
                out[op] = (mne, mode, int(nums[1]), int(nums[2][0]))
        else:
            dropped["numbers unreadable"] += 1
        i = k if k > i else i + 1
    return out, dropped, seen, repaired


def main():
    required = os.environ.get("REQUIRE_MANUAL") == "1"
    if not PDF.exists():
        msg = f"check-timing: {PDF.relative_to(ROOT)} not present"
        if required:
            raise SystemExit(msg + " and REQUIRE_MANUAL=1")
        print(msg + ", SKIPPING")
        return 0
    if not TIMING.exists():
        raise SystemExit("check-timing: web/timing.json not built")

    try:
        text = subprocess.run(["pdftotext", str(PDF), "-"], check=True,
                              capture_output=True, text=True).stdout
    except FileNotFoundError:
        print("check-timing: pdftotext not installed, SKIPPING")
        return 0

    table, dropped, seen, repaired = appendix_b(text)
    measured = {o["op"]: o for o in json.loads(TIMING.read_text())["opcodes"]}

    agree, explained, disagree = 0, [], []
    b_agree, b_dis, b_none = 0, [], 0
    for op, (mne, mode, _bytes, cycles) in sorted(table.items()):
        m = measured.get(op)
        if m is None or m["jam"]:
            continue
        # Byte length, measured as how far the program counter moved from this
        # opcode's fetch to the next one. `null` where control went elsewhere,
        # which is not a disagreement: the distance is simply not a length.
        if m.get("bytes") is None:
            b_none += 1
        elif m["bytes"] == _bytes:
            b_agree += 1
        else:
            b_dis.append(f"${op:02X} {mne} {mode}: manual {_bytes} bytes, "
                         f"measured {m['bytes']}")

        if m["cycles"] == cycles:
            agree += 1
        elif op in BRANCHES and m["cycles"] == cycles + 1:
            # A branch our run took. One more cycle, and the only shape of
            # difference allowed without being a real disagreement.
            explained.append(BRANCHES[op])
        else:
            disagree.append(f"${op:02X} {mne} {mode}: manual {cycles}, measured {m['cycles']}")

    # Every row accounted for. A count that does not add up is how silent
    # truncation hides: the first version of this reported only the rows it
    # found AND failed to parse, so 30 rows it never saw at all looked like a
    # table that did not contain them.
    print(f"  {seen} rows in the published table")
    print(f"  {len(table)} read as opcodes")
    for why, n in dropped.items():
        if n:
            print(f"  {n} skipped: {why}")
    if repaired:
        # Never silent. A figure resting on a character repair should be
        # visible, because a repair that goes wrong makes a plausible row
        # rather than an obviously broken one.
        print(f"  {len(repaired)} tokens repaired from scan damage: "
              f"{', '.join(sorted(repaired))}")
    total = len(table) + sum(dropped.values())
    if total != seen:
        raise SystemExit(f"check-timing: {seen} rows seen but {total} accounted for")
    print(f"  {agree} agree exactly")
    print(f"  {len(explained)} branches measured one cycle higher, taken in this run: "
          f"{', '.join(sorted(explained))}")
    print(f"  {b_agree} byte lengths agree, {len(b_dis)} disagree, "
          f"{b_none} not measurable (control went elsewhere)")
    bad = disagree + b_dis
    if bad:
        print(f"  {len(bad)} DISAGREE:")
        for d in bad:
            print("    ", d)
        return 1
    print("  0 disagree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
