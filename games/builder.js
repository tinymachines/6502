/* One builder's page. The handle comes out of the PATH, because nginx serves
 * this same document for every /b/<handle> and the path is the only thing that
 * says which builder it is. */
import { call, esc, ago, playUrl, fromPath } from './registry.js';
import { drawArt } from './art.js';

const $ = (s) => document.querySelector(s);

function artCanvas(art, scale) {
  const c = document.createElement('canvas');
  c.className = 'art';
  return drawArt(c, art, scale) ? c : null;
}

function romCard(r) {
  const el = document.createElement('div');
  el.className = 'card r-card';
  const cover = document.createElement('div');
  cover.className = 'r-cover';
  const art = artCanvas(r.cover, 2);
  cover.append(art || Object.assign(document.createElement('span'),
    { className: 'muted', textContent: 'no cover art' }));
  el.append(cover);
  const m = r.measured || {};
  const body = document.createElement('div');
  // Every number here was measured by the registry on the chip when this was
  // published, not declared by whoever published it.
  body.innerHTML = `
    <h3>${esc(r.title)}</h3>
    <p class="note">${esc(r.blurb)}</p>
    <div class="kv" style="margin-top:9px">
      <span>ROM</span><b>${r.rom_size} B</b>
      <span>tiles</span><b>${r.tiles}</b>
      <span>a frame</span><b>${r.frame_cost ? r.frame_cost.toLocaleString() : '--'}</b>
      <span>frames run</span><b>${m.frames_completed ?? '--'}</b>
      <span>published</span><b>${esc(ago(r.updated))}</b>
    </div>
    <div class="row" style="margin-top:11px">
      <a class="btn go" href="${esc(playUrl(r.handle, r.slug))}">play it</a>
      <a class="btn" href="${esc(r.cart_url)}">.cart.gz</a>
    </div>
    <p class="note" style="margin-top:8px">Half-cycles a frame, measured here
      when it was published. Nothing about that number is the author's to set.</p>`;
  el.append(body);
  return el;
}

(async () => {
  const { handle } = fromPath();
  if (!handle) {
    location.replace('/builders');
    return;
  }
  try {
    const b = await call(`/b/${encodeURIComponent(handle)}`);
    document.title = `${b.name} · games.tinymachines.ai`;
    $('#name').textContent = b.name;
    $('#handle').textContent = `/b/${b.handle}`;
    $('#bio').textContent = b.bio || '';
    $('#bio').hidden = !b.bio;
    const art = artCanvas(b.avatar, 2);
    if (art) { art.style.width = '128px'; art.style.height = '128px'; }
    $('#avatar').append(art
      || Object.assign(document.createElement('div'), { className: 'p-none' }));
    for (const l of b.links) {
      const a = document.createElement('a');
      a.className = 'btn';
      a.href = l.url;
      a.textContent = l.label;
      // Links go to somebody else's site: never hand them this page's opener,
      // and never leak the path they were clicked from.
      a.rel = 'noopener noreferrer nofollow';
      a.target = '_blank';
      $('#links').append(a);
    }
    $('#profile').hidden = false;
    $('#roms-head').textContent = b.roms.length === 1
      ? '1 ROM' : `${b.roms.length} ROMs`;
    if (!b.roms.length) {
      $('#roms').replaceWith(Object.assign(document.createElement('p'),
        { className: 'empty', textContent: 'Nothing published yet.' }));
    } else {
      b.roms.forEach((r) => $('#roms').append(romCard(r)));
    }
  } catch (e) {
    $('#err').hidden = false;
    $('#err').textContent = e.status === 404
      ? `There is no builder called "${handle}".`
      : `could not load that page: ${e.message}`;
  }
})();
