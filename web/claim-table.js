// A claim, and what the chip says when asked the same question.
//
// Extracted from talk.js the moment a second page wanted the same component,
// which is the same reason sch-draw.js came out of schematic.js. The stake here
// is the usual one: two pages rendering a verdict from two copies would
// eventually render it two different ways, and a reader comparing them would
// have no way to tell which was lying.
//
// The shape a caller supplies is a list of rows:
//
//   says   authored -- the claim, quoted or paraphrased. The ONLY authored part.
//   got    (d) -> string. What the published files say when asked the same thing.
//   holds  (d) -> boolean. Decides the verdict by comparing the two.
//   note   (d) -> string, optional. Why the answer is what it is.
//   where  { href, label }. The page that shows it.
//
// `holds` is what makes this a derivation rather than a table somebody filled
// in: nothing here writes "agrees" anywhere, it is computed per row. A row that
// throws is counted as differing rather than crashing the page, because one bad
// selector should not take down the other six rows.

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/**
 * Render `checks` into `host`, write the tally into `tallyEl`, return the count.
 *
 * The verdict colours the whole card rather than sitting beside it as an icon,
 * so a reader scanning the section sees the one that differs without reading a
 * word. That matters more than it sounds: a table where every row agrees is
 * also exactly what a silently broken comparison produces.
 */
export function renderClaims(host, tallyEl, checks, d) {
  host.innerHTML = '';
  let agreed = 0;
  for (const c of checks) {
    let holds;
    try {
      holds = c.holds(d);
    } catch {
      holds = null;
    }
    if (holds) agreed += 1;
    const row = document.createElement('div');
    row.className = 'claim' + (holds ? '' : ' claim-differs');
    row.innerHTML = `
      <div class="claim-says"><span class="claim-verdict">${holds ? 'agrees' : 'differs'}</span>${esc(c.says)}</div>
      <div class="claim-got"><span class="tag live">measured here</span> ${esc(c.got(d))}</div>
      ${c.note ? `<p class="claim-note muted">${esc(c.note(d))}</p>` : ''}
      <p class="claim-where"><a href="${c.where.href}">Shown on ${esc(c.where.label)}</a></p>`;
    host.appendChild(row);
  }
  if (tallyEl) tallyEl.textContent = `${agreed} of ${checks.length} agree`;
  return { agreed, total: checks.length };
}
