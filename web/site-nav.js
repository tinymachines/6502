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

/** Where this whole thing lives. Public, MIT code over CC BY-NC-SA data. */
const REPO = 'https://github.com/tinymachines/6502';

/**
 * The source link, inserted next to the menu button on every header.
 *
 * Injected rather than written into the markup, and that is a deliberate
 * departure from how the rest of the header works. The wordmark, the control
 * slots and the menu button are hand-copied into eleven documents plus
 * `archive/tools/shell.py`, which is exactly the arrangement that had already
 * let ten copies of the nav list drift three ways before `site-menu.js` existed.
 * Adding a twelfth hand-copied element would be repeating that on purpose. One
 * copy here reaches every page, and the archive gets it for free because
 * `build-archive.py` copies this file verbatim.
 *
 * The icon is inline because the CSP allows no external resources at all, and
 * an <img> would be one more request for a 20-line path.
 */
/**
 * Two repositories, because there are two. The simulator is this site; halfphi
 * is the switch-level engine underneath it, published on its own because it is
 * about switch networks rather than about a 6502 -- and because it embeds no
 * die data, which is what lets it be MIT while everything here carries the
 * CC BY-NC-SA obligations. A reader who wants the engine should not have to
 * learn that from a paragraph three pages in.
 *
 * The second link carries its name, because two identical octocats side by
 * side is a choice with no answer. It is hidden below 34rem, where the header
 * is down to the wordmark, the controls and the menu button; the Developers
 * group in the menu carries it at every width.
 */
const SOURCES = [
  { href: REPO, title: 'Source on GitHub' },
  { href: 'https://github.com/tinymachines/halfphi', label: 'halfphi',
    title: 'halfphi, the switch-level engine, on GitHub' },
];

function ghMark() {
  const a = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  a.setAttribute('viewBox', '0 0 16 16');
  a.setAttribute('aria-hidden', 'true');
  a.setAttribute('focusable', 'false');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38'
    + ' 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53'
    + '.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95'
    + ' 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27'
    + 'c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95'
    + '.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z');
  a.appendChild(p);
  return a;
}

function addSourceLink(head) {
  const nav = head.querySelector('nav');
  const btn = head.querySelector('.menu-btn');
  if (!nav || !btn || nav.querySelector('.gh-link')) return;

  for (const src of SOURCES) {
    const link = document.createElement('a');
    link.className = 'gh-link' + (src.label ? ' gh-lib' : '');
    link.href = src.href;
    link.rel = 'noreferrer';
    // Both, and they are not redundant: the title is the pointer affordance and
    // the label is what a screen reader reads, since the icon carries no text.
    link.title = src.title;
    link.setAttribute('aria-label', src.title);
    link.appendChild(ghMark());
    if (src.label) {
      const t = document.createElement('span');
      t.textContent = src.label;
      link.appendChild(t);
    }
    nav.insertBefore(link, btn);
  }
}

function wire(head) {
  const btn = head.querySelector('.menu-btn');
  const nav = head.querySelector('.navlinks');
  if (!btn || !nav) return;
  addSourceLink(head);

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
