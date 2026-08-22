// The site menu: one list, grouped, rendered into every page's header.
//
// It was ten hand-copied lists before this, and they had already drifted three
// ways: the index carried "What you see", "Verification" and "Credit", most
// pages carried "Credit" alone, the blueprint carried two of the three, and
// timing.html had quietly lost "Credit" altogether. Nobody noticed, because a
// nav that is missing one link still looks like a nav. Same reasoning as
// version-footer.js and block-palette.js: a second copy is a copy that will
// disagree.
//
// The order is a reading order rather than a sitemap. A reader arriving here
// does not know what a decode PLA is, so the first group is where to start, the
// middle groups are the chip drawn four ways and then followed one instruction
// at a time, and the measured tables come after the things that explain them.
//
// Each entry carries one line of what it is. That is the part a bare list of
// nouns cannot do: "Blueprint" and "Schematic" and "Exploded" are three
// drawings of the same silicon, and the difference between them is the only
// thing worth knowing when choosing between them.

import { setupNavMenu } from './site-nav.js';

/**
 * `page` is the document the entry lives on, `hash` the section within it.
 * `marks` is false for a section that should not claim to *be* the page it
 * sits on -- the index has five of them, and marking all five current would
 * say the reader is in five places at once.
 */
export const MENU = [
  {
    title: 'Start here',
    items: [
      { label: 'Primer', page: 'primer',
        hint: 'the mental model, corrected one step at a time' },
      { label: 'Explorer', page: '', hash: 'explorer',
        hint: 'the die itself, lit by what it is doing' },
      { label: 'Programs', page: 'programs',
        hint: 'seven programs, assembled in the page' },
      { label: 'Halfshot', page: 'halfshot',
        hint: 'the chosen program, one frame per half-cycle' },
    ],
  },
  {
    title: 'The chip, drawn',
    items: [
      { label: 'Exploded', page: 'exploded',
        hint: 'three mask layers and twelve blocks, pulled apart' },
      { label: 'Blocks', page: 'block',
        hint: 'one functional block at a time, and what crosses its edge' },
      { label: 'Schematic', page: 'schematic',
        hint: '1160 gates recognised from the switch network' },
      { label: 'Blueprint', page: 'blueprint',
        hint: 'the datapath as a block diagram, derived' },
      { label: 'Chip map', page: 'chipmap',
        hint: 'the whole chip as one schematic, a box per derived container' },
    ],
  },
  // Its own group rather than an entry under "The chip, drawn", because these
  // are drawings somebody else made and this site checks. The derived ones sit
  // above; reading the two together is the point, and the grouping says so.
  {
    title: 'Block diagram',
    items: [
      { label: 'The published figure', page: 'blockdiagram',
        hint: 'the datasheet diagram as a dataset, resolved against the die' },
      { label: 'The graph', page: 'diegraph',
        hint: 'every node at its own place on the die, and every edge' },
      { label: 'The pinout', page: 'pinout',
        hint: 'forty pins, with each direction measured rather than copied' },
    ],
  },
  {
    title: 'One instruction at a time',
    items: [
      { label: 'Lab', page: '', hash: 'lab', marks: false,
        hint: 'four instructions, opcode to register' },
      { label: 'Trace', page: 'trace',
        hint: 'any of the 256 opcodes, half-cycle by half-cycle' },
      { label: 'Tracer', page: 'tracer',
        hint: 'the whole circuit lit beside the code, half-cycle by half-cycle' },
    ],
  },
  {
    title: 'Measured tables',
    items: [
      { label: 'Decode', page: 'decode',
        hint: 'all 122 PLA terms, and what fires each' },
      { label: 'Timing', page: 'timing',
        hint: 'every instruction, timed sync to sync' },
    ],
  },
  // Things to build against rather than things to read, which is why they are
  // their own group and not entries under About. Both are `off`: deployed
  // beside this tree rather than inside it, so they are 404s against the dev
  // server and real pages in production.
  {
    title: 'Developers',
    items: [
      { label: 'API', href: 'api/', off: true,
        hint: 'the chip over HTTP, one half-cycle at a time, stateless' },
      { label: 'Halfwave Lab', href: 'https://halfwave.tinymachines.ai', off: true,
        hint: 'the API driven as an app: fourteen readings of one half-cycle' },
    ],
  },
  {
    title: 'About',
    items: [
      { label: 'What you see', page: '', hash: 'looking-at', marks: false,
        hint: 'what the die view is actually showing' },
      { label: 'Verification', page: '', hash: 'verification', marks: false,
        hint: 'two oracles, either alone insufficient' },
      { label: 'The talk', page: 'talk',
        hint: 'how the die was opened and traced, re-checked here' },
      { label: 'The designer', page: 'designer',
        hint: 'what one of its authors recalls, asked of the silicon' },
      { label: 'Credit', page: '', hash: 'credit', marks: false,
        hint: 'who traced the die, and the licence' },
      { label: 'Archive', href: 'archive/', off: true,
        hint: 'visual6502.org, preserved' },
    ],
  },
];

/** The document this page is, as the menu names it: '' for the index. */
function currentPage() {
  const path = location.pathname;
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (file === '' || file === 'index.html') return '';
  return file.replace(/\.html$/, '');
}

/**
 * Where an entry points from where we are now.
 *
 * A section on the index is `#explorer` when we are already on the index and
 * `./#explorer` when we are not. Getting that wrong is the difference between
 * scrolling and reloading, and it is exactly the sort of thing that was being
 * hand-maintained in ten files.
 */
function hrefFor(item, here) {
  if (item.href) return item.href;
  const page = item.page || '';
  // Already here. A section scrolls to itself; a whole page goes to its top --
  // `./` would be right on every page except the ones it is wrong on, because
  // from /primer it means the index rather than the primer. Every page carries
  // `<main id="top">`, which is what the wordmark already links to.
  if (page === here) return item.hash ? `#${item.hash}` : '#top';
  const base = page === '' ? './' : page;
  return item.hash ? `${base}#${item.hash}` : base;
}

export function renderMenu(root = document) {
  const hosts = [...root.querySelectorAll('.navlinks')];
  if (!hosts.length) return;
  const here = currentPage();

  for (const host of hosts) {
    host.replaceChildren();
    for (const group of MENU) {
      const sec = document.createElement('div');
      sec.className = 'navgroup';

      const h = document.createElement('p');
      h.className = 'navgroup-title';
      h.textContent = group.title;
      sec.append(h);

      for (const item of group.items) {
        const a = document.createElement('a');
        a.href = hrefFor(item, here);
        if (/^https?:/.test(item.href || '')) a.rel = 'noopener';
        if (item.marks !== false && (item.page ?? null) === here && !item.href) {
          a.setAttribute('aria-current', 'page');
        }
        const label = document.createElement('span');
        label.className = 'navlink-label';
        label.textContent = item.label;
        // Marked once the dates are known: see markRecent(). The page name is
        // carried on the link so the dot can find its entry without a second
        // copy of the list.
        if (item.page !== undefined && !item.href) a.dataset.page = item.page;
        // Deployed beside this tree rather than inside it: the archive is
        // ~2.5 GB served from an alias, /api/ is a proxy to uvicorn, and the
        // Lab is its own property. Marked here so the harness skips fetching
        // them by a rule in the data rather than by a list of its own, and can
        // assert that the set is exactly what is declared.
        if (item.off) a.dataset.off = '1';
        const hint = document.createElement('span');
        hint.className = 'navlink-hint';
        hint.textContent = item.hint;
        a.append(label, hint);
        sec.append(a);
      }
      host.append(sec);
    }
  }
  // Idempotent, and the click handler is delegated to the container, so it does
  // not matter that the links did not exist when it was attached.
  setupNavMenu(root);
}

/**
 * A dot on the entries whose page changed since the previous deploy.
 *
 * "Recently updated" is measured, and measured RELATIVE to what a returning
 * reader could last have seen: tools/build-info.py asks git which pages' own
 * files changed between the commit that was live and the one being deployed,
 * and stamps the list into build-info.json. Nothing here decides which pages
 * are new, so the dots cannot go stale the way a hand-kept list would, and a
 * new page cannot be forgotten.
 *
 * Not a fixed number of days, deliberately. That was tried and measured: on a
 * site two weeks old, every window either dots nothing useful or dots every
 * entry at once, and a constant chosen against today's history is wrong again
 * a month later. "Since the last deploy" adjusts itself as the site ages.
 *
 * Fetched the way the footer fetches it, relative to this module rather than to
 * the page, because the archive carries this file too and nests its pages two
 * deep. Failure to load leaves the menu exactly as it was: the dots are a
 * courtesy, not a load-bearing part of navigation.
 */
async function markRecent(root = document) {
  let info;
  try {
    const r = await fetch(new URL('build-info.json', import.meta.url), { cache: 'no-cache' });
    if (!r.ok) return;
    info = await r.json();
  } catch {
    return;
  }
  const changed = new Set(info && Array.isArray(info.changed) ? info.changed : []);
  if (!changed.size) return;
  for (const a of root.querySelectorAll('.navlinks a[data-page]')) {
    if (!changed.has(a.dataset.page)) continue;
    a.classList.add('recent');
    // The dot is the mark; this is what it means, for a pointer and a reader.
    a.title = 'changed since the last deploy';
    const label = a.querySelector('.navlink-label');
    if (label && !label.querySelector('.navlink-dot')) {
      const dot = document.createElement('i');
      dot.className = 'navlink-dot';
      dot.setAttribute('aria-hidden', 'true');
      label.append(dot);
      const sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = ' (changed since the last deploy)';
      label.append(sr);
    }
  }
}

renderMenu();
markRecent();
