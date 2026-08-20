// Validate a halfshot export without a browser.
//
//     node tools/check-halfshot.mjs halfshot-fibonacci-256.json
//
// The page's harness (`web/_halfshot-test.html`) checks the recording against
// a second chip while it is being made. This checks the FILE, after the fact,
// the way a reader who was handed one would: from the bytes in it, plus the
// three published JSON files it was recorded against when they are beside it
// (`web/blueprint.json`, `web/schematic.json`, `web/decode.json`), and the
// program source (`web/programs.js`). It was written because the first reader
// of an export found a real bug (the vcc rail dipping) and three ambiguities
// by doing exactly this by hand; everything they checked is here, so the next
// export cannot regress on any of it silently.
//
// What is checked, in order, and every group reports what it covered:
//
//   header       format, version, encoding block, node count, rails declared
//   frames       one per half-cycle; h contiguous except across a declared gap;
//                phase alternates and the file ends on a phi2 (unless capped)
//   levels       frame 0 unpacks (LSB first, zero pad); every delta names only
//                nodes that were at the other level; no delta touches a rail;
//                vss is 0 and vcc is 1 in every frame
//   fields       units are a byte or [value, mask] with value inside mask; p
//                has no bit 5; the p register has bit 5 set; open and terms
//                have the declared widths; every opcode fetch is a read of `op`
//                at `fetch`; every access sits on its edge (a read as clk0
//                falls, a write as it rises)
//   memory       reads of program bytes return the program, reads of an
//                address written earlier return what was written, and after a
//                gap the whole 64 KiB image is known and every read is checked
//   derived      with the JSON beside it: pins, sync, clk0 and rw agree with
//                the named nodes' levels; units, open switches and decode terms
//                are recomputed from the levels and compared
//   program      the bytes named in the file are what `programs.js` assembles
//   instructions contiguous, each opening on a fetch of its own opcode
//
// Exit status is nonzero on any failure. Version 1 files are accepted with a
// note: in them the rails check and the last-frame check are reported rather
// than failed, because both were true of every version 1 export.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', 'web');

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/check-halfshot.mjs <halfshot-export.json>');
  process.exit(2);
}

let fails = 0;
const groups = [];
let cur = null;
const group = (name) => { cur = { name, checks: 0, notes: [] }; groups.push(cur); };
const check = (cond, what) => {
  cur.checks++;
  if (!cond) { fails++; cur.notes.push(`FAIL ${what}`); }
};
const note = (what) => cur.notes.push(`note ${what}`);
const hex2 = (v) => v.toString(16).padStart(2, '0');
const hex4 = (v) => v.toString(16).padStart(4, '0');

const file = JSON.parse(readFileSync(path, 'utf8'));
const frames = file.frames || [];
const N = frames.length;

// --- header -----------------------------------------------------------------
group('header');
check(file.format === 'v6502.halfshot', `format is ${JSON.stringify(file.format)}`);
const v1 = file.version === 1;
check(file.version === 1 || file.version === 2, `version is ${file.version}`);
if (v1) note('version 1: rails and the last frame are reported, not failed');
check(v1 || (file.encoding && typeof file.encoding.levels === 'string'), 'version 2 carries an encoding block');
// The build stamp is optional (older files predate it) but must be well
// formed when present: `exported` a real timestamp, `commit` a string or
// null. A stamp that does not parse is worse than none.
if (file.build != null) {
  check(typeof file.build === 'object', 'build is an object');
  check(!Number.isNaN(Date.parse(file.build.exported)), `build.exported parses (${file.build.exported})`);
  check(file.build.commit === null || typeof file.build.commit === 'string', 'build.commit is a string or null');
  note(`build: ${file.build.commit ?? 'no commit (dev export)'} exported ${file.build.exported}`);
} else {
  note('no build stamp (an export from before the stamp existed)');
}
check(Number.isInteger(file.nodes) && file.nodes > 0, `nodes is ${file.nodes}`);
check(file.rails && Number.isInteger(file.rails.vss) && Number.isInteger(file.rails.vcc), 'rails declared');
check(file.rails && file.rails.vss === 558 && file.rails.vcc === 657,
      `rails are visual6502's 558/657 (got ${file.rails && file.rails.vss}/${file.rails && file.rails.vcc})`);
check(Array.isArray(file.units) && Array.isArray(file.controls) && Array.isArray(file.terms), 'units, controls and terms named');
check(N > 0, 'at least one frame');
if (fails) { report(); process.exit(1); }
const { vss, vcc } = file.rails;
const nodes = file.nodes;

// --- frames -----------------------------------------------------------------
group('frames');
let gaps = 0;
let hBad = 0;
let phBad = 0;
for (let k = 0; k < N; k++) {
  const f = frames[k];
  if (k === 0) { check(f.h === 0, `frame 0 is half-cycle 0 (h ${f.h})`); continue; }
  const p = frames[k - 1];
  if (f.gap > 0) {
    gaps++;
    if (f.h !== p.h + f.gap) hBad++;
    check(typeof f.mem === 'string', `frame ${k} after a gap carries a memory image`);
  } else if (f.h !== p.h + 1) hBad++;
  if (f.ph !== 1 && f.ph !== 2) phBad++;
  if (!(f.gap > 0) && f.ph === p.ph) phBad++;
}
check(hBad === 0, `${hBad} frames whose h does not follow the previous one (gap counted)`);
check(phBad === 0, `${phBad} frames whose phase does not alternate`);
const last = frames[N - 1];
const capped = N >= 4096;
if (v1) note(`last frame is phi${last.ph}${last.ph === 1 ? ' (a lone phi1; version 1 did this)' : ''}`);
else check(last.ph === 2 || capped, `last frame is phi${last.ph}${capped ? ' at the cap' : ''}`);
note(`${N} frames, h ${frames[0].h}..${last.h}, ${gaps} gap${gaps === 1 ? '' : 's'}`);

// --- levels -----------------------------------------------------------------
group('levels');
const unpack = (b64) => {
  const s = Buffer.from(b64, 'base64');
  const out = new Uint8Array(nodes);
  for (let i = 0; i < nodes; i++) if ((s[i >> 3] >> (i & 7)) & 1) out[i] = 1;
  return { out, bytes: s };
};
check(typeof frames[0].levels === 'string', 'frame 0 carries levels in full');
const { out: lv, bytes: b0 } = unpack(frames[0].levels || '');
check(b0.length === Math.ceil(nodes / 8), `frame 0 is ${b0.length} bytes for ${nodes} nodes`);
const padBits = b0.length * 8 - nodes;
check(padBits === 0 || (b0[b0.length - 1] >> (8 - padBits)) === 0, `the ${padBits} pad bits are zero`);
let deltaBad = 0, railTouched = 0, railBad = 0, transitions = 0;
const touched = new Set();
const levelsAt = [lv.slice()]; // kept per frame for the derived checks; 1725 B x N is fine
if (lv[vss] || !lv[vcc]) railBad++;
for (let k = 1; k < N; k++) {
  const f = frames[k];
  if (!Array.isArray(f.up) || !Array.isArray(f.down)) { deltaBad++; levelsAt.push(lv.slice()); continue; }
  for (const n of f.up) {
    if (n === vss || n === vcc) railTouched++;
    if (lv[n]) deltaBad++;
    lv[n] = 1; touched.add(n); transitions++;
  }
  for (const n of f.down) {
    if (n === vss || n === vcc) railTouched++;
    if (!lv[n]) deltaBad++;
    lv[n] = 0; touched.add(n); transitions++;
  }
  if (lv[vss] || !lv[vcc]) railBad++;
  levelsAt.push(lv.slice());
}
check(deltaBad === 0, `${deltaBad} delta entries name a node already at that level`);
if (v1) note(`${railBad} frames with a rail off its level, ${railTouched} deltas touching a rail (version 1 exports do this)`);
else {
  check(railTouched === 0, `${railTouched} delta entries touch a rail`);
  check(railBad === 0, `${railBad} frames with vss high or vcc low`);
}
note(`${transitions} transitions on ${touched.size} distinct nodes replayed`);

// --- fields -----------------------------------------------------------------
group('fields');
let unitBad = 0, pBad = 0, openBad = 0, termBad = 0, fetchBad = 0, edgeBad = 0, accessCount = 0;
const pIdx = file.units.indexOf('p');
for (let k = 0; k < N; k++) {
  const f = frames[k];
  if (!Array.isArray(f.units) || f.units.length !== file.units.length) { unitBad++; continue; }
  f.units.forEach((u, i) => {
    if (typeof u === 'number') { if (u < 0 || u > 255 || !Number.isInteger(u)) unitBad++; return; }
    if (!Array.isArray(u) || u.length !== 2 || (u[0] & ~u[1]) !== 0 || u[1] === 0xff) unitBad++;
    if (i === pIdx && u[1] !== 0xdf) unitBad++;
  });
  if ((f.p & 0x20) === 0) pBad++;
  if (pIdx >= 0 && Array.isArray(f.units[pIdx]) && (f.units[pIdx][0] | 0x20) !== f.p) pBad++;
  if (typeof f.open !== 'string' || f.open.length !== file.controls.length || /[^01]/.test(f.open)) openBad++;
  if (!Array.isArray(f.terms) || f.terms.some((t) => !Number.isInteger(t) || t < 0 || t >= file.terms.length)) termBad++;
  const a = f.access;
  if (k === 0) { if (a) edgeBad++; continue; }
  if (a) {
    accessCount++;
    if (a.kind === 'R' && (f.clk0 !== 0 || f.rw !== 'R')) edgeBad++;
    if (a.kind === 'W' && (f.clk0 !== 1 || f.rw !== 'W')) edgeBad++;
    if (a.kind !== 'R' && a.kind !== 'W') edgeBad++;
  } else if ((f.clk0 === 0 && f.rw === 'R') || (f.clk0 === 1 && f.rw === 'W')) edgeBad++;
  // An opcode fetch is the falling-edge read of `op` at `fetch`.
  if (f.sync === 1 && f.clk0 === 0 && !(a && a.kind === 'R' && a.addr === f.fetch && a.val === f.op)) fetchBad++;
}
check(unitBad === 0, `${unitBad} unit values malformed (byte, or [value, mask] with value inside mask; p masked 0xDF)`);
check(pBad === 0, `${pBad} frames where the p register or the p unit disagree about bit 5`);
check(openBad === 0, `${openBad} frames whose open string is not one 0/1 per control`);
check(termBad === 0, `${termBad} frames with a term index out of range`);
check(edgeBad === 0, `${edgeBad} accesses on the wrong edge, or edges with no access`);
check(fetchBad === 0, `${fetchBad} opcode fetches that are not a read of op at fetch`);
note(`${accessCount} accesses, all on their edge`);

// --- memory -----------------------------------------------------------------
group('memory');
const prog = file.program || {};
const progBytes = typeof prog.bytes === 'string' ? prog.bytes.match(/../g).map((h) => parseInt(h, 16)) : null;
const loadAddr = prog.loadAddr;
check(progBytes && Number.isInteger(loadAddr), 'the file names the program and where it was loaded');
let known = new Map(); // addr -> byte, what we can say memory holds
let image = null;      // after a gap: the whole thing
let readBad = 0, readsChecked = 0, selfMod = 0;
if (progBytes) progBytes.forEach((b, i) => known.set((loadAddr + i) & 0xffff, b));
for (let k = 1; k < N; k++) {
  const f = frames[k];
  if (f.gap > 0 && typeof f.mem === 'string') {
    image = Buffer.from(f.mem, 'base64');
    check(image.length === 65536, `frame ${k}: memory image is ${image.length} bytes`);
    if (progBytes) {
      let same = 0;
      progBytes.forEach((b, i) => { if (image[(loadAddr + i) & 0xffff] === b) same++; });
      if (same !== progBytes.length && selfMod === 0) note(`frame ${k}: program area differs from the source in ${progBytes.length - same} bytes`);
    }
    known = new Map();
  }
  const a = f.access;
  if (!a) continue;
  if (a.kind === 'W') {
    if (progBytes && a.addr >= loadAddr && a.addr < loadAddr + progBytes.length) selfMod++;
    if (image) image[a.addr] = a.val; else known.set(a.addr, a.val);
  } else {
    const expect = image ? image[a.addr] : known.get(a.addr);
    if (expect !== undefined) { readsChecked++; if (expect !== a.val) readBad++; }
  }
}
check(readBad === 0, `${readBad} reads disagree with what memory must hold`);
note(`${readsChecked} reads checked against the program bytes, earlier writes${image ? ' and the post-gap image' : ''}`
     + (selfMod ? `; ${selfMod} writes into the program area` : ''));

// --- derived, when the JSON is beside us --------------------------------------
group('derived');
const load = (n) => (existsSync(join(web, n)) ? JSON.parse(readFileSync(join(web, n), 'utf8')) : null);
const sch = load('schematic.json');
const bp = load('blueprint.json');
const dec = load('decode.json');
if (!sch || !bp || !dec) note('web/{schematic,blueprint,decode}.json not all present: derived checks skipped');
else {
  check(sch.names.length === nodes, `schematic.json has ${sch.names.length} nodes, file says ${nodes}`);
  check(sch.vss === vss && sch.vcc === vcc, 'schematic.json agrees about the rails');
  const id = new Map(sch.names.map((n, i) => [n, i]).filter(([n]) => n));
  const pinNames = frames[0].pins ? Object.keys(frames[0].pins) : [];
  const unknownPin = pinNames.filter((p) => !id.has(p));
  check(unknownPin.length === 0, `pins not on the die: ${unknownPin.join(', ')}`);
  let pinBad = 0, syncBad = 0, clkBad = 0, rwBad = 0, uBad = 0, oBad = 0, tBad = 0;
  const unitsOk = bp.units.length === file.units.length && bp.units.every((u, i) => u.name === file.units[i]);
  const linksOk = bp.links.length === file.controls.length && bp.links.every((l, i) => l.control === file.controls[i]);
  const termsOk = dec.rows.length === file.terms.length;
  check(unitsOk, 'blueprint.json names the units in the file\'s order');
  check(linksOk, 'blueprint.json names the controls in the file\'s order');
  check(termsOk, `decode.json has ${dec.rows.length} terms, file names ${file.terms.length}`);
  for (let k = 0; k < N; k++) {
    const f = frames[k];
    const L = levelsAt[k];
    for (const p of pinNames) if (id.has(p) && f.pins[p] !== L[id.get(p)]) pinBad++;
    if (f.sync !== L[id.get('sync')]) syncBad++;
    if (f.clk0 !== L[id.get('clk0')]) clkBad++;
    if ((f.rw === 'R' ? 1 : 0) !== L[id.get('rw')]) rwBad++;
    if (unitsOk) bp.units.forEach((u, i) => {
      let v = 0, mask = 0;
      for (let b = 0; b < 8; b++) if (u.bits[b] != null) { mask |= 1 << b; if (L[u.bits[b]]) v |= 1 << b; }
      const got = f.units[i];
      const same = mask === 0xff ? got === v : Array.isArray(got) && got[0] === v && got[1] === mask;
      if (!same) uBad++;
    });
    if (linksOk) bp.links.forEach((l, i) => { if ((L[l.controlNode] ? '1' : '0') !== f.open[i]) oBad++; });
    if (termsOk) {
      const t = [];
      dec.rows.forEach((r, i) => { if (L[r.node]) t.push(i); });
      if (t.join(',') !== f.terms.join(',')) tBad++;
    }
  }
  check(pinBad === 0, `${pinBad} pin readings disagree with the named node's level`);
  check(syncBad === 0 && clkBad === 0 && rwBad === 0, `sync/clk0/rw disagree with their nodes in ${syncBad}/${clkBad}/${rwBad} frames`);
  check(uBad === 0, `${uBad} unit values differ from the bits recomputed from the levels`);
  check(oBad === 0, `${oBad} open flags differ from the control node's level`);
  check(tBad === 0, `${tBad} frames whose decode terms differ from the term nodes' levels`);
  note(`${N} frames: ${pinNames.length} pins, ${bp.units.length} units, ${bp.links.length} controls, ${dec.rows.length} terms recomputed`);
}

// --- program ------------------------------------------------------------------
group('program');
if (!progBytes) note('no program bytes in the file');
else {
  try {
    const { PROGRAMS, LOAD_ADDR } = await import(join(web, 'programs.js'));
    const src = PROGRAMS.find((p) => p.id === prog.id);
    check(!!src, `programs.js knows program "${prog.id}"`);
    if (src) {
      const same = src.bytes.length === progBytes.length && [...src.bytes].every((b, i) => b === progBytes[i]);
      check(same, `the file's ${progBytes.length} program bytes are what programs.js assembles for "${prog.id}" (${src.bytes.length})`);
      check(LOAD_ADDR === loadAddr, `loaded at $${hex4(loadAddr)}, programs.js says $${hex4(LOAD_ADDR)}`);
    }
    check(frames[0].fetch === loadAddr && frames[0].sync === 1, `frame 0 fetches from $${hex4(frames[0].fetch)} with sync ${frames[0].sync}`);
    check(!progBytes || frames[0].op === progBytes[0], `frame 0's opcode is $${hex2(frames[0].op)}, program starts $${hex2(progBytes[0])}`);
  } catch (e) {
    note(`programs.js could not be loaded (${e.message}); program bytes not compared`);
  }
}

// --- instructions -----------------------------------------------------------------
group('instructions');
const ins = file.instructions || [];
let insBad = 0;
ins.forEach((s, i) => {
  if (i > 0 && s.start !== ins[i - 1].end + 1) insBad++;
  const f = frames[s.start];
  if (!f) { insBad++; return; }
  if (s.gap > 0) { if (!(f.gap > 0)) insBad++; return; }
  if (!(f.sync === 1 && f.clk0 === 0 && f.fetch === s.at && f.op === s.op)) insBad++;
});
check(ins.length > 0, 'the file groups frames into instructions');
check(insBad === 0, `${insBad} instruction entries not contiguous or not opening on their own fetch`);
if (ins.length) check(ins[ins.length - 1].end === N - 1, 'the last instruction ends on the last frame');
note(`${ins.length} instructions`);

report();
process.exit(fails ? 1 : 0);

function report() {
  for (const g of groups) {
    const bad = g.notes.filter((n) => n.startsWith('FAIL')).length;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${g.name.padEnd(12)} ${g.checks} checks`);
    for (const n of g.notes) console.log(`     ${n}`);
  }
  console.log(fails ? `check-halfshot: ${fails} FAILED` : 'check-halfshot: all checks passed');
}
