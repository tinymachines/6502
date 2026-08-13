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
  };

  btn.addEventListener('click', () => {
    const open = head.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });

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
