// The site header's disclosure menu, shared by the simulator and the archive.
//
// This lives in its own module rather than inside app.js because the two
// deployments genuinely share the header: the archive is static HTML with no
// simulator to boot, and a second copy of these fifteen lines would drift the
// first time either side changed. Same reasoning as version-footer.js.
//
// It must be a file rather than an inline handler: the CSP is `script-src
// 'self'` with no 'unsafe-inline'.

const wired = new WeakSet();

function wire(head) {
  const btn = head.querySelector('.menu-btn');
  const nav = head.querySelector('.navlinks');
  if (!btn || !nav) return;

  const close = () => {
    head.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    nav.style.maxHeight = '';
  };

  /**
   * How much room the panel actually has, measured rather than assumed.
   *
   * The panel hangs from the bottom of a sticky header, so the space below it
   * is the viewport minus that header -- and the header is not a fixed height:
   * on a phone it wraps its controls onto a second row. A CSS `calc(100vh -
   * 4.25rem)` was right on a desktop and left the last group 38px past the
   * bottom of a 320px screen, with no way to reach it.
   */
  const fit = () => {
    if (!head.classList.contains('open')) return;
    const room = window.innerHeight - head.getBoundingClientRect().bottom;
    nav.style.maxHeight = `${Math.max(room, 120)}px`;
  };

  btn.addEventListener('click', () => {
    const open = head.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
    if (open) fit(); else nav.style.maxHeight = '';
  });

  window.addEventListener('resize', fit);

  // The header is not a fixed height and does not settle at once: the program
  // picker and the transport are filled in after the wasm has loaded, and on a
  // phone that turns a one-row header into a two-row one. Measuring only on
  // open cached a 70px header and left the panel 38px past the bottom of the
  // screen. Watching the box is the only way to be right whenever it changes.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(fit).observe(head);
  }

  // Any navigation dismisses it; so does Escape and a click outside.
  nav.addEventListener('click', (e) => { if (e.target.tagName === 'A') close(); });
  document.addEventListener('click', (e) => { if (!head.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

/** Idempotent: safe to call again after inserting a header. */
export function setupNavMenu(root = document) {
  for (const head of root.querySelectorAll('.site-head')) {
    if (wired.has(head)) continue;
    wired.add(head);
    wire(head);
  }
}

// Module scripts are deferred, so the document is parsed by the time this runs.
// The simulator's header is in the markup from the start -- it is only hidden
// behind #app -- so there is nothing to wait for on either site.
setupNavMenu();
