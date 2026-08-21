## Summary

Promote the named internal latches to first-class `Observation` fields, the way `alu`, `sb`,
`adl` and `adh` already are:

`idl`, `idb`, `dor`, `alua`, `alub` — and probably `abl` / `abh` and `pclp` / `pchp`.

## Why

These are **named storage on the die**, the same category as `a` and `x` — not arbitrary
nodes. Today a consumer that wants them rebuilds each byte from 8 watched bits, which is
repeated work in every client and a repeated chance to get bit order wrong.

It also drops the common case back under the 53-name ceiling in #1, so the two fixes
reinforce each other.

`abl` / `abh` additionally makes the pins-versus-internal-bus divergence first-class. That
divergence is real and currently has to be inferred: over a 132-half-cycle run the internal
`adh:adl` disagrees with the external `addr` in **63 of 132 frames** — every φ2, because the
address buffer holds the φ1 value for the whole cycle. Worth being able to read directly.

## What it unlocks

With these exposed, the whole load path is legible half-cycle by half-cycle. On
`LDA #$2E / STA $80 / LDA #$14 / STA $81 / CLC / LDA $80 / ADC $81 / STA $82`:

```
h=35 φ2  IDL=14                                   DB → IDL
h=36 φ1  IDB=14  ALUA=2E  ALUB=14                 IDL → IDB → adder inputs
h=37 φ2  ALU=42  SB=42            A=2E            the add lands, A untouched
h=38 φ1                           A=42            SB → A
```

Four half-cycles, four distinct latches. This is the sharpest possible statement of the ADC
result timing — the addition itself happens *after* ADC's last cycle, during the next
instruction's fetch — and right now it can only be assembled from 40 per-bit watches across
two requests.

## Acceptance criteria

- [ ] `idl`, `idb`, `dor`, `alua`, `alub` on `Observation` and in `TraceRows.cols`
- [ ] `abl`, `abh`, `pclp`, `pchp` considered (at minimum `abl`/`abh`)
- [ ] Each documented with the same care as the existing note that a precharged bus idles
      high where nothing drives it
