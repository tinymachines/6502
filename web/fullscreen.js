// Fullscreen, including on the platforms that do not have it.
//
// iOS Safari implements the Fullscreen API for video elements only, so
// `requestFullscreen` on a div is simply absent on an iPhone. Both paths here
// set `.immersive`; only the fallback adds `.faux`, and the CSS keys on those
// classes rather than on `:fullscreen` -- an unknown pseudo-class invalidates
// the whole selector list, so `.thing:fullscreen, .thing.immersive { ... }`
// would silently drop everything on a browser that does not know it.
//
// `app.js` still carries its own copy, because the explorer's version is
// entangled with the panel drawer it has to open and shut. If a third page ever
// needs this, that is the moment to unify them rather than grow a third.

/**
 * @param {HTMLElement} target  the element to fill the viewport with
 * @param {HTMLElement} btn     the button that toggles it
 * @param {() => void} [onChange] called after every state change
 */
export function setupFullscreen(target, btn, onChange = () => {}) {
  const nativeEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  const request = () => target.requestFullscreen || target.webkitRequestFullscreen;
  const exit = () => document.exitFullscreen || document.webkitExitFullscreen;

  const paint = () => {
    const on = target.classList.contains('immersive');
    btn.textContent = on ? '⤡' : '⛶';
    btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
    onChange();
  };

  const setFaux = (on) => {
    target.classList.toggle('immersive', on);
    target.classList.toggle('faux', on);
    document.body.classList.toggle('no-scroll', on);
    paint();
  };

  // Every path that can commit a state change carries the generation it started
  // in, and abandons if a later one has begun. This handler awaits, and anything
  // decided before an await has to be rechecked after it: `requestFullscreen`
  // can take a long time to be refused when there is no user activation, and the
  // fallback would otherwise land after the reader had already given up and
  // pressed Escape, putting them into a fullscreen they just cancelled.
  let generation = 0;

  btn.onclick = async () => {
    const mine = ++generation;
    if (target.classList.contains('faux')) { setFaux(false); return; }
    if (nativeEl()) {
      const off = exit();
      if (off) { try { await off.call(document); } catch { /* leave the class alone */ } }
      return;
    }
    const on = request();
    if (on) {
      // webkitRequestFullscreen returns undefined rather than a promise, so a
      // resolved await proves nothing. Check whether it actually took.
      try { await on.call(target, { navigationUI: 'hide' }); } catch { /* fall through */ }
      await new Promise((r) => setTimeout(r, 120));
      if (mine !== generation || nativeEl()) return;
    }
    if (mine !== generation) return;
    setFaux(true);
  };

  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
      target.classList.toggle('immersive', !!nativeEl());
      paint();
    });
  }

  // Real fullscreen exits itself on Escape; the fallback has to be told. Escape
  // also bumps the generation, so a request still in flight cannot land after it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    generation++;
    if (target.classList.contains('faux')) setFaux(false);
  });

  paint();
}
