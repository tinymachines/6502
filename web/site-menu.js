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
    ],
  },
  {
    title: 'One instruction at a time',
    items: [
      { label: 'Lab', page: '', hash: 'lab', marks: false,
        hint: 'four instructions, opcode to register' },
      { label: 'Trace', page: 'trace',
        hint: 'any of the 256 opcodes, half-cycle by half-cycle' },
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
  {
    title: 'About',
    items: [
      { label: 'What you see', page: '', hash: 'looking-at', marks: false,
        hint: 'what the die view is actually showing' },
      { label: 'Verification', page: '', hash: 'verification', marks: false,
        hint: 'two oracles, either alone insufficient' },
      { label: 'The talk', page: 'talk',
        hint: 'how the die was opened and traced, re-checked here' },
      { label: 'Credit', page: '', hash: 'credit', marks: false,
        hint: 'who traced the die, and the licence' },
      { label: 'Archive', href: 'archive/',
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
        if (item.marks !== false && (item.page ?? null) === here && !item.href) {
          a.setAttribute('aria-current', 'page');
        }
        const label = document.createElement('span');
        label.className = 'navlink-label';
        label.textContent = item.label;
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

renderMenu();
