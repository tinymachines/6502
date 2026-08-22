/* The index: everyone with a page, and what was published most recently. */
import { call, esc, ago, playUrl } from './registry.js';
import { drawArt } from './art.js';

const $ = (s) => document.querySelector(s);

function artCanvas(art, scale) {
  const c = document.createElement('canvas');
  c.className = 'art';
  return drawArt(c, art, scale) ? c : null;
}

function builderCard(b) {
  const el = document.createElement('div');
  el.className = 'card b-card';
  const art = artCanvas(b.avatar, 1);
  const left = art || Object.assign(document.createElement('div'), { className: 'b-none' });
  if (art) { art.style.width = '64px'; art.style.height = '64px'; }
  el.append(left);
  const right = document.createElement('div');
  right.innerHTML = `
    <h3><a href="/b/${esc(b.handle)}">${esc(b.name)}</a></h3>
    <div class="muted" style="font-size:10.5px">/b/${esc(b.handle)}</div>
    <p class="b-bio">${esc(b.bio) || '<span class="muted">no bio yet</span>'}</p>
    <div class="row" style="margin-top:7px">
      <span class="pill">${b.roms} ROM${b.roms === 1 ? '' : 's'}</span>
      <span class="pill">${esc(ago(b.updated))}</span>
    </div>`;
  el.append(right);
  return el;
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
  const body = document.createElement('div');
  body.innerHTML = `
    <h3>${esc(r.title)}</h3>
    <div class="muted" style="font-size:10.5px">by <a href="/b/${esc(r.handle)}">${esc(r.handle)}</a></div>
    <p class="note">${esc(r.blurb)}</p>
    <div class="row" style="margin-top:8px">
      <span class="pill">${r.rom_size} B</span>
      <span class="pill">${r.frame_cost ? r.frame_cost.toLocaleString() + ' hc/frame' : 'unmeasured'}</span>
    </div>
    <div class="row" style="margin-top:9px">
      <a class="btn go" href="${esc(playUrl(r.handle, r.slug))}">play</a>
      <a class="btn" href="${esc(r.cart_url)}">.cart.gz</a>
    </div>`;
  el.append(body);
  return el;
}

function empty(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

(async () => {
  try {
    const d = await call('');
    $('#builders-head').textContent =
      d.count === 1 ? '1 builder' : `${d.count} builders`;
    $('#latest-head').textContent =
      d.roms === 1 ? '1 ROM published' : `${d.roms} ROMs published`;
    const latest = $('#latest');
    const list = $('#builders');
    if (!d.latest.length) latest.replaceWith(empty('Nothing published yet.'));
    else d.latest.forEach((r) => latest.append(romCard(r)));
    if (!d.builders.length) list.replaceWith(empty('No pages yet. Yours could be the first.'));
    else d.builders.forEach((b) => list.append(builderCard(b)));
  } catch (e) {
    $('#err').hidden = false;
    $('#err').textContent = `could not load the registry: ${e.message}`;
  }
})();
