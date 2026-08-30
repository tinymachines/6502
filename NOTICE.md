# Notices and licensing

This project is built on the visual6502 die trace, which is **not** all under the
same licence as the code. The split matters for distribution.

## This project's own code

The Rust crates (`crates/`), the golden-trace harness (`tools/`), the deploy
tooling (`deploy/`) and anything under `web/` are MIT licensed — see `LICENSE`.

Portions of `crates/v6502-sim` and `crates/v6502-netlist` are a Rust port of
MIT-licensed visual6502 JavaScript; that copyright notice is reproduced in
`LICENSE-THIRD-PARTY`.

`crates/v6502-pins` is MIT and carries no die data. The traces it records
into `tools/pin-golden/` are derived from the die data and are gitignored,
like the golden trace. `crates/v6502-hybrid` builds its tables from the
schematic derived from the die data at run time and so ships nothing of its
own, but anything built with it embeds `netlist.bin` and is under the terms
below, exactly as `v6502-sim` is.

## Why the die data is a submodule

`extern/visual6502` is referenced as a git submodule rather than vendored. This
repository therefore does not redistribute the CC BY-NC-SA data at all — it
points at the upstream project, which is the party that licensed it. A *build*
still derives from that data, so the terms below apply to build outputs and to
any deployment.

## The chip data — CC BY-NC-SA 3.0

`extern/visual6502/segdefs.js`, `extern/visual6502/transdefs.js` and
`extern/visual6502/expert-allinone.js` are released under
[Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported](http://creativecommons.org/licenses/by-nc-sa/3.0/),
copyright 2010 Greg James, Brian Silverman, Barry Silverman.

Attribution is required to **Greg James** and **www.visual6502.org**.

This is the polygon and transistor data — the actual die trace. `v6502-netlist`
derives `netlist.bin` from it at build time and embeds that in every binary and
`.wasm` artefact, so:

- **NonCommercial** and **ShareAlike** propagate to anything this project ships.
- A commercial release would need the data re-derived from an independent die
  trace, or separate permission from the rights holders.

Decide this before publishing or monetising anything built here.

## The reference implementation — MIT

`extern/visual6502/`'s simulation and UI code (`chipsim.js`, `wires.js`,
`expertWires.js`, `kioskWires.js`, `macros.js`, `memtable.js`, `nodenames.js`)
is MIT licensed, copyright 2010 Brian Silverman, Barry Silverman, Ed Spittles,
Segher Boessenkool, Achim Breidenbach.

The algorithms in `v6502-sim` are a port of this code. `nodenames.js` — the
signal name table — is MIT, so the naming vocabulary carries no NC restriction.

## Third-party

`extern/visual6502/3rdparty/` (jQuery 1.3.2, jquery.cookie, splitter.js) is
MIT/GPL dual licensed. None of it is used by this project.
