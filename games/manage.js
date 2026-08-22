/* The editor: a token, a page, and the ROMs on it.
 * ===========================================================================
 * Two things here are deliberate and easy to get wrong.
 *
 * A save sends only the fields the person touched. The API patches what it is
 * given, so sending `avatar: null` because no new image was chosen would blank
 * a photo somebody uploaded last week. The pending art is held apart from the
 * loaded page for exactly that reason.
 *
 * An image is converted in this browser and never uploaded. What goes up is a
 * grid of '0'..'3', so nothing on the far side has to parse a picture.
 */
import { call, token, esc, ago, toBase64, playUrl, fromPath } from './registry.js';
import { tilesFromFile, drawTiles, drawArt } from './art.js';

const $ = (s) => document.querySelector(s);
const AVATAR = { w: 8, h: 8 };
const COVER = { w: 16, h: 12 };

const state = {
  me: null,
  avatar: null,      // tiles, only when a new image was chosen this session
  cover: null,
  cart: null,        // {name, bytes}
};

function say(el, msg, bad) {
  const err = $(`#${el}-err`), ok = $(`#${el}-ok`);
  if (err) { err.hidden = !(bad && msg); err.textContent = bad ? msg : ''; }
  if (ok) { ok.hidden = !(!bad && msg); ok.textContent = bad ? '' : (msg || ''); }
}

/* -- the token ----------------------------------------------------------- */

async function load() {
  say('tok', '');
  try {
    const me = await call('/me', { auth: true });
    state.me = me;
    $('#token').value = '';
    $('#signout').hidden = false;
    say('tok', me.claimed
      ? `signed in as ${me.handle}`
      : 'that token works, and has not claimed a handle yet');
    $('#claim').hidden = !!me.claimed;
    $('#editor').hidden = !me.claimed;
    if (me.claimed) fill(me.builder);
  } catch (e) {
    state.me = null;
    $('#claim').hidden = true;
    $('#editor').hidden = true;
    $('#signout').hidden = !token.get();
    if (token.get()) say('tok', e.message, true);
  }
}

$('#signin').onclick = () => {
  const t = $('#token').value.trim();
  if (!t) { say('tok', 'paste a token first', true); return; }
  token.set(t);
  load();
};
$('#signout').onclick = () => {
  token.set('');
  location.reload();
};

/* -- claiming ------------------------------------------------------------ */

$('#c-handle').oninput = () => {
  const h = $('#c-handle').value.trim().toLowerCase();
  $('#c-preview').textContent = `/b/${h || '...'}`;
};
$('#c-go').onclick = async () => {
  say('c', '');
  try {
    await call('/claim', {
      method: 'POST',
      auth: true,
      body: { handle: $('#c-handle').value.trim().toLowerCase(),
              name: $('#c-name').value.trim() },
    });
    load();
  } catch (e) { say('c', e.message, true); }
};

/* -- the profile --------------------------------------------------------- */

function fill(b) {
  $('#p-name').value = b.name;
  $('#p-bio').value = b.bio;
  $('#p-links').value = b.links.map((l) => `${l.label} ${l.url}`).join('\n');
  $('#p-link').innerHTML = ` <a href="${esc(playUrl(b.handle, '').slice(0, -1))}">/b/${esc(b.handle)}</a>`;
  state.avatar = null;
  if (!drawArt($('#p-art'), b.avatar, 2)) {
    // No photo yet: leave the canvas as the empty box it already is rather
    // than drawing a placeholder that could be mistaken for saved art.
    const c = $('#p-art');
    c.width = 64; c.height = 64;
    c.getContext('2d').clearRect(0, 0, 64, 64);
  }
  $('#r-preview').textContent = `/b/${b.handle}/...`;
  renderMine(b.roms);
}

async function pickArt(file, box, canvas, ditherEl, slot, label) {
  try {
    const tiles = await tilesFromFile(file, box.w, box.h,
                                      { dither: ditherEl.checked });
    state[slot] = tiles;
    drawTiles(canvas, tiles, box.w, box.h, canvas === $('#p-art') ? 2 : 2);
    say(label, '');
  } catch (e) {
    say(label, `could not read that image: ${e.message}`, true);
  }
}

$('#p-file').onchange = (e) => {
  const f = e.target.files[0];
  if (f) pickArt(f, AVATAR, $('#p-art'), $('#p-dither'), 'avatar', 'p');
  e.target.value = '';
};
$('#p-dither').onchange = () => {
  // Re-converting needs the file again, and the input was cleared on purpose
  // so that choosing the same file twice still fires. Say so rather than
  // silently doing nothing.
  if (state.avatar) say('p', 'choose the image again to apply that', true);
};

function parseLinks(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf(' ');
    if (at < 0) return { label: line, url: line };
    return { label: line.slice(0, at).trim(), url: line.slice(at + 1).trim() };
  });
}

$('#p-save').onclick = async () => {
  say('p', '');
  const body = {
    name: $('#p-name').value.trim(),
    bio: $('#p-bio').value,
    links: parseLinks($('#p-links').value),
  };
  // Only when a new image was chosen. Sending it every time would mean a
  // client that failed to load the old art could erase it by saving a bio.
  if (state.avatar) body.avatar = { ...AVATAR, pixels: state.avatar };
  try {
    const b = await call(`/b/${state.me.handle}`, { method: 'PATCH', auth: true, body });
    state.me.builder = b;
    fill(b);
    say('p', 'saved');
  } catch (e) { say('p', e.message, true); }
};

/* -- publishing ---------------------------------------------------------- */

$('#r-cart').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.cart = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  $('#r-cart-name').textContent = `${f.name} (${state.cart.bytes.length} B)`;
  if (!$('#r-slug').value) {
    $('#r-slug').value = f.name.replace(/\.cart\.gz$|\.gz$/, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    $('#r-slug').oninput();
  }
  e.target.value = '';
};
$('#r-slug').oninput = () => {
  const s = $('#r-slug').value.trim().toLowerCase();
  $('#r-preview').textContent = `/b/${state.me ? state.me.handle : '...'}/${s || '...'}`;
};
$('#r-file').onchange = (e) => {
  const f = e.target.files[0];
  if (f) pickArt(f, COVER, $('#r-art'), $('#r-dither'), 'cover', 'r');
  e.target.value = '';
};

$('#r-go').onclick = async () => {
  say('r', '');
  const slug = $('#r-slug').value.trim().toLowerCase();
  if (!state.cart) { say('r', 'choose a .cart.gz first', true); return; }
  if (!slug) { say('r', 'give it a slug: that is its URL', true); return; }
  const body = { cart: toBase64(state.cart.bytes) };
  const title = $('#r-title').value.trim();
  const blurb = $('#r-blurb').value.trim();
  if (title) body.title = title;
  if (blurb) body.blurb = blurb;
  if (state.cover) body.cover = { ...COVER, pixels: state.cover };
  const btn = $('#r-go');
  btn.disabled = true;
  btn.textContent = 'running it on the chip...';
  try {
    const r = await call(`/b/${state.me.handle}/roms/${slug}`,
                         { method: 'PUT', auth: true, body });
    say('r', `published: ${r.title}, ${r.rom_size} bytes, `
           + `${r.frame_cost ? r.frame_cost.toLocaleString() : '?'} half-cycles a frame `
           + `measured over ${r.measured.frames_completed} frames.`);
    state.cart = null;
    state.cover = null;
    $('#r-cart-name').textContent = 'nothing chosen';
    const b = await call(`/b/${state.me.handle}`);
    state.me.builder = b;
    renderMine(b.roms);
  } catch (e) {
    say('r', e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'publish';
  }
};

/* -- what is already up -------------------------------------------------- */

function renderMine(roms) {
  const box = $('#mine');
  box.replaceChildren();
  $('#mine-head').textContent = roms.length === 1 ? '1 ROM' : `${roms.length} ROMs`;
  if (!roms.length) {
    box.append(Object.assign(document.createElement('p'),
      { className: 'empty', textContent: 'Nothing published yet.' }));
    return;
  }
  for (const r of roms) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <b>${esc(r.title)}</b>
      <span class="muted">/${esc(r.slug)}</span>
      <span class="pill">${r.rom_size} B</span>
      <span class="pill">${r.frame_cost ? r.frame_cost.toLocaleString() + ' hc' : 'unmeasured'}</span>
      <span class="pill">${esc(ago(r.updated))}</span>
      <span style="flex:1"></span>
      <a class="btn" href="${esc(playUrl(r.handle, r.slug))}">play</a>
      <button class="danger" data-slug="${esc(r.slug)}">remove</button>`;
    el.querySelector('button').onclick = async (ev) => {
      const slug = ev.target.dataset.slug;
      if (!confirm(`Remove "${r.title}"? The cartridge file goes with it.`)) return;
      try {
        await call(`/b/${state.me.handle}/roms/${slug}`, { method: 'DELETE', auth: true });
        const b = await call(`/b/${state.me.handle}`);
        state.me.builder = b;
        renderMine(b.roms);
      } catch (e) { say('r', e.message, true); }
    };
    box.append(el);
  }
}

/* A handle in the path is a courtesy: /manage is the page, but a link from a
 * builder page can say which one it came from. */
const { handle } = fromPath();
if (handle) $('#c-handle').value = handle;
if (token.get()) load();
