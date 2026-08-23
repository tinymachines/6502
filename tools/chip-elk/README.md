# The chip through ELK

Lays the netlist out with [elkjs](https://github.com/kieler/elkjs) instead of
at its measured die positions.

```bash
npm install elkjs
GROUP=clock:gen OUT=/tmp/g.json node chip2elk.js   # one container
OUT=/tmp/g.json SVG=clockgen.svg node elk2svg.js
```

| env | what |
|---|---|
| `GROUP=<key>` | one container plus everything that crosses its edge |
| `FLAT=1` | every node, no hierarchy |
| (neither) | every node, nested in the 132 containers |
| `DIR`, `PLACE`, `LABELS` | ELK direction, placement strategy, labels on or off |

## This is the opposite of the die graph, on purpose

The die graph puts every node at its own measured centroid and lays out
nothing, because the embedding is a fact we hold rather than something to
infer. This computes an arrangement instead. Both are worth having: where the
designers put a wire, against where a layout algorithm would put it. **Neither
approximates the other, and nothing here may be labelled a picture of the die.**

## What the whole chip costs, measured

| | nodes | edges | time | canvas | background |
|---|---:|---:|---:|---:|---:|
| flat | 1702 | 3044 | 5.4s | 20677 x 18030 | 65% |
| nested in 132 containers | 1547 | 3044 | 10.1s | 32230 x 37773 | 90% |
| one container (`clock:gen`) | 51 | 76 | 0.2s | 1093 x 777 | readable |

**The whole chip lays out fine and renders as texture.** Both whole-chip modes
finish in seconds and produce a valid SVG under a megabyte, and neither is
worth looking at: a mesh of orthogonal lines with the content clustered into
two corners and nothing legible at any scale where all 1547 nodes fit.

Two reasons, and they are not fixable by tuning:

- **Layered wants a DAG and this graph is full of feedback**, which is the
  point of a chip. Sugiyama pays for every back edge with a longer layer, and
  3044 edges over 1547 nodes buys a lot of them. Nesting made it worse, not
  better: containers get laid out into layers too, so the canvas grew 3.4x in
  area and went from 65% empty to 90%.
- **At any scale where the whole chip fits on a screen, a node is sub-pixel.**
  839 of them have no name because nobody needed to refer to them.

## What works instead

**A container.** The median is 8 nodes and 121 of the 132 hold 30 or fewer,
which is a scale a layout algorithm can make readable. `clock:gen` comes out
as `clk0` entering at one edge, the inverter chain climbing through
`clk1out`, `cp1`, `clk2out` and `cclk`, and `cclk` fanning out across every
`dpc*` control line: the "cclk opens 243 switches" figure as a picture rather
than a sentence.

**Or the atlas level**, which `docs/atlas-elk.zip` already does: 132 boxes and
534 bundles, pruned to the heaviest. That reviewer's own finding is the same
one this ran into from the other end: *pruning is the readability knob, not
algorithm tuning.* The median bundle carries one transistor and 381 of 534
carry two or fewer.

## Notes

- Rails are excluded, as everywhere here: `vss` and `vcc` touch hundreds of
  nodes and would put a star through the middle.
- 70 switches are parallel pairs on the same ends under the same control.
  Drawing both stacks two identical lines, so edges dedupe on
  `(a, b, kind)`.
- A gate edge and a switch edge are drawn differently: a switch joins two
  wires without either causing the other. Losing that loses the only
  structural distinction in the picture.
- `node_modules` is not committed. `npm install elkjs` first.
