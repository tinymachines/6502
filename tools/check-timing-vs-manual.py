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
    RESCAN=1 python3 tools/check-timing-vs-manual.py   # slower, reads more rows

Only facts are taken out of it -- opcode, byte count, cycle count -- and only to
verify our own numbers. Nothing from the manual is published by this project.
"""

import json
import os
import re
import subprocess
import sys
import os
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
    unread = []
    dropped = {"figures missing from the scan": 0, "opcode unreadable": 0,
               "opcode read twice": 0}
    phantom = 0
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
            m = MNEMONIC_AT_START.match(toks[j].lstrip(",.;:| "))
            if m:
                mne = m.group(1)
                break
            if any(toks[j] == m2 for m2 in MODES):
                break          # the next row started; this one has no mnemonic
            j += 1
        if mne is None:
            # A mode label with no instruction after it is a heading or a line
            # of prose, not a row anybody could read.
            phantom += 1
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
        # The scan splits some opcodes across two lines: "6D" arrives as "6"
        # then "D". Rejoin them ONLY when the second half is a hex letter.
        #
        # Requiring merely two single characters is far too loose, and it
        # silently fabricated a row: where a damaged line left "2", "2", "3",
        # "3", it manufactured opcode $22 out of a byte count and a cycle count
        # and filed it under ASL. That went unnoticed because $22 is a JAM in
        # our own measurements, so the comparison skipped it -- an invented row
        # landing exactly where nothing would check it. A letter cannot be a
        # byte or cycle count, which is what makes it a safe signal.
        if len(nums) >= 4 and len(nums[0]) == 1 and re.fullmatch(r"[A-F]", nums[1]):
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
        elif nums and re.fullmatch(r"[0-9A-F]{2}", nums[0]):
            unread.append((mne, mode, int(nums[0], 16)))
            # The opcode survived and its figures did not. The scan runs some
            # tables' number columns together, and guessing which row they
            # belonged to is what fabricates a plausible wrong answer.
            dropped["figures missing from the scan"] += 1
        else:
            unread.append((mne, mode, None))
            dropped["opcode unreadable"] += 1
        i = k if k > i else i + 1
    return out, dropped, seen, repaired, phantom, unread


# Characters the higher-resolution re-read confuses. A different engine makes
# different mistakes -- a zero reads as G, a one as L -- which is precisely why
# the two passes are worth having: they are wrong in different places.
RESCAN_FIXES = {"G": "0", "L": "1", "|": "0", "O": "0", "S": "5", "l": "1", "I": "1"}

# The same mnemonics, unanchored: a re-read line begins with whatever mark the
# scanner made of the table rule, so the anchored pattern never matches it.
MNEMONIC_ANYWHERE = re.compile(r"\b(" + "|".join(sorted(MNEMONICS)) + r")\b")


def rescan_page(pdf, page):
    """Read one page again at higher resolution, with a real OCR engine.

    The primary extraction loses whole number columns on some tables: the
    opcode survives and the bytes and cycles do not. Guessing them fabricates a
    plausible wrong row, and looking them up in our own measurements would make
    the comparison circular. Reading the same published page again, more
    carefully, is neither.
    """
    import shutil
    import tempfile
    if not shutil.which("tesseract") or not shutil.which("pdftoppm"):
        return {}
    with tempfile.TemporaryDirectory() as tmp:
        base = os.path.join(tmp, "pg")
        subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", "400",
                        "-gray", "-png", str(pdf), base],
                       check=True, capture_output=True)
        png = next((os.path.join(tmp, f) for f in sorted(os.listdir(tmp))
                    if f.endswith(".png")), None)
        if png is None:
            return {}
        out = subprocess.run(["tesseract", png, "stdout", "--psm", "6"],
                             check=True, capture_output=True, text=True).stdout

    rows = {}
    lines = out.splitlines()
    for n, line in enumerate(lines):
        m = MNEMONIC_ANYWHERE.search(line)
        if not m:
            continue
        mode = next((md for md in MODES if md in line), None)
        if mode is None:
            continue
        # Reading on into the following line was tried and removed. A row whose
        # figures are missing is immediately followed by the NEXT row, so
        # concatenating them hands this row its neighbour's numbers: ASL Zero
        # Page came back carrying Zero Page,X's $16/2/6. It was thrown out by
        # the cross-pass agreement check rather than shipped, but only because
        # the first pass happened to hold the real opcode -- for a row where it
        # does not, nothing would have caught it. One line only.
        for candidate in (line,):
            parts = candidate.replace(",", " ").split()
            fixed = ["".join(RESCAN_FIXES.get(c, c) for c in tok) for tok in parts]
            tail = [t for t in fixed if re.fullmatch(r"[0-9A-F]{1,2}\*?", t)]
            # The same split-hex rejoin the first pass does: a lone hex letter
            # after a lone digit is one opcode, not two numbers.
            if len(tail) >= 4 and len(tail[0]) == 1 and re.fullmatch(r"[0-9A-F]", tail[1]):
                tail = [tail[0] + tail[1]] + tail[2:]
            if len(tail) >= 3:
                op, by, cy = tail[-3], tail[-2], tail[-1]
                if (re.fullmatch(r"[0-9A-F]{2}", op) and by.isdigit()
                        and re.fullmatch(r"\d\*?", cy)):
                    rows.setdefault((m.group(1), mode), (int(op, 16), int(by), int(cy[0])))
                    break
    return rows


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

    table, dropped, seen, repaired, phantom, unread = appendix_b(text)

    # Rows the first pass could not read get a second, higher-resolution look at
    # the same page. Where the first pass DID recover the opcode, the two must
    # agree on it before the figures are accepted: two engines wrong in
    # different places agreeing on a value is worth something, and neither of
    # them has consulted our measurements.
    # The second pass renders pages and runs an OCR engine over them, which is
    # most of this check's runtime. It recovers six rows out of a hundred and
    # fifty, so it is worth having deliberately and not worth paying for on
    # every publish. Off unless asked.
    rescan = os.environ.get("RESCAN") == "1"
    recovered = 0
    if unread and rescan:
        want = {m for m, _, _ in unread}
        # Which page each row is on, taken from the text already extracted:
        # pdftotext separates pages with a form feed, so the page number is just
        # how many of those came before. Asking the PDF page by page instead
        # cost twenty seconds of subprocesses for the same answer.
        by_page = text.split("\f")
        pages = {}
        for n, page_text in enumerate(by_page, start=1):
            # A page carrying the table has the column headings on it. A page
            # that merely names the instruction in a sentence does not, and
            # re-reading that one finds a heading rather than a row.
            if "APPENDIX B" not in text[:text.find(page_text) + 1]:
                continue
            if "No." not in page_text or "OP" not in page_text:
                continue
            for mne in want:
                if re.search(r"\b" + mne + r"\b", page_text):
                    pages.setdefault(n, set()).add(mne)
        seen_pages = set()
        for pg in sorted(pages):
            rows = rescan_page(PDF, pg)
            if not rows:
                continue
            seen_pages.add(pg)
            for mne, mode, op1 in unread:
                hit = rows.get((mne, mode))
                if hit is None:
                    continue
                op2, by, cy = hit
                if op1 is not None and op1 != op2:
                    continue          # the passes disagree; trust neither
                if op2 in table:
                    continue
                table[op2] = (mne, mode, by, cy)
                bucket = ("figures missing from the scan" if op1 is not None
                          else "opcode unreadable")
                if dropped[bucket]:
                    dropped[bucket] -= 1
                recovered += 1
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
    print(f"  {seen - phantom} rows in the published table "
          f"({phantom} mode labels that were headings, not rows)")
    print(f"  {len(table)} read as opcodes")
    for why, n in dropped.items():
        if n:
            print(f"  {n} skipped: {why}")
    if recovered:
        print(f"  {recovered} rows recovered by re-reading their page at higher "
              f"resolution, with both passes agreeing on the opcode")
    elif unread and not rescan:
        print(f"  {len(unread)} unread rows not re-read: set RESCAN=1 to render "
              f"their pages and read them again (slower, recovers most of them)")
    if repaired:
        # Never silent. A figure resting on a character repair should be
        # visible, because a repair that goes wrong makes a plausible row
        # rather than an obviously broken one.
        print(f"  {len(repaired)} tokens repaired from scan damage: "
              f"{', '.join(sorted(repaired))}")
    total = len(table) + sum(dropped.values()) + phantom
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
