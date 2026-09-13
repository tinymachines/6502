// Windows of a console's record: where a page finds one by name.
//
// A window (`windows/NAME.window`, the pin crate's text) is served beside
// the pages on the chip's own host. Under the roof (tinymachines.ai/6502/)
// the chip's pages are served from the same build, but its unhashed text
// assets are not aliased there (nginx aliases the hashed .bin/.json/.wasm
// only), so a relative fetch answers 404; the roof also aliases the whole
// build under <base>/chip/, same origin, which is where the window is
// fetched from then, with the chip's own host as the last resort (a
// cross-origin fetch the roof's connect-src allows but the chip's host
// does not yet answer with CORS headers). One place for that rule,
// shared by the Halfshot and Trace pages.

const NAME = /^[A-Za-z0-9_.-]+$/;
const CHIP_HOST = 'https://6502.tinymachines.ai';

/** A file beside the windows, by the same rule: the Response, or a thrown Error. */
async function fetchBeside(file) {
  const rel = `windows/${file}`;
  let r = await fetch(rel);
  if (r.status === 404 && location.origin !== CHIP_HOST) {
    // The roof aliases the chip's whole build under <base>/chip/ (same
    // origin, so no CORS to arrange); the chip's host is the last resort.
    const base = location.pathname.replace(/\/[^/]*$/, '');
    r = await fetch(`${base}/chip/${rel}`);
    if (r.status === 404) r = await fetch(`${CHIP_HOST}/${rel}`);
  }
  if (!r.ok) throw new Error(`no ${file} beside the windows (${r.status})`);
  return r;
}

/** The window's text, or a thrown Error naming what could not be had. */
export async function fetchWindow(name) {
  if (!NAME.test(name)) throw new Error(`not a window name: ${name}`);
  return (await fetchBeside(`${name}.window`)).text();
}

/** A picture the window names (`# picture - <frame> <file>`), as bytes. */
export async function fetchWindowAsset(file) {
  if (!NAME.test(file)) throw new Error(`not a window asset name: ${file}`);
  return new Uint8Array(await (await fetchBeside(file)).arrayBuffer());
}
