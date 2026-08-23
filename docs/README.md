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
| [`elk/`](elk) | two sample ELK layouts; the other 130 are generated | sample committed |
| [`atlas-elk.zip`](atlas-elk.zip) | a reviewer's own ELK layout of the atlas, with their findings | received |
| [`findings-answers.md`](findings-answers.md) | the engine side of the Halfwave Lab review | written |
| [`halfwave-lab/`](halfwave-lab) | the reviewer's Lab, its source and its build | received |
| `SuperMarioBros.html` | a SourceGen disassembly, kept for reading 6502 in the wild | received |

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

## Regenerating

```bash
# the two generated documents. Both read web/*.json, so regenerate those first
# if the die data or a derivation changed.
python3 tools/export-atlas-doc.py        # -> docs/atlas.md
python3 tools/export-atlas-matrix.py     # -> docs/atlas-matrix.svg

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
