#!/usr/bin/env node
/**
 * The pack: every headless program on the site, minted as a cartridge.
 *
 *   node games/tools/mint-pack.mjs                       # mint to games/pack/
 *   node games/tools/mint-pack.mjs --api http://127.0.0.1:6510
 *   node games/tools/mint-pack.mjs --publish --handle tinymachines --token T
 *
 * The seven programs the explorer boots live in web/programs.js, and they
 * are the source here: this reads that module, so a program added there is
 * a cartridge here by being added, and one edited there is re-minted rather
 * than drifting. The eighth is the docs' worked example ("two ways in"),
 * which is not in programs.js because the explorer has no page for it; it
 * is the one literal in this file, and it is short.
 *
 * Each is a `kind: headless` cartridge: no screen, no tick flag; `peek` is
 * the program's own `watch` list (the byte its page points at), and the run
 * is 4000 half-cycles, enough for every one of them to be well into its
 * loop. The API mints it, runs it, and the file carries what the chip did.
 *
 * --publish PUTs each into the registry under the handle, slug = the
 * program's id. The registry runs each one again and lists it with what it
 * measured; the file's own verify block is not what is published.
 *
 * The .cart.gz files are written to games/pack/ (gitignored): the registry
 * is where they live, and a committed copy would be a second copy.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const OUT = path.join(ROOT, "games", "pack");

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const API = (opt("--api") || process.env.API || "https://6502.tinymachines.ai/api").replace(/\/$/, "");
const PUBLISH = args.includes("--publish");
const HANDLE = opt("--handle", "tinymachines");
const TOKEN = opt("--token") || process.env.TOKEN;
const HALF_CYCLES = Number(opt("--half-cycles", "4000"));

const { PROGRAMS, LOAD_ADDR } = await import(path.join(ROOT, "web", "programs.js"));

/** The docs' worked example: LDA, CLC, ADC, BRK. `$2E + $14 = $42` in A. */
const TWO_WAYS = {
  id: "two-ways-in",
  name: "Two ways in",
  blurb: "The worked example from the API's front page: LDA #$2E, CLC, ADC #$14, BRK. "
       + "The sum lands in A two half-cycles after the instruction boundary.",
  source: "        .org $0200\n        LDA #$2E\n        CLC\n        ADC #$14\n        BRK\n",
  watch: [],
};

const programs = [...PROGRAMS, TWO_WAYS];

async function call(method, p, body, token) {
  const r = await fetch(API + p, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

fs.mkdirSync(OUT, { recursive: true });
let minted = 0;
for (const p of programs) {
  const body = {
    rom: { source: p.source, org: LOAD_ADDR },
    console: {
      kind: "headless",
      half_cycles: HALF_CYCLES,
      peek: (p.watch || []).slice(0, 8).map((w) => ({ addr: w.addr, name: w.name })),
    },
    meta: { name: p.name, author: HANDLE, blurb: (p.blurb || "").slice(0, 400) },
  };
  const gz = Buffer.from(await (await call("POST", "/v1/cartridge", body)).arrayBuffer());
  const file = path.join(OUT, `${p.id}.cart.gz`);
  fs.writeFileSync(file, gz);
  minted += 1;
  const json = await (await call("POST", "/v1/cartridge?format=json", body)).json();
  const v = json.verify;
  const peeked = Object.entries(v.peeked || {}).map(([k, x]) => `${k}=$${x.toString(16).padStart(2, "0")}`).join(" ");
  console.log(`${p.id.padEnd(12)} ${json.cartridge.rom.size.toString().padStart(3)} B  ran ${v.half_cycles[0]}  pc $${v.registers.pc.toString(16).padStart(4, "0")} ${v.pc_moved ? "moving" : "STOPPED"}  ${peeked}`);
  if (PUBLISH) {
    if (!TOKEN) { console.error("--publish needs --token (or TOKEN)"); process.exit(1); }
    const out = await (await call("PUT", `/v1/registry/b/${HANDLE}/roms/${p.id}`,
      { cart: gz.toString("base64"), title: p.name, blurb: (p.blurb || "").slice(0, 400) }, TOKEN)).json();
    console.log(`  published: ${out.kind} · ${out.cart_url}`);
  }
}
console.log(`${minted} cartridges in ${path.relative(ROOT, OUT)}/${PUBLISH ? ` and published under ${HANDLE}` : ""}`);
