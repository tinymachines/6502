// The floating console of a study view, shared by the schematic and the tracer.
//
// It is one draggable panel rather than clusters nailed to corners: on a screen
// whose whole content is one drawing, the controls are the only thing that can
// be in the way, and where they are in the way depends on the drawing. It is a
// vertical strip of icons with a drawer beside it. The strip is what remains
// when the drawer is shut, so what lives on it is what has to survive that:
// the drawers, the transport, and the way out. The drawer shows one panel at a
// time; pressing the icon that is already open shuts it, which is the only way
// back to a bench with nothing on it.
//
// This module owns the mechanics and none of the content. Which panels exist,
// what they build and what they paint are passed in; position, which drawer is
// open and which tab it shows are kept here and reported through `onChange`,
// so the page saves them under its own key beside whatever else it keeps (the
// schematic keeps its walk there too). It was `schematic.js`'s own until the
// tracer wanted the same console, and two copies of a drag handler would have
// drifted the way two copies of everything else here have.
//
// Markup it expects (classes are the shared `.solo-palette` rules in style.css):
//
//   <div class="solo-palette" id=...>
//     <div class="sp-strip">  grip, <button class="sp-icon" data-tab="...">,
//                             transport, exit </div>
//     <div class="sp-drawer">
//       <div class="sp-drawer-head"> <span class="sp-title"> ... <button collapse> </div>
//       <div class="sp-panel"></div>
//     </div>
//   </div>

/**
 * @param {object} o
 * @param {HTMLElement} o.palette   the `.solo-palette`
 * @param {HTMLElement} o.strip     the `.sp-strip`: the drag handle, buttons included
 * @param {HTMLElement} o.host      the `.sp-panel` a panel builds into
 * @param {HTMLElement} o.title     where the open drawer's name is written
 * @param {HTMLElement} o.collapse  the drawer's close button
 * @param {() => HTMLElement} o.stage  the element the console is clamped inside
 * @param {Record<string, (host: HTMLElement) => () => void>} o.panels
 *        builders, one per tab: build into `host`, return the per-frame painter
 * @param {Record<string, string>} o.names   tab -> drawer title
 * @param {string} o.tab            the tab to open first
 * @param {() => boolean} o.active  whether the study view is on (resize clamps only then)
 * @param {() => void} [o.onChange] after every change of position, drawer or tab
 */
export function createPalette({
  palette, strip, host, title, collapse, stage, panels, names, tab, active,
  onChange = () => {},
}) {
  const keys = Object.keys(panels);
  const st = {
    tab: panels[tab] ? tab : keys[0],
    drawer: true,
    pos: null,
    paint: null,     // the open panel's painter, or null
  };
  const stageRect = () => stage().getBoundingClientRect();

  /**
   * Which drawer is open. Rebuilt on switch, painted every frame.
   */
  function setTab(name) {
    st.tab = panels[name] ? name : keys[0];
    palette.dataset.open = st.tab;
    for (const b of strip.querySelectorAll('.sp-icon[data-tab]')) {
      const on = b.dataset.tab === st.tab && st.drawer;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    title.textContent = names[st.tab] || st.tab;
    host.replaceChildren();
    st.paint = panels[st.tab](host);
    st.paint();
    onChange();
  }

  /**
   * Publish the strip's height so a drawer can be capped to it.
   *
   * Measured rather than declared, for the same reason `site-nav.js` measures
   * the header: CSS has no way to say "no taller than my sibling", and the
   * strip is not a fixed height -- the schematic's Ports icon appears only once
   * a block is on the bench, which makes it taller *after* boot. Observing the
   * box is the only way to be right whenever that changes.
   */
  function measureStrip() {
    const h = strip.getBoundingClientRect().height;
    if (h > 0) palette.style.setProperty('--sp-strip-h', `${Math.round(h)}px`);
  }

  /** Open or shut the drawer, leaving the strip. */
  function setDrawer(on) {
    st.drawer = !!on;
    palette.dataset.drawer = st.drawer ? 'open' : 'shut';
    collapse.setAttribute('aria-expanded', st.drawer ? 'true' : 'false');
    setTab(st.tab);
    measureStrip();
    // Opening changes the panel's width and height, so where it is allowed to
    // be changes with it. Without this, opening a drawer near an edge puts half
    // of it outside the stage.
    if (st.pos) place(st.pos.x, st.pos.y);
  }

  /**
   * Put the console somewhere, and refuse to put it out of reach.
   *
   * The clamp is against the stage rather than the viewport, and it runs again
   * on resize and on collapse -- a panel dragged to the bottom of a tall window
   * and then reopened on a phone would otherwise be gone, with no way to get it
   * back short of clearing storage.
   */
  function place(x, y) {
    const sr = stageRect();
    const pr = palette.getBoundingClientRect();
    if (!pr.width || !pr.height) return;
    const nx = Math.min(Math.max(0, sr.width - pr.width), Math.max(0, x));
    const ny = Math.min(Math.max(0, sr.height - pr.height), Math.max(0, y));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    palette.style.left = `${nx}px`;
    palette.style.top = `${ny}px`;
    st.pos = { x: nx, y: ny };
    onChange();
  }

  const validPos = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

  /**
   * Take a saved configuration without painting anything. Used on the way into
   * the mode, before the page has rendered, so that the first paint already
   * shows the tab and drawer the reader left; painting here would be early,
   * because the console is not on screen yet.
   */
  function restore(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (panels[cfg.tab]) st.tab = cfg.tab;
    st.drawer = cfg.drawer !== false;
    if (validPos(cfg.pos)) st.pos = cfg.pos;
  }

  /** Entering the study view: open the console where it was left. */
  function open(cfg) {
    if (cfg && validPos(cfg.pos)) st.pos = cfg.pos;
    setDrawer(st.drawer);
    const pos = st.pos || (() => {
      const sr = stageRect();
      const pr = palette.getBoundingClientRect();
      return { x: 14, y: Math.max(0, sr.height - pr.height - 14) };
    })();
    place(pos.x, pos.y);
  }

  /** Paint the live half of whichever panel is open. */
  function refresh() {
    if (st.paint && st.drawer) st.paint();
  }

  // The strip is the handle, buttons included.
  //
  // It used to refuse a press that landed on a button, which made a 2.5rem-wide
  // panel hard to grab and had a worse consequence: the press still reached the
  // button, so a drag that started on the exit icon *left the study view on
  // release*. That is one of the two ways a reader loses their walk to a stray
  // gesture. Now anything on the strip drags, and a press that turned into a
  // drag has its click swallowed on the way back up.
  //
  // Move and release are watched on the window for the same reason the camera
  // does it: `setPointerCapture` retargets the click, and half these buttons are
  // the ones the reader means to press.
  let drag = null;
  let dragged = false;
  strip.addEventListener('pointerdown', (e) => {
    const r = palette.getBoundingClientRect();
    drag = {
      dx: e.clientX - r.left, dy: e.clientY - r.top,
      x: e.clientX, y: e.clientY,
      // A finger always moves a little, so the slop that separates a press from
      // a drag is larger for touch -- the same figures the camera uses.
      slop: e.pointerType === 'mouse' ? 4 : 12,
    };
    dragged = false;
    // Only claim the gesture when it did not start on a control: preventing the
    // default on a button would cost it focus and the press that goes with it.
    if (!e.target.closest('button')) e.preventDefault();
  });
  const move = (e) => {
    if (!drag) return;
    if (!dragged && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= drag.slop) return;
    if (!dragged) { dragged = true; palette.classList.add('dragging'); }
    const sr = stageRect();
    place(e.clientX - sr.left - drag.dx, e.clientY - sr.top - drag.dy);
  };
  const up = () => {
    if (!drag) return;
    drag = null;
    palette.classList.remove('dragging');
    // Let the click that follows this release be swallowed, then forget. A drag
    // that ends off a button produces no click at all, and a flag left latched
    // would eat the next real press instead of the one it was raised for.
    if (dragged) setTimeout(() => { dragged = false; }, 0);
  };
  // Capture, so it runs before the button's own handler rather than after it.
  strip.addEventListener('click', (e) => {
    if (!dragged) return;
    dragged = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('resize', () => {
    measureStrip();
    if (active() && st.pos) place(st.pos.x, st.pos.y);
  });
  // The strip can grow after boot (an icon revealed once something has loaded),
  // and measuring on open alone would cache the height it had before that.
  if (typeof ResizeObserver === 'function') new ResizeObserver(measureStrip).observe(strip);

  collapse.addEventListener('click', () => setDrawer(false));
  for (const b of strip.querySelectorAll('.sp-icon[data-tab]')) {
    b.addEventListener('click', () => {
      if (st.drawer && st.tab === b.dataset.tab) setDrawer(false);
      else { st.tab = b.dataset.tab; setDrawer(true); }
    });
  }

  return {
    setTab, setDrawer, place, open, restore, refresh, measureStrip,
    get tab() { return st.tab; },
    get drawer() { return st.drawer; },
    get pos() { return st.pos; },
    /** The part of the configuration that is the console's: what to save. */
    config() { return { pos: st.pos, drawer: st.drawer, tab: st.tab }; },
  };
}
