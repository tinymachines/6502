// Version footer: what is actually running, and how long it has been running.
//
// Rendered on the client rather than baked into the HTML, for one reason: the
// elapsed time has to stay true. "3m ago" written into a static page is wrong
// within the hour and quietly misleading after that, and this site is served
// from immutable, long-cached files precisely so pages are not regenerated.
// Only the timestamps are baked; the arithmetic happens on each load.
//
// build-info.json is resolved relative to THIS module's URL, not to the page's.
// The archive nests pages two deep (/archive/wiki/foo.html) and publishes its
// own build-info.json, so a page-relative path would need a different value per
// depth and per section. import.meta.url makes the script self-locating: drop it
// beside a build-info.json and it finds it.
//
// No inline script anywhere: the CSP is script-src 'self' with no
// 'unsafe-inline', which is a deliberate part of the site's security posture and
// not something to weaken for a footer.

const INFO = new URL('build-info.json', import.meta.url);

/** Compact relative time. Deliberately coarse -- this answers "did it ship?". */
function since(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 0) return 'just now';           // clock skew between build and viewer
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function render(host, info) {
  const short = (info.commit || '').slice(0, 7);
  host.textContent = '';

  const link = document.createElement('a');
  link.className = 'vf-rev';
  link.href = info.commitFull
    ? `${info.repo}/commit/${info.commitFull}`
    : info.repo;
  link.rel = 'noopener';
  link.title = [info.subject, info.branch && `on ${info.branch}`,
                info.committed && `committed ${info.committed}`]
    .filter(Boolean).join('\n');

  const pill = document.createElement('span');
  pill.className = 'vf-pill';
  pill.textContent = info.version + (info.dirty ? '+' : '');
  link.append(pill);

  if (short) {
    const hash = document.createElement('span');
    hash.className = 'vf-hash';
    hash.textContent = `@${short}`;
    link.append(hash);
  }

  const built = document.createElement('span');
  built.className = 'vf-built';
  const tick = () => {
    built.textContent = `deployed ${since(info.built)}`;
    built.title = info.built;
  };
  tick();
  // A page left open should not keep claiming it was deployed a minute ago.
  setInterval(tick, 30_000);

  host.append(link, built);

  // What changed since the previous deploy, as the same list the menu dots.
  // Three states, and the difference between the last two is the point:
  //   pages changed   -> named, linking to the diff between the two commits
  //   nothing changed -> said, since a footer that goes quiet is ambiguous
  //   no previous     -> nothing at all: an empty list with no anchor is not
  //                      "nothing changed", it is "nothing to compare against"
  // Only the simulator's stamp carries these fields; the archive's does not,
  // and this file is shared, so their absence is a normal state and not an
  // error.
  if (Array.isArray(info.changed) && info.previousDeploy) {
    const changed = document.createElement('span');
    changed.className = 'vf-changed';
    if (info.changed.length) {
      const names = info.changed.map((p) => (p === '' ? 'explorer' : p));
      const shown = names.slice(0, 3).join(', ') + (names.length > 3
        ? ` and ${names.length - 3} more` : '');
      const a = document.createElement('a');
      a.href = `${info.repo}/compare/${info.previousDeploy.slice(0, 12)}...${
        (info.commitFull || '').slice(0, 12)}`;
      a.rel = 'noopener';
      a.title = `Changed since the previous deploy: ${names.join(', ')}. `
        + 'Opens the diff between the two commits.';
      a.textContent = `changed: ${shown}`;
      changed.append(a);
    } else {
      changed.textContent = 'no page changed';
      changed.title = 'Nothing a reader would see changed since the previous '
        + 'deploy: this build touched only shared code, tools or data.';
    }
    host.append(changed);
  }
}

async function init() {
  const hosts = document.querySelectorAll('[data-version-footer]');
  if (!hosts.length) return;
  try {
    const res = await fetch(INFO, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const info = await res.json();
    hosts.forEach((h) => render(h, info));
  } catch {
    // A missing or unreadable build-info is not worth a visible error: the
    // footer simply stays empty rather than announcing its own plumbing.
  }
}

init();
