// A functional block as a circuit: its boundary, and the drawing of its inside.
//
// Extracted from block.js when the workbench wanted to put a block on its
// bench, which is the same moment and the same reasoning that produced
// sch-draw.js and block-palette.js. The stake here is higher than usual: this
// file decides where a block *stops*, and two pages answering that question
// from two copies would eventually disagree about which wires are ports. A
// reader comparing the block page with the workbench would have no way to tell
// which of them was lying.
//
// It owns no state and reads no DOM. Everything comes in through a context so
// that either page can supply its own already-built indexes:
//
//   data        schematic.json
//   inside      Set of node ids blocks.rs places in this block
//   affiliated  Set of static-logic gates blocks.rs attributes to it
//   gateOf      node -> the gate driving it
//   gatesUsing  node -> gates taking it as an input
//   switchesOn  node -> switches with a channel on it
//   switchesBy  control node -> switches it gates
//   nameOf      node -> display name
//
// The one thing it does NOT own is the layout: that is sch-draw.js, which takes
// the cone this returns and knows nothing about blocks.

// Same cap and the same reason as the workbench: the median forward fan-out is
// 1, but one control line opens 273 switches. A drawing that quietly showed
// sixteen of those would be a claim about the chip rather than a limit of the
// page, so the number dropped is reported.
export const MAX_FAN = 16;

// A runaway guard, not a design choice. The block is the bound; this only stops
// a malformed index from looping forever.
const MAX_LEVELS = 24;

export function createBlockView(ctx) {
  const { data, inside, affiliated, gateOf, gatesUsing, switchesOn, switchesBy, nameOf } = ctx;

  const isRail = (n) => n === data.vss || n === data.vcc;
  const isInside = (n) => inside.has(n);

  /**
   * A static gate this block's own signals are made of.
   *
   * Stopping at membership alone brings almost every block out two or three
   * signals deep. That is not a bug in the walk, it is a fact about the chip: a
   * functional block is not a closed circuit. Its gates are built out of the
   * static logic the blocks are embedded in, which no block claimed because a
   * static gate's output touches nothing but its own pullup and pulldown and
   * the growth rule refuses to cross a rail.
   *
   * Deliberately a *second* category rather than folded into membership,
   * because it is a weaker claim: a quarter of the attributions sit more than
   * 3000 die units from what they drive. Affiliation is not location.
   */
  const isAffiliated = (n) => affiliated.has(n);

  /** Somewhere the walk may keep going, as opposed to somewhere it must stop. */
  const expandable = (n) => isInside(n) || isAffiliated(n);

  /**
   * What crosses the boundary, as four relations that are not the same relation.
   *
   * A gate input arriving from outside is the block being told something; an
   * inside signal used outside is the block telling somebody else; a pass
   * transistor joins two wires without either being the cause of the other; and
   * a control line reaching in is the decoder operating machinery it does not
   * own. Collapsing those four into "connections" would throw away the only
   * thing the picture is for.
   */
  function ports() {
    const gs = [], sw = [];
    const feedsIn = new Map(), drivesOut = new Map(), joined = new Map(), control = new Map();
    // Each port remembers one signal inside the block that it touches, so that
    // something acting on it can reach a place that sees it.
    const note = (map, outer, innerNode) => {
      if (isRail(outer) || isInside(outer)) return;
      if (!map.has(outer)) map.set(outer, innerNode);
    };

    for (const g of gateOf.values()) {
      if (!isInside(g.out)) continue;
      gs.push(g);
      for (const lit of new Set(g.terms.flat())) note(feedsIn, lit, g.out);
    }
    // A switch is filed by its channel, not its gate -- the gate is the control
    // line reaching in from the decoder, and filing by it would put every
    // datapath pass transistor under `Control pipeline`. Same rule as blocks.rs.
    for (const [ctrlNode, list] of switchesBy) {
      for (const w of list) {
        if (!isInside(w.a) && !isInside(w.b)) continue;
        sw.push(w);
        const innerSide = isInside(w.a) ? w.a : w.b;
        note(joined, isInside(w.a) ? w.b : w.a, innerSide);
        note(control, ctrlNode, innerSide);
      }
    }
    // The other direction: an inside signal that something outside reads. A gate
    // outside using it, or a switch outside that it opens -- a control line this
    // block generates is still this block driving the rest of the chip.
    for (const g of gateOf.values()) {
      if (isInside(g.out)) continue;
      for (const lit of new Set(g.terms.flat())) {
        if (isInside(lit) && !drivesOut.has(lit)) drivesOut.set(lit, lit);
      }
    }
    for (const [ctrlNode, list] of switchesBy) {
      if (!isInside(ctrlNode)) continue;
      if (list.some((w) => !isInside(w.a) || !isInside(w.b))) drivesOut.set(ctrlNode, ctrlNode);
    }

    return { gates: gs, switches: sw, feedsIn, drivesOut, joined, control };
  }

  /**
   * Collapse `ab0..ab15` into one port sixteen wide.
   *
   * The eight bits of a bus are eight separate wires and the schematic draws
   * them that way, but a *boundary* listing them eight times says nothing the
   * width does not say better -- and it is the difference between an interface
   * a reader can take in and 153 chips in a grid. Measured: 196 ports collapse
   * to 95 on the data bus, 149 to 71 on the address latches.
   */
  function byStem(map) {
    const out = new Map();
    for (const [node, innerNode] of map) {
      const nm = nameOf(node);
      const block = data.nodeBlock[node] & 0x7f;
      // An unnamed node is `#1446`, and splitting trailing digits off that
      // gives a stem of `#` -- so fifteen unrelated anonymous gate outputs
      // collapsed into one port labelled `# x15`, claiming a bus that does not
      // exist. They are not a bus, but they are not fifteen separate facts
      // either: most are gate outputs in the static logic. They group by where
      // they come from, and the full list stays on the tooltip.
      const named = data.names[node] != null;
      const m = named ? /^(.*?)(\d+)$/.exec(nm) : null;
      const stem = named ? (m && m[1] ? m[1] : nm) : 'unnamed';
      // Keyed by block as well as stem: two blocks can each have unnamed gates,
      // and merging them would put one dot on a group that has two homes.
      const key = `${stem}\u0000${block}`;
      if (!out.has(key)) {
        out.set(key, { stem, bits: [], nodes: [], inner: innerNode, block });
      }
      const e = out.get(key);
      e.nodes.push(node);
      if (m && m[1]) e.bits.push(Number(m[2]));
    }
    return [...out.values()].sort((a, b) =>
      b.nodes.length - a.nodes.length || a.stem.localeCompare(b.stem));
  }

  /**
   * Where the walk starts, which is a property of the block rather than a choice.
   *
   * Backward reads "what makes each value", so it starts at what the block hands
   * to the rest of the chip and works inward. Forward reads "what each value
   * changes", so it starts at what the block is handed. Either way the seeds are
   * measured, not picked, and a block with neither falls back to all of its
   * members so the drawing can never come out empty.
   */
  function seeds(p, dir) {
    const chosen = dir === 'back'
      ? [...p.drivesOut.keys()]
      : [...new Set([...p.feedsIn.values(), ...p.joined.values(), ...p.control.values()])];
    return chosen.length ? chosen : [...inside];
  }

  /**
   * The whole block, laid out from what it produces, plus whatever ports are lit.
   *
   * This used to be a cone from one chosen signal, which meant a reader had to
   * pick somewhere to stand before they could see anything, and what they got
   * depended entirely on where they picked. The block is a better bound than an
   * arbitrary radius: it is the thing being looked at, blocks.rs already
   * measured where it stops, and the picture no longer changes shape depending
   * on where somebody clicked.
   *
   * `lit` is the set of OUTSIDE node ids the reader has switched on. A port not
   * in it is not drawn at all; a port in it is drawn, and followed outward only
   * as far as `reach` allows.
   */
  function cone(seedNodes, dir, lit = new Set(), reach = 1) {
    const levels = [[...seedNodes]];
    const seen = new Set(seedNodes);
    const elements = [];
    let truncated = 0;
    // How far outside the block each drawn node sits. Members are 0; a lit port
    // is 1. Only used to decide whether a lit port may itself be expanded.
    const outDist = new Map(seedNodes.map((n) => [n, 0]));

    for (let level = 0; level < MAX_LEVELS; level++) {
      const next = [];
      for (const node of levels[level]) {
        // A port is a boundary, not a frontier -- unless the reader switched it
        // on and asked for more than the pill. Toggling one is an explicit
        // request for that wire, so following it is not the drawing annexing a
        // neighbour nobody asked about.
        const out = outDist.get(node) ?? 0;
        if (!expandable(node) && out >= reach) continue;

        const push = (n) => {
          if (isRail(n) || seen.has(n)) return;
          // The gate on the whole feature: a port enters the drawing only if it
          // was switched on. Everything inside the block is always drawn.
          const isPort = !expandable(n);
          if (isPort && !lit.has(n)) return;
          seen.add(n);
          outDist.set(n, isPort ? out + 1 : out);
          next.push(n);
        };
        const cap = (list) => {
          if (list.length <= MAX_FAN) return list;
          truncated += list.length - MAX_FAN;
          return list.slice(0, MAX_FAN);
        };

        if (dir === 'back') {
          const g = gateOf.get(node);
          if (g) {
            const inputs = [...new Set(g.terms.flat())];
            elements.push({ kind: g.kind, out: node, inputs, terms: g.terms, level,
                            precharge: g.precharge });
            inputs.forEach(push);
          }
        } else {
          // Forward stops at the edge too: a gate whose output is outside is
          // another block's circuit, and drawing it here would be quietly
          // annexing the neighbour. That the signal leaves at all is what the
          // interface panel is for.
          for (const g of cap((gatesUsing.get(node) || []).filter((x) => expandable(x.out)))) {
            elements.push({ kind: g.kind, out: g.out, inputs: [node], terms: g.terms,
                            level, precharge: g.precharge, forward: true });
            push(g.out);
          }
          for (const w of cap(switchesBy.get(node) || [])) {
            for (const side of [w.a, w.b]) {
              if (isRail(side)) continue;
              elements.push({ kind: 'switch', out: side, inputs: [node],
                              control: node, level, forward: true, opens: true });
              push(side);
            }
          }
        }

        // A pass transistor conducts both ways, so its far side belongs to
        // either reading. If that far side is outside the block it becomes a
        // port, which is exactly right: this is where the block ends.
        for (const w of cap(switchesOn.get(node) || [])) {
          const far = w.a === node ? w.b : w.a;
          elements.push({ kind: 'switch', out: node, inputs: [far], control: w.control, level });
          push(far);
        }
      }
      if (!next.length) {
        // Walking back from what the block produces does not necessarily reach
        // all of it: a member can drive nothing that leaves, or sit behind
        // feedback the backward walk never enters. Measured on the program
        // counter, that left 8 of its 64 signals undrawn, and "the block is
        // drawn" has to mean the whole block or it means nothing. Whatever is
        // left is seeded as a fresh column and the walk continues into it.
        const left = [...inside].filter((n) => !seen.has(n));
        if (!left.length) break;
        for (const n of left) { seen.add(n); outDist.set(n, 0); next.push(n); }
      }
      levels.push(next);
    }
    return { levels, elements, truncated };
  }

  return { isRail, inside: isInside, affiliated: isAffiliated, expandable,
           ports, byStem, seeds, cone };
}
