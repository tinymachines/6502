// Windows of a console's record: where a page finds one by name.
//
// A window (`windows/NAME.window`, the pin crate's text) is served beside
// the pages on the chip's own host. Under the roof (tinymachines.ai/6502/)
// the chip's pages are served from the same build, but its unhashed text
// assets are not aliased there (nginx aliases the hashed .bin/.json/.wasm
// only), so a relative fetch answers 404 and the window is fetched from
// the chip's host instead, which the roof's connect-src allows. One place
// for that rule, shared by the Halfshot and Trace pages.

const NAME = /^[A-Za-z0-9_.-]+$/;
const CHIP_HOST = 'https://6502.tinymachines.ai';

/** The window's text, or a thrown Error naming what could not be had. */
export async function fetchWindow(name) {
  if (!NAME.test(name)) throw new Error(`not a window name: ${name}`);
  const rel = `windows/${name}.window`;
  let r = await fetch(rel);
  if (r.status === 404 && location.origin !== CHIP_HOST) {
    r = await fetch(`${CHIP_HOST}/${rel}`);
  }
  if (!r.ok) throw new Error(`no window ${name} (${r.status})`);
  return r.text();
}
