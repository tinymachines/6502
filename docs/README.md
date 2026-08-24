# `docs/`

Documents and artifacts that are about the chip rather than part of the site.
Nothing here is served by `deploy.sh`; the web app is `web/`, and the
preservation archive is `archive/`.

**Two of these are generated and must not be hand-edited.** They carry a
generator line at the top, and the generator refuses to write a file that
fails its own checks.

| | what | state |
|---|---|---|
| [`atlas.md`](atlas.md) | the address rubric, and an entry per container | **generated** |
| [`atlas-matrix.svg`](atlas-matrix.svg) | the whole chip as a 132 x 132 container matrix | **generated** |
| [`idioms.md`](idioms.md) | how the chip is built: the recurring circuit patterns, counted | **generated** |
| [`walk-snake.md`](walk-snake.md) | one Snake instruction followed through the silicon, with schematics | **generated** |
| [`walk/`](walk) | the schematics that walk uses, pulled from the live page | **generated** |
| [`elk/`](elk) | two sample ELK layouts; the other 130 are generated | sample committed |
| [`atlas-elk.zip`](atlas-elk.zip) | a reviewer's own ELK layout of the atlas, with their findings | received |
| [`findings-answers.md`](findings-answers.md) | the engine side of the Halfwave Lab review | written |
| [`halfwave-lab/`](halfwave-lab) | the reviewer's Lab, its source and its build | received |
| `SuperMarioBros.html` | a SourceGen disassembly, kept for reading 6502 in the wild | received |

## Documents that live elsewhere, and why

Not everything is here, deliberately. A component's handbook belongs beside the
component: moving `service/README.md` into this directory would separate it from
the code it describes, and the copy that gets read would drift from the copy
that gets edited. So this is the index rather than the container.

| | what it covers |
|---|---|
| [`../README.md`](../README.md) | the project: what it is, how to build it, how to verify it |
| [`../CLAUDE.md`](../CLAUDE.md) | the working notes. Every trap this project has paid for, written down |
| [`../NOTICE.md`](../NOTICE.md) | **licensing. The die data is CC BY-NC-SA and it propagates** |
| [`../service/README.md`](../service/README.md) | the 6502 as a service: the stateless engine and its HTTP reference |
| [`../games/README.md`](../games/README.md) | the console, the cartridge format, and how to build a ROM |
| [`../packages/asm/README.md`](../packages/asm/README.md) | the assembler, published on its own |
| [`../archive/README.md`](../archive/README.md) | the visual6502.org preservation archive |
| [`../crates/halfphi/README.md`](../crates/halfphi/README.md) | the switch-level engine, which names no chip |
| [`../tools/chip-elk/README.md`](../tools/chip-elk/README.md) | the ELK layouts, and why the whole-chip one does not work |

## The chip, addressed and mapped

Three views of the same 132 containers, and none of them approximates another.

**[`atlas.md`](atlas.md) is the rubric.** Every node, transistor and wire gets
exactly one address, `<container>:<class>:<slot>`, parsed from the right.
**8365 addresses**: 1547 nodes, 3510 transistors, 3308 wires, all unique. The
slot is always the die's own number, because every other field is a derivation
and derivations here move. The document also carries the entry table for all
132 groups and the six containers that exist only in the overlapping layer.

**[`atlas-matrix.svg`](atlas-matrix.svg) is the wiring**, as a matrix rather
than a drawing. Rows and columns are ordered by measured hop distance from the
pins, so reading left to right is reading the chip from its pads inward. It is
**directed**: cell (row a, column b) carries the gate edges by which a drives b,
so a pair bright in both triangles is feedback. Switch bundles are drawn both
ways in their own colour, because a pass transistor conducts both ways and has
no direction to have.

Measured: **534 of 8646 possible pairs are wired, 6.2%**; 16 pairs carry gate
edges in both directions; exactly one group has no bundle at all, `rest:0`,
which is the provably inert structure. The heaviest pair by a wide margin is
`irp:ir ~ stage:T0` at 166, the instruction register into the decode stages,
and it is the bright band across the top third.

**[`elk/`](elk) is the layout question asked the other way.** The die graph
puts every node at its measured centroid and lays out nothing, because the
embedding is a fact we hold. ELK computes an arrangement instead. Both are
worth having and **neither is a picture of the die.**

- **The whole chip as one ELK layout does not work, and that is the finding.**
  It comes out roughly 90% empty canvas: layered layout wants a DAG and this
  graph is dense and full of feedback. That is precisely the case a matrix
  reads better than a drawing, which is why `atlas-matrix.svg` exists.
- **Per container it works well.** All 132 are generated into `web/chip-elk/`
  and appear on the chip map's boxes. Two are committed here as samples so the
  form is visible without a build: [`clock-gen.svg`](elk/clock-gen.svg) (the
  16-node clock generator, derived) and [`alu-bit3.svg`](elk/alu-bit3.svg)
  (one ALU bit slice).

## How the chip is built

[`idioms.md`](idioms.md) is the other half of the atlas. The atlas says *where*
everything is; this says *what shape* it is and why a designer in 1975 would
choose that shape. Every count is derived; the one-line "why" on each idiom is
authored and marked as such, the same split `block-notes.js` keeps.

The findings that carry the most teaching weight, all measured:

- **There is no AND gate and no OR gate anywhere on this die.** NMOS builds an
  inverted sum of products and nothing else, so the technology's cost model is
  visible in the gate mix: 354 NORs against 39 NANDs, because series
  transistors are slow and parallel ones are cheap.
- **Every register bit is the same two-inverter ring with a switch in it**, 53
  of 53, no exceptions. Four transistors instead of a static cell's six, and
  the price is that the 6502 forgets if you stop the clock.
- **The 386 storage nodes fall into six shapes and the generator refuses to
  write unless they partition exactly.**
- **The widest wire has 12 sources**, each a pass transistor with a decode line
  of its own, and the line names come in load/drive pairs.
- **`LAX` is derived, not asserted**: `op-T0-lda` and `op-T0-ldx/tax/tsx` both
  match for exactly 8 opcodes, all with low bits `11`, the bit neither row
  constrains. The PLA does not know what an instruction is; it matches
  patterns, and every pattern it can match, it will.

## The series

[`walk-snake.md`](walk-snake.md) is part one of a series on writing a game for a
chip you can see inside. It takes one instruction out of the real Snake ROM
(`STA $0400,X`, the screen clear), follows it through five cycles, and sets the
vocabulary on the way: RAM against ROM, gates against dynamic nodes against
paths, the address rubric, and how a player's keypress actually arrives.

Everything in it is measured by running Snake on the simulation, and the
schematics are **pulled from the live schematic page** rather than drawn again,
because a second drawing of an NMOS gate would eventually draw it differently.

The remaining parts are listed at the end of that document.

## Regenerating

```bash
# the two generated documents. Both read web/*.json, so regenerate those first
# if the die data or a derivation changed.
python3 tools/export-atlas-doc.py        # -> docs/atlas.md
python3 tools/export-atlas-matrix.py     # -> docs/atlas-matrix.svg
python3 tools/export-idioms.py           # -> docs/idioms.md
python3 tools/export-walk.py             # -> docs/walk-snake.md + docs/walk/*.svg
#   needs target/release/halfwave and a browser; FRESH=1 re-grabs the SVGs

# the 132 container diagrams -> web/chip-elk/ (generated, gitignored)
cd tools/chip-elk && npm install elkjs && bash run.sh
```

Both generators exit non-zero rather than write a file whose table fails. The
address rubric is mutation-proved: dropping the slot makes the uniqueness check
fire and nothing is written.

## What is checked, and against what

The atlas is derived from the die data, so the interesting question is whether
it agrees with anyone else. Three oracles, none of them ours:

| check | oracle | result |
|---|---|---|
| `tools/check-dpc-vs-wiki.py` | the visual6502 wiki's own claims about the datapath control lines | 37 of 37 phase claims agree |
| `tools/check-timing-vs-manual.py` | Appendix B of the MCS6500 programming manual | 138 rows, nothing disagrees |
| `cargo test -p v6502-sim --test golden` | the original JavaScript engine, every node at every half-cycle | bit exact |

`check-dpc-vs-wiki.py` also answers the question the naming rubric rests on:
**where the die's names come from.** Hanson named the signals `SOURCE/DEST` off
the MOS blueprints, Balazs used a positional grid off his own die photograph,
and the names we actually carry are JSSim's, which are a **position prefix plus
Hanson's name**. Half of every control-line name is a coordinate and half is a
function, and neither half is ours. `docs/atlas.md` states it; the wiki page it
comes from is `archive/wiki-raw/wikitext/6502_datapath.wiki`.
