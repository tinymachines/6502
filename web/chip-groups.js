// The whole chip as its derived containers: one disjoint partition of every
// node, composed from the leaf modules that derived each piece of machinery
// for the tracer.
//
// The tracer's containers OVERLAP on purpose: a capsule sits inside a block
// region, the decimal correction runs through the ALU's slices, and a click
// resolves the overlap by priority. A schematic needs the other thing: every
// node in exactly one box. So this module applies the same derivations in the
// tracer's own click order and lets the first container to reach a node keep
// it, which is the one rule the tracer already had ("one owner per node, the
// owner is the most specific claim") applied across every kind at once.
//
// What that order decides, concretely: the pipeline latch file outranks the
// timing chain, so the chain's `pipeTnout` latches file with the latch file
// and the chain keeps its combinational cells; the decimal correction
// outranks the ALU, so the `DA-*` adjust gates file with the correction and
// the slices keep the adder.
//
// What is left after every container has claimed its nodes is grouped by the
// only facts remaining: the functional block a node is filed in ("the rest of
// the Decode PLA": the OR plane, the one unnamed term), and, for the static
// logic, the block its gates drive (`nodeDrives`, the attribution the block
// pages already use), with the gates that drive no single block as one group
// of shared logic.
//
// Not a leaf: it imports every derivation it composes. It still touches no
// DOM, and the page and the harness both call it with the same three files.

import { registerLogic } from './register-logic.js';
import { flagLogic } from './flag-logic.js';
import { addressLatches } from './address-latches.js';
import { dataBus } from './data-bus.js';
import { irPredecode } from './ir-predecode.js';
import { specialBus } from './special-bus.js';
import { storePipeline } from './store-pipeline.js';
import { readyLogic } from './ready-logic.js';
import { pcRegister, pipeFile, syncGen } from './pc-pipe-sync.js';
import { clockGen } from './clock-gen.js';
import { interruptPaths } from './interrupt-paths.js';
import { branchLogic } from './branch-logic.js';
import { decimalCorrection } from './decimal-correction.js';
import { aluSlices } from './alu-slices.js';
import { pcIncrement } from './pc-increment.js';
import { chainCells } from './chain-cells.js';
import { PACKAGE, direction, pinFacts } from './pins.js';

export const REG_STEMS = ['s', 'a', 'x', 'y'];
export const STAGES = ['T0', 'T2', 'T3', 'T4', 'T5', 'T+', 'any'];
// The tracer's click order, which is the ownership order here, with one
// stated exception: the control-line clusters move to the end of the
// containers. The tracer ranks them high because its priority is about what a
// CLICK should hit, and a control outline is small on screen; ownership is
// about which claim is more specific, and "the lines no derivation explains,
// grouped by what they operate" is a catch-all. Left where the tracer has it,
// it took `dpc18_#DAA` and `dpc22_#DSA` away from the decimal correction's
// own walk, which the harness caught. Moved last it comes out empty: once
// every derivation has claimed its own lines, no block has two unexplained
// control lines left to cluster, so the kind exists as a claim that finds
// nothing, which is what a catch-all should be. `bus` (the two internal address buses,
// pure bits nobody's closure claims) and the two residual kinds are this
// module's own, at the end where they belong.
export const KIND_ORDER = ['regs', 'flags', 'alat', 'dbus', 'irp', 'sbus', 'sdp',
  'rdy', 'pcr', 'pipe', 'sync', 'clock', 'intr', 'branch', 'decimal',
  'alu', 'incr', 'chain', 'control', 'bus', 'stage', 'pins', 'rest', 'logic', 'dpc'];

export const KIND_LABEL = {
  regs: 'registers', flags: 'status flags', alat: 'address latches',
  dbus: 'data bus', irp: 'instruction register', sbus: 'special bus',
  sdp: 'store pipeline', rdy: 'ready logic', pcr: 'program counter',
  pipe: 'pipeline latches', sync: 'SYNC', control: 'control lines',
  clock: 'clock generator', intr: 'interrupts', branch: 'branch logic',
  decimal: 'decimal correction', alu: 'ALU', incr: 'PC incrementer',
  chain: 'timing chain', bus: 'internal bus', stage: 'decode terms',
  pins: 'pins', rest: 'rest of a block', logic: 'static logic',
  dpc: 'datapath control by phase',
};

/**
 * Every node the netlist touches: gate outputs, inputs and precharges, switch
 * terminals and controls, plus anything named. The rails are not nodes here.
 */
export function nodeUniverse(sch) {
  const u = new Set();
  for (const [out, , pre, legs] of sch.gates) {
    u.add(out);
    for (const leg of legs) for (const i of leg) u.add(i);
    if (pre >= 0) u.add(pre);
  }
  for (const [c, a, b] of sch.switches) { u.add(c); u.add(a); u.add(b); }
  sch.names.forEach((n, i) => { if (n) u.add(i); });
  u.delete(sch.vss); u.delete(sch.vcc);
  return u;
}

/**
 * @param {object} sch     schematic.json
 * @param {object} blocks  blocks.json (nodeDrives, transistorGate/Block)
 * @param {object} timing  timing.json (the chain's six stages)
 * @returns {{groups: G[], containers: G[], universe:Set<number>, stats:object}}
 *   where G is {key, kind, id, label, nodes}. `groups` is the disjoint
 *   partition (every node once); `containers` is the same derivations
 *   unfiltered, so they overlap, and a container fully absorbed by an
 *   earlier one appears there and not in `groups`.
 */
export function chipGroups(sch, blocks, timing) {
  const universe = nodeUniverse(sch);
  const claimed = new Set();
  const groups = [];
  const containers = [];
  const byName = new Map();
  sch.names.forEach((n, i) => { if (n) byName.set(n, i); });

  // Every candidate set is recorded BEFORE the ownership filter as well as
  // after it. The filtered sets are the partition this page draws; the raw
  // ones are the tracer's own overlapping containers, which is the honest
  // answer to "which groups is this node in" -- a node in the decimal
  // correction is also in an ALU slice, and saying only one of those is a
  // consequence of the drawing needing disjoint boxes, not a fact about the
  // chip. `containers` is additive: nothing above or below reads it, and the
  // partition, its order and its counts are byte for byte what they were.
  const take = (kind, id, label, nodes) => {
    const raw = [...new Set(nodes)]
      .filter((n) => n != null && n >= 0 && universe.has(n))
      .sort((a, b) => a - b);
    if (raw.length) containers.push({ key: `${kind}:${id}`, kind, id: String(id), label, nodes: raw });
    const ns = raw.filter((n) => !claimed.has(n));
    if (!ns.length) return null;
    for (const n of ns) claimed.add(n);
    const g = { key: `${kind}:${id}`, kind, id: String(id), label, nodes: ns };
    groups.push(g);
    return g;
  };

  // 1. The registers, with the sharing split out across all four at once:
  //    #43 and #1247 sit in every register's load cone and belong to none of
  //    them alone. The same rule as the tracer's regsList.
  {
    const cand = [];
    for (const stem of REG_STEMS) {
      const r = registerLogic(sch, { stem });
      if (!r.register.nodes.length) continue;
      cand.push({ id: stem, label: stem.toUpperCase(), nodes: r.register.nodes });
      for (const L of r.lines) cand.push({ id: `${stem}.${L.id}`, label: L.id, nodes: L.cone });
    }
    const owners = new Map();
    for (const g of cand) for (const n of g.nodes) {
      if (!owners.has(n)) owners.set(n, []);
      owners.get(n).push(g.id);
    }
    for (const g of cand) {
      take('regs', g.id, g.label, g.nodes.filter((n) => owners.get(n).length === 1));
    }
    const sharedMap = new Map();
    for (const [n, ids] of owners) {
      if (ids.length < 2) continue;
      const k = ids.join('-');
      if (!sharedMap.has(k)) sharedMap.set(k, []);
      sharedMap.get(k).push(n);
    }
    for (const [k, ns] of sharedMap) take('regs', `shared.${k}`, `shared by ${k.split('-').join(', ')}`, ns);
  }

  // 2..11: each module already resolves its own internal ownership.
  for (const g of flagLogic(sch).groups) take('flags', g.id, g.id === 'out' ? 'P readout' : g.id === 'shared' ? 'shared flag logic' : `${g.id} flag`, g.nodes);
  {
    const r = addressLatches(sch);
    for (const h of r.halves) take('alat', h.id, h.id.toUpperCase(), h.nodes);
    for (const L of r.lines) take('alat', L.id, L.id, L.nodes);
    for (const c of r.consts) take('alat', c.id, c.id === 'low' ? 'ADL constants' : 'ADH constants', c.nodes);
  }
  for (const g of dataBus(sch).groups) take('dbus', g.id, g.id, g.nodes);
  for (const g of irPredecode(sch).groups) take('irp', g.id, g.id, g.nodes);
  for (const g of specialBus(sch).groups) take('sbus', g.id, g.id, g.nodes);
  for (const g of storePipeline(sch).groups) take('sdp', g.id, g.id.toUpperCase(), g.nodes);
  for (const g of readyLogic(sch).groups) take('rdy', g.id, g.id === 'in' ? 'RDY receiver' : g.id, g.nodes);
  for (const g of pcRegister(sch).groups) take('pcr', g.id, g.id, g.nodes);
  for (const g of pipeFile(sch).groups) take('pipe', g.id, g.id === 'unk' ? 'pipeUNK latches' : 'named pipe latches', g.nodes);
  for (const g of syncGen(sch).groups) take('sync', g.id, 'SYNC generator', g.nodes);

  take('clock', 'gen', 'clock generator', [...clockGen(sch).nodes]);
  {
    const r = interruptPaths(sch);
    for (const p of r.paths) take('intr', p.id, `${p.id.toUpperCase()} path`, p.nodes);
    take('intr', 'shared', 'shared interrupt path', r.shared);
    take('intr', 'vector', 'vector selection', r.vector);
  }
  for (const g of branchLogic(sch).groups) take('branch', g.id, `branch: ${g.id}`, g.nodes);
  take('decimal', 'bcd', 'decimal correction', decimalCorrection(sch).nodes);
  for (const g of aluSlices(sch).groups) take('alu', g.id, g.id, g.nodes);
  take('incr', 'pc', 'PC incrementer', pcIncrement(sch).nodes);
  {
    const r = chainCells(sch, timing.stages);
    for (const c of r.cells) take('chain', c.id, `${c.id} cell (${c.name})`, c.nodes);
    take('chain', 'shared', 'shared chain logic', r.shared);
  }

  // The leftover decode control lines, grouped by the block holding most
  //     of the transistors each line gates: the tracer's controlList rule.
  //     A block reaching fewer than two lines is left for the residue.
  {
    const byGate = new Map();
    blocks.transistorGate.forEach((g, t) => {
      if (!byGate.has(g)) byGate.set(g, []);
      byGate.get(g).push(t);
    });
    const perBlock = new Map();
    sch.nodeRole.forEach((role, n) => {
      if (role !== 2 || claimed.has(n) || !universe.has(n)) return;
      const count = new Map();
      for (const t of byGate.get(n) || []) {
        const b = blocks.transistorBlock[t] & 0x7f;
        count.set(b, (count.get(b) || 0) + 1);
      }
      let best = 0, bc = -1;
      for (const [b, c] of count) if (c > bc || (c === bc && b < best)) { best = b; bc = c; }
      if (!perBlock.has(best)) perBlock.set(best, []);
      perBlock.get(best).push(n);
    });
    for (const [b, ns] of [...perBlock].sort((p, q) => p[0] - q[0])) {
      if (ns.length < 2) continue;
      take('control', b, `control: ${sch.blockNames[b]}`, ns);
    }
  }

  // The two internal address buses: pure bits that no closure claims, because
  // everything READS them. Eight named bits each, nothing else.
  for (const stem of ['adl', 'adh']) {
    take('bus', stem, stem, [...Array(8).keys()].map((i) => byName.get(`${stem}${i}`)));
  }

  // The decode PLA's product terms by the stage their names serve: the
  // tracer's stageList rule. The one unnamed term (the irline3 generator)
  // matches no stage and falls to the PLA's residue, where the tracer also
  // leaves it.
  {
    const perStage = new Map(STAGES.map((s) => [s, []]));
    sch.nodeRole.forEach((role, n) => {
      if (role !== 1 || claimed.has(n)) return;
      const nm = sch.names[n];
      if (!nm) return;
      const m = /^op-(T[0-5]|T\+)-/.exec(nm);
      perStage.get(m ? m[1] : 'any').push(n);
    });
    for (const s of STAGES) take('stage', s, `${s} terms`, perStage.get(s));
  }

  // The pins by measured direction, the pinout page's own rule.
  {
    const d = pinFacts(sch);
    const perDir = new Map();
    const seen = new Set();
    for (const p of PACKAGE) {
      if (!p.node || p.power || seen.has(p.node)) continue;
      seen.add(p.node);
      const n = d.byName.get(p.node);
      if (n === undefined) continue;
      const dir = direction(d, p.node) || 'neither';
      if (!perDir.has(dir)) perDir.set(dir, []);
      perDir.get(dir).push(n);
    }
    for (const dir of ['input', 'output', 'bidirectional', 'neither']) {
      take('pins', dir, `${dir} pins`, perDir.get(dir) || []);
    }
  }

  // The residue: whatever no container claimed, grouped by the block it is
  // filed in, and the static logic by the block its gates drive.
  {
    const logicId = sch.blockNames.indexOf('Static logic');
    const perBlock = new Map(), perDrives = new Map();
    for (const n of universe) {
      if (claimed.has(n)) continue;
      const b = sch.nodeBlock[n] & 0x7f;
      if (b === logicId) {
        const d = blocks.nodeDrives[n] || 0;
        if (!perDrives.has(d)) perDrives.set(d, []);
        perDrives.get(d).push(n);
      } else {
        if (!perBlock.has(b)) perBlock.set(b, []);
        perBlock.get(b).push(n);
      }
    }
    for (const [b, ns] of [...perBlock].sort((p, q) => p[0] - q[0])) {
      take('rest', b, `rest of ${sch.blockNames[b]}`, ns);
    }
    for (const [d, ns] of [...perDrives].sort((p, q) => p[0] - q[0])) {
      take('logic', d, d ? `gates driving ${sch.blockNames[d]}` : 'shared static logic', ns);
    }
  }

  // The datapath control lines by the clock phase they are effective in,
  // measured in `export-timing` by watching every `dpc*` node against the two
  // clock outputs while four programs run. This is the one grouping here that
  // is not a fact about the wiring: a line is "effective on phi1" only in the
  // sense that it is high while clk1out is, so it takes a chip run to know.
  // It rides in timing.json because `chipGroups` already receives that file
  // and it is already the product of running the chip 256 times.
  //
  // It is LAST, so it claims nothing: every one of these nodes already
  // belongs to the derivation that explains it (`dpc3_SBX` is the X
  // register's load line before it is a phi1 line). The phase is a second
  // reading of the same nodes, which is exactly what the overlapping
  // container layer is for. `timing.dpc` absent leaves the kind out entirely
  // rather than inventing an empty one.
  if (Array.isArray(timing?.dpc)) {
    const byPhase = new Map();
    for (const d of timing.dpc) {
      // A line no program raised has a null phase and is grouped as such
      // rather than guessed at, the same way an untimed opcode is null.
      const k = d.phase || 'unreached';
      if (!byPhase.has(k)) byPhase.set(k, []);
      byPhase.get(k).push(d.node);
    }
    const LABEL = {
      phi1: 'effective on phi1', phi2: 'effective on phi2',
      both: 'effective on both phases', unreached: 'not raised by the probe programs',
    };
    for (const k of ['phi1', 'phi2', 'both', 'unreached']) {
      if (byPhase.has(k)) take('dpc', k, LABEL[k], byPhase.get(k));
    }
  }

  const stats = {
    universe: universe.size,
    grouped: claimed.size,
    groups: groups.length,
    kinds: new Set(groups.map((g) => g.kind)).size,
  };
  return { groups, containers, universe, stats };
}
