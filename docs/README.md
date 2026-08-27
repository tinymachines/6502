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

## The engineering notes (`notes/`)

One handbook per area: what each part claims, how it derives it, and every trap
it cost. This is the log `CLAUDE.md` used to carry inline, until that file grew
past the context window it exists to fill. **Read the note for the area you are
about to touch before touching it.** Nothing here is generated; it is written by
whoever last got it wrong.

| | what is in it |
|---|---|
| [`notes/engine.md`](notes/engine.md) | the crates, the `halfphi` split and why it is a licence boundary, the solver, the ported invariants in full, the two oracles, the performance measurements and the search profile, `graph.json`, the two wasm builds, the machine as a value |
| [`notes/service.md`](notes/service.md) | `halfwave`'s line protocol, the stateless state model, the pool measurements, every API route, cartridges and what minting found, the registry, MCP |
| [`notes/web-shell.md`](notes/web-shell.md) | the site menu, the harnesses, the transport, responsive layout and PWA, the CSP, the renderer invariants, the hashed bundle and service worker, the version footer |
| [`notes/tracer-and-chipmap.md`](notes/tracer-and-chipmap.md) | all twenty-five container kinds and how each is derived, the partition into 132 groups, the node grids, the ADC tour, the optimizer |
| [`notes/schematic-and-blocks.md`](notes/schematic-and-blocks.md) | gate recognition from the switch network, the walk both ways, the study view, pin chains, the address on the drawing, the twelve block pages |
| [`notes/pages.md`](notes/pages.md) | Lab, Trace, Exploded, Blueprint, Decode, Programs, Halfshot, Primer, talk, block diagram, pinout, die graph, designer, Timing |
| [`notes/derivations.md`](notes/derivations.md) | the address rubric behind `atlas.md`, the idiom catalogue, the Snake walk, and where the die's names come from |
| [`notes/hosting.md`](notes/hosting.md) | the deploy, the nginx configuration and its silent failures, DNS and TLS, the repository rules |
| [`notes/archive.md`](notes/archive.md) | what is wrong with visual6502.org, what was recovered and how, the drip, and the invariants that keep the archive honest |

A note is prose, not an API reference: it is worth reading end to end once for
an area you are new to, and worth grepping afterwards. Where one says "the X
section", it means either the matching note here or the section still in
`CLAUDE.md`.

## Documents that live elsewhere, and why

Not everything is here, deliberately. A component's handbook belongs beside the
component: moving `service/README.md` into this directory would separate it from
the code it describes, and the copy that gets read would drift from the copy
that gets edited. So this is the index rather than the container.

| | what it covers |
|---|---|
| [`../README.md`](../README.md) | the project: what it is, how to build it, how to verify it |
| [`../CLAUDE.md`](../CLAUDE.md) | the operating guide: commands, the invariants that must not be tidied away, and the digest of traps this project keeps re-learning |
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

### The same containers, live

The documents above are generated into this directory and are read here. The
same derivation is also served and drawn, so a reader who wants to query it
rather than read it does not have to clone anything.

| | |
|---|---|
| <https://6502.tinymachines.ai/api/v1/atlas> | the kinds, the blocks, the counts |
| <https://6502.tinymachines.ai/api/v1/atlas/full> | all of it in one response, `groups.json` byte for byte, 48 KB gzipped |
| <https://6502.tinymachines.ai/api/v1/groups?layer=partition> | the disjoint groups the chip map draws |
| <https://6502.tinymachines.ai/api/v1/groups?layer=containers> | the same derivations unfiltered, overlapping |
| <https://6502.tinymachines.ai/api/v1/groups?layer=absorbed> | the ones that exist only in the overlapping layer |
| <https://6502.tinymachines.ai/api/v1/groups/regs:a> | one group, with the bundles it anchors |
| <https://6502.tinymachines.ai/api/v1/node/pipeUNK39> | one node, and every container that claims it |
| <https://6502.tinymachines.ai/api/v1/tags?multi=true> | the nodes in more than one container |
| <https://6502.tinymachines.ai/api/v1/neighbors?node=a0&via=switch> | a bounded walk out from one node |
| <https://6502.tinymachines.ai/api/> | the reference page, which explains the two layers |
| <https://6502.tinymachines.ai/chipmap> | the partition, drawn |
| <https://6502.tinymachines.ai/tracer> | the same kinds, overlapping, drawn |

The counts are deliberately absent from that table: they are stated once in
this file and once on the API page, and both are checked against the export
rather than typed. `../web/chip-groups.js` is the one hand-written source
behind every row of it.

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

It ends by going all the way down: the control line the walk follows is four
transistors, and the document gives their addresses, their real dimensions, and
the fact that **the median channel on this die is 7.8 micrometres** -- derived
from polygon coordinates measured against the die width someone marked on a MOS
blueprint in 1975, not looked up. The 6502 was made on an eight-micron process.

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
