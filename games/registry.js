/* Talking to the registry, once, for the three pages that do.
 * ===========================================================================
 * The API is same-origin here: games.tinymachines.ai proxies /api/ to the same
 * engine 6502.tinymachines.ai does, so the CSP stays connect-src 'self' and a
 * page needs no CORS at all.
 */
export const API = new URLSearchParams(location.search).get('api')
  || `${location.origin}/api`;

const TOKEN_KEY = 'tm6502.registry.token';

/** The token lives in localStorage and nowhere else: it is never put in a URL,
 *  because a URL ends up in history, in a Referer and in somebody's log. */
export const token = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (t) => (t ? localStorage.setItem(TOKEN_KEY, t.trim())
                 : localStorage.removeItem(TOKEN_KEY)),
};

export async function call(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const t = token.get();
    if (!t) throw new Error('no token: paste one in first');
    headers.authorization = `Bearer ${t}`;
  }
  const r = await fetch(`${API}/v1/registry${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    // The service refuses with a reason a person can act on. Surfacing the
    // status code instead would throw that away, which is the whole point of
    // having written the reasons.
    const detail = data && data.detail;
    const msg = (detail && (detail.error || detail)) || text.slice(0, 200) || `HTTP ${r.status}`;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = r.status;
    throw e;
  }
  return data;
}

/** base64 for a Uint8Array, without blowing the stack on a big cartridge. */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** "3 minutes ago". Computed here rather than baked anywhere, for the reason
 *  the simulator's version footer states: a relative time in a cached document
 *  is wrong within the hour. */
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return '';
  const steps = [[60, 's'], [60, 'm'], [24, 'h'], [365, 'd']];
  let v = Math.max(0, s), unit = 's';
  for (const [size, next] of steps) {
    if (v < size) break;
    v /= size; unit = next;
  }
  return `${Math.floor(v)}${unit} ago`;
}

export function playUrl(handle, slug) {
  return `/b/${handle}/${slug}`;
}

export function cartUrl(handle, slug) {
  return `${API}/v1/registry/b/${handle}/roms/${slug}/cart`;
}

/** The handle and slug a pretty URL is carrying. nginx serves one static
 *  document for /b/<handle> and another for /b/<handle>/<slug>, so the path is
 *  the only thing that says which page this is. */
export function fromPath() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'b') return {};
  return { handle: parts[1], slug: parts[2] };
}
