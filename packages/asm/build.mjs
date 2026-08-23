/**
 * Assemble the package from the assembler that already exists.
 *
 * There is exactly one assembler in this project. `service/asm-bridge.mjs`
 * says so, and the Python service shells out to it rather than keeping a
 * second one, precisely so the two cannot drift. A published package that
 * carried its own copy would reintroduce the thing that arrangement exists to
 * prevent, so this copies at build time and `dist/` is gitignored.
 *
 *     node build.mjs
 *
 * It also refuses rather than shipping something it should not. The whole
 * point of this package is that it is MIT in a workspace where most things are
 * not: `netlist.bin` is derived from CC BY-NC-SA die data, and anything that
 * embeds it carries NonCommercial and ShareAlike whatever a licence file says.
 * An assembler is opcode tables and has no business touching a netlist, so if
 * one of these files ever grows an import that could reach one, this stops.
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const HERE = import.meta.dirname;
const WEB = path.join(HERE, "..", "..", "web");
const DIST = path.join(HERE, "dist");

const SOURCES = ["asm.js", "disasm.js"];

// An import that is not one of these is an import this package cannot vouch
// for. The two files import each other and nothing else today; the check is
// for the day that changes.
const ALLOWED_IMPORTS = new Set(["./disasm.js", "./asm.js"]);

// Words that would mean the die data got in. None of them should ever appear
// in an opcode table.
const FORBIDDEN = [/netlist/i, /segdefs/i, /transdefs/i, /\.bin\b/i, /include_bytes/i];

const IMPORT_RE = /^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm;

let failed = 0;
function refuse(why) {
  console.error(`build: ${why}`);
  failed++;
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const name of SOURCES) {
  const from = path.join(WEB, name);
  let body;
  try {
    body = await readFile(from, "utf8");
  } catch (e) {
    refuse(`cannot read ${path.relative(HERE, from)}: ${e.message}`);
    continue;
  }

  for (const pattern of FORBIDDEN) {
    if (pattern.test(body)) {
      refuse(
        `${name} mentions ${pattern} and this package must ship no die data. ` +
          `See NOTICE.md: anything derived from the die data carries ` +
          `NonCommercial and ShareAlike, and this package is MIT.`,
      );
    }
  }

  for (const m of body.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!ALLOWED_IMPORTS.has(spec)) {
      refuse(
        `${name} imports ${spec}, which is not part of this package. ` +
          `Either it belongs here too, or this file no longer stands alone.`,
      );
    }
  }

  await writeFile(path.join(DIST, name), body);
}

if (failed) {
  console.error(`\nbuild: ${failed} problem(s). Nothing was published.`);
  process.exit(1);
}

console.log(`build: ${SOURCES.join(", ")} from web/, no die data, no outside imports`);
