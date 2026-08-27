#!/usr/bin/env node
// halfphi exists in two repositories, and until now nothing kept them in sync.
//
// `crates/halfphi/` is where the engine is developed, beside the chip it was
// extracted from. `github.com/tinymachines/halfphi` is where it is published,
// on its own, because it is about switch networks rather than about a 6502 and
// because it embeds no die data -- which is the only reason it can be MIT while
// everything here carries the CC BY-NC-SA obligations.
//
// Five files are shared verbatim. They were byte-identical the day of the split
// and drifted on whitespace within minutes of it, which is how the project
// learned that "remember to copy it across" is not a mechanism. This is the
// mechanism: it compares them, and `deploy.sh` refuses to publish on a
// difference.
//
// It SKIPS when the sibling checkout is absent, the way the golden test skips
// without its trace and the timing check skips without the manual: a clone with
// only this repo in it must still be able to deploy. `REQUIRE_HALFPHI=1` makes
// absence a failure instead.
//
//   node tools/check-halfphi.mjs            [--fix]
//   HALFPHI=/path/to/halfphi node tools/check-halfphi.mjs
//
// `--fix` copies this repo's copy over the standalone one, which is the
// direction that is almost always right: the engine is developed here, against
// three chips, and published there. It never copies the other way, because
// doing that silently would undo work rather than reveal it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(ROOT, 'crates', 'halfphi');

// The sibling layout is what a clone of both repositories looks like; the env
// var is for anything else. An explicit HALFPHI is used ALONE: falling back to a sibling when the named
// path is wrong would quietly check a different checkout than the one asked
// for, and report it as fine.
const CANDIDATES = process.env.HALFPHI
  ? [process.env.HALFPHI]
  : [path.resolve(ROOT, '..', 'halfphi'), path.resolve(ROOT, '..', '..', 'halfphi')];

const SHARED = [
  'src/lib.rs',
  'src/source.rs',
  'src/netlist.rs',
  'src/engine.rs',
  'src/slice.rs',
  'tests/chips.rs',
];

const fix = process.argv.includes('--fix');
const there = CANDIDATES.find((p) => fs.existsSync(path.join(p, 'src', 'engine.rs')));

if (!there) {
  const msg = 'check-halfphi: no halfphi checkout found beside this one'
    + ` (tried ${CANDIDATES.join(', ') || 'nothing'}).`;
  if (process.env.REQUIRE_HALFPHI === '1') {
    console.error(msg + ' REQUIRE_HALFPHI=1 makes that a failure.');
    process.exit(1);
  }
  console.log(msg + ' SKIPPING. Set HALFPHI=<path>, or REQUIRE_HALFPHI=1 to insist.');
  process.exit(0);
}

// A file that is missing over there is a difference, not a crash: the split may
// have moved something, and saying which file is the useful half of the report.
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const differ = [];
const missing = [];
for (const rel of SHARED) {
  const a = read(path.join(HERE, rel));
  const b = read(path.join(there, rel));
  if (a === null) { missing.push(`${rel} is missing from crates/halfphi`); continue; }
  if (b === null) { missing.push(`${rel} is missing from ${there}`); continue; }
  if (a !== b) {
    const la = a.split('\n');
    const lb = b.split('\n');
    let first = 0;
    while (first < la.length && first < lb.length && la[first] === lb[first]) first++;
    differ.push({ rel, first: first + 1, here: la.length, over: lb.length });
  }
}

// A file present here and absent there is copied too. Without this, adding a
// shared file reported "missing" and fixed nothing, which is the failure this
// check exists to prevent, wearing the costume of a report.
const absent = missing
  .filter((m) => m.endsWith(`is missing from ${there}`))
  .map((m) => m.split(' ')[0]);

if (fix && (differ.length || absent.length)) {
  for (const rel of [...differ.map((d) => d.rel), ...absent]) {
    fs.copyFileSync(path.join(HERE, rel), path.join(there, rel));
    console.log(`copied crates/halfphi/${rel} -> ${there}/${rel}`);
  }
  console.log('check-halfphi: copied this repo\'s copy over the published one. '
    + 'Commit and push it there, and re-run its tests: the standalone repo runs '
    + '`cargo fmt --check` in CI and this one has never been fmt\'d.');
  process.exit(0);
}

if (missing.length || differ.length) {
  console.error(`check-halfphi: the two copies of halfphi disagree (${there}).`);
  for (const m of missing) console.error(`  ${m}`);
  for (const d of differ) {
    console.error(`  ${d.rel}: first differs at line ${d.first}`
      + ` (${d.here} lines here, ${d.over} there)`);
  }
  console.error('  Fix with: node tools/check-halfphi.mjs --fix');
  console.error('  ...then commit and push in the halfphi repo. Changing one copy'
    + ' means changing the other; that is the whole reason this check exists.');
  process.exit(1);
}

console.log(`check-halfphi: ${SHARED.length} shared files identical (${there}).`);
