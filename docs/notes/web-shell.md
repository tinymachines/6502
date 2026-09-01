# The web shell: menu, harnesses, layout, CSP, bundle, footer

Everything every page shares, and the traps each piece cost. Split out of `CLAUDE.md`.

## Deep links

`?program=N&run=1&speed=N&steps=N&find=SIGNAL&panel=NAME&lab=ID&step=N` —
mirrors the spirit of the original's query parameters, and is how the app is
driven in headless checks. `?lab=adc&step=4` opens one moment of a walkthrough,
which is the only practical way to point someone at a specific half-cycle.

**`?program=N` is now honoured by every page and outranks the saved choice**, so
a link that names a program gets that program. Without the parameter, the page
runs whatever was last chosen anywhere on the site.

`blueprint.html` takes `?program=N&run=1&path=CONTROL` — e.g.
`blueprint.html?path=dpc23_SBAC` pins the accumulator's path to the special bus.

`?speed=` is the **simulated clock in Hz** (0 for max), not a frame multiplier.
See the transport section.

## The site menu (`site-menu.js`)

One grouped list, rendered into every header. It was ten hand-copied lists
before this, and **they had already drifted three ways**: the index carried
three About links, most pages carried one, the blueprint carried two, and
`timing.html` had quietly lost "Credit" altogether. Nobody noticed for the life
of the project, because a nav missing one link still looks exactly like a nav.
Same reasoning as `version-footer.js` and `block-palette.js`.

- **A `Developers` group holds the API and the Halfwave Lab**, between the
  measured tables and About: things to build against rather than things to
  read, which is why they are not entries under About. Both are marked
  `off: true`, as the archive now is: **deployed beside this tree rather than
  inside it** (the archive is an alias, `/api/` is a proxy to uvicorn, the Lab
  is its own property), so all three are 404s against the dev server and real
  pages in production. `renderMenu` puts that on the link as `data-off`, so
  `_menu-test.html` skips fetching them **by the data's own rule rather than a
  list of its own** -- it then pins the set (a fourth unverifiable link cannot
  appear silently) and reaches all three against the live site. An absolute
  `href` also gets `rel="noopener"`.
- **The order is a reading order, not a sitemap.** Start here → the chip drawn
  four ways → one instruction at a time → the measured tables → about. `Blocks`
  sits between Exploded and Schematic, which is where it belongs: the exploded
  view is where a reader first meets the twelve, and the workbench is where they
  end up once one block is not enough. A reader
  arriving does not know what a decode PLA is, so the tables come after the
  pages that explain them.
- **Every entry carries one line of what it is**, and that line is the part a
  list of nouns cannot do: Exploded, Schematic and Blueprint are three drawings
  of the same silicon, and the difference is the only thing worth knowing when
  choosing between them.
- **One menu at every width.** The inline row of fourteen links was what forced
  the 80rem breakpoint, so a phone and a desktop were navigating differently
  shaped sites; it could carry neither a heading nor a description. Dropping it
  is also where the header found room for the controls.
- **`./` is right from everywhere except the page itself.** From `/primer` it
  means the index, so the entry for the page you are on pointed at the wrong
  page. It resolves to `#top` now, which every page has on its `<main>`.
- **`site-nav.js` measures the room and sets `max-height`; CSS cannot.** The
  panel hangs off a sticky header whose height is not fixed — on a phone the
  controls wrap it onto a second row — and a `calc(100vh - 4.25rem)` left the
  last group 38px below the fold with no way to reach it. It also needs a
  `ResizeObserver`: the header grows *after* boot when the picker and transport
  are filled in, and measuring only on open cached a 70px header.
- **A dot marks the pages that changed since the previous deploy, and it is
  measured.** `tools/build-info.py` asks git which pages' own files changed
  between the commit that was live and the one being deployed, and stamps the
  list into `build-info.json` as `changed`; `site-menu.js` reads it and dots
  those entries. `deploy.sh` reads the live commit off the current release's own
  stamp, which is the one fact about the previous deploy that cannot drift.
  Nothing decides which pages are new by hand, so the dots cannot go stale the
  way a kept list would, and a new page cannot be forgotten.
  - **Not a fixed number of days, and this was measured rather than assumed.**
    A 14-day window was built first and dotted every entry on the menu, because
    the whole site is two weeks old. Every window either dots nothing useful or
    dots everything, and a constant tuned against today's history is wrong
    again a month later. "Changed since you could last have seen it" is what a
    returning reader means, and it adjusts itself as the site ages.
  - **The page-to-files map is a page's own document and script**, not
    `style.css`, the shared modules or the JSON it reads: those touch every page
    at once and would light every dot at once, which says nothing.
  - **The archive shares `site-menu.js` and stays undotted on purpose**: its
    `build-info.json` is `kind: archive` and carries no `changed` list, and
    `markRecent()` does nothing without one. Failure to load leaves the menu
    exactly as it was; the dots are a courtesy, not navigation.
  - **`_menu-test.html` asserts the DOM agrees with the file**: every page in
    `changed` carries a dot and no page outside it does, with a title and
    screen-reader text on each.
  - **The panel is measured at real viewports now, and the last entry has to
    be reachable.** Every narrow case used to be measured in an 820px-tall
    frame, which is not a phone, so the panel never had to scroll and a
    reachability check could not have failed. At 320x568 it is **458px of room
    for 1937px of menu**. Fitting is not reaching, so the harness scrolls the
    panel to its end and requires the last link to be inside it. Proved by
    removing the scroll box (`overflow-y: visible`), which fails it -- **note
    that `overflow: hidden` does NOT**, because a hidden box is still
    programmatically scrollable in Chrome and only the user is stopped. That
    was the first mutation tried and it passed, which looked like a weak
    assertion and was a wrong proof.
- **The archive's menu is grouped the same way but is not the same list.**
  `shell.py` owns it, split into "The archive" and "The simulator", which is
  the fact a reader most needs: half of those links leave the archive. The
  disclosure wiring in `site-nav.js` is shared verbatim; the list is not.
  `with_extra()` inserts the wiki's Images entry **by label**, replacing an
  index splice that was correct only until somebody reordered the list.

## Development harnesses in `web/`

Thirty-seven harnesses plus three probes, all prefixed `_` and **never shipped** —
`build-web.py` copies only the files it names, so they cannot reach `dist/`.
They exist because the front end has no other test route and screenshots do not
catch this class of bug.

```bash
_camera-test.html      # zoom limits and pan clamping, asserted
_resize-test.html      # resize the renderer, then read back pixels: is it drawn?
_handler-test.html     # drive every event handler; report anything that throws
_overflow-test.html?w=320&page=trace   # what pushes a page wider than the viewport
_navfit-test.html      # the header, at 12 widths x 4 pages: does it fit, and are
                       # the picker, transport and clock still usable sizes?
_chipnav-test.html     # the shared transport: the rate is a rate (paced with
                       # synthetic timestamps), and every control is one store
_menu-test.html        # every page offers the same menu, every link reaches a
                       # page, and the panel fits the screen it opens on
_contrast-test.html    # every button, every state, checked for readable text
_persist-test.html     # the console's configuration, across a second page load
_pinio-test.html       # pinned I/O chains, vs an independent search of the netlist
_asm-test.html         # the assembler round-trips, the old programs are byte-
                       # identical, and each new one is RUN until its answer lands
_programs-test.html    # the Programs page vs the assembler, timing.json and the chip
_halfshot-test.html    # every recorded frame vs an independent chip, the island's
                       # switch set recomputed, the exported deltas replayed, and
                       # the file's stated encoding decoded by hand and pinned
_halfshot-dump.html    # the export as JSON in a <pre>, for check-halfshot.mjs:
                       # ?gap=1 drives the Record-off path first, ?frames=N grows
_lab-probe.html        # per-half-cycle dump: T-states, decode lines, every bus
_lab-test.html         # every Lab claim, checked against the engine
_primer-test.html      # the primer's numbers re-derived, and its five examples run
_trace-test.html       # cycle counts counted, and ADC landing after the end
_tracer-test.html      # the whole-circuit view: rings, flashed and bright edges,
                       # watch bytes and the current line all recomputed from a
                       # chip of its own; positions from layout.bin itself
_schematic-test.html   # does the drawing contain everything the caption claims?
_solo-test.html        # the study view, driven against the REAL page in an iframe
_solo-shot.html        # ...and into a screenshot: fullscreen needs a click
_exploded-test.html    # the exploded view: do the sliders actually move geometry?
_blueprint-test.html   # the block diagram: drawn, bound, and no label collisions
_decode-test.html      # the decode table, re-checked against the documented ISA
_timing-test.html      # cycle counts, re-checked against the published ones
_block-test.html       # the block pages: the interface and the circuit, re-derived
_block-probe.html      # what one block's signals do, per half-cycle, for its prose
_talk-test.html        # the talk page: every claim re-derived from the JSON by the
                       # harness itself, and the one row that DIFFERS is pinned
_designer-test.html    # the designer page: the clock generator re-walked by the
                       # harness, and the walk re-run WITHOUT its boundary clause
                       # to prove the clause is load-bearing
_blockdiagram-test.html # the published figure: every block re-resolved from
                       # schematic.json by the harness, and the one row that
                       # DIFFERS pinned to the single-bus claim
_archive-changed-test.html  # the archive index's changed-since section vs the
                       # stamp AND the footer, in all three states; run from
                       # the archive's own root (see its header)
_pinout-test.html      # the pinout: directions re-derived by the harness AND
                       # checked against what a 6502's pins are known to do,
                       # because the page and a naive harness could agree
_diegraph-test.html    # the die graph: the harness recomputes every centroid
                       # from layout.bin itself and compares, which is the only
                       # assertion that tests the page's thesis
_ports-test.html       # the block bench's Ports drawer: the filter filters, a
                       # switched-on pill survives a filter that excludes it,
                       # and the drawer is capped to the strip and SCROLLS
_csp-test.html         # every page, with its deep links, booted under the LIVE
                       # Content Security Policy: zero violations reported, and
                       # the policy proven to reach a framed page first
_chipmap-test.html     # the chip map: partition complete and disjoint, every
                       # bundle recounted and every column recomputed from the
                       # raw arrays, the ownership joints pinned by name, and
                       # the tour's every authored claim re-run on its own chip
_tour-probe.html       # per-half-cycle dump of the tour's program: buses,
                       # control lines, and the change set grouped by the
                       # partition. Run it before editing any tour prose.
_graph-test.html       # graph.json against the files it was written from: names,
                       # blocks, roles, centroids (via die-centroids.js), gate and
                       # switch edges vs schematic.json, transistor kinds recounted
```

**A harness that samples state still in flight tests nothing.** `_handler-test`
failed about one run in twenty, and the cause was not slowness: the section
before it clicks fullscreen while `requestFullscreen` still exists, and that
request can take arbitrarily long to be refused when there is no user
activation. Its `setFaux(true)` then landed *after* the next "start from a known
state" check had already read the class list, so every click from there on did
the opposite of what it looked like and the whole section ran inverted. The fix
is `settle()` — poll until the classes stop changing — before establishing a
known state. Found by writing a throwaway instrumented copy that logged every
class mutation with a timestamp; the inversion was obvious in one trace and
invisible in the pass/fail line.

Two lessons that generalise, both of which cost a round here:

- **`settle()` is the wrong tool for asserting that something must *not* happen.**
  It returns as soon as nothing is currently changing, so an assertion about a
  commit that lands 400ms later runs before it and passes either way. Wait past
  the event instead.
- **A fix is not justified until the test fails without it.** The `settle()`
  change alone cured the flake; the app-side guard was verified separately by
  reverting it and watching the new assertion go red. Two earlier versions of
  that assertion passed with and without the fix and were therefore worthless.

**Do not test the running app inside an iframe.** Headless throttles animation
frames in an iframe to nearly zero, so the canvas never redraws and *every*
scenario looks broken — an entire investigation can be spent on that artifact.
`_resize-test.html` therefore builds the renderer at top level and calls
`render()` synchronously; `_handler-test.html` does use an iframe, but only
dispatches events and watches for throws, which needs no frames at all.

Read the title with `--dump-dom`: each reports `ALL PASS` or `PAGE OK`.
`_lab-probe.html` is the one to run *before* writing anything about what the
chip does — see the Lab section below.

## The renderer (`web/`)

Plain ES modules, no build step, no framework: `renderer.js` (WebGL2),
`app.js` (glue + UI), `disasm.js`, `lab.js`, `asm.js` (the 6502 assembler),
`programs.js` (the shared program set, assembled at load), `program-nav.js`
(the header picker), `chip-controls.js` (run state and clock rate) and
`chip-nav.js` (the header transport), `blueprint.js`, `decode.js`, `timing.js`,
`programs-page.js` and `trace.js` (five further pages, see
below), `claim-table.js` (the verdict card, shared by `talk.js` and
`designer.js`), `index.html`,
`style.css`, plus
`site-nav.js` and `version-footer.js` which are **shared verbatim with the
archive** (`build-archive.py` copies them). A second copy of either would drift.

The design turns on one fact: **the layout never changes.** 83,227 triangles go
to the GPU once. What changes per frame is a 1725-byte node-level array uploaded
as a small R8 texture that the *vertex* shader samples by node ID. A frame is six
draw calls (one per layer) plus a 2 KB upload, at any zoom.

Passes: scene → 4× MSAA renderbuffer → blit-resolve → bright-pass at half res →
separable gaussian → composite with a filmic shoulder and vignette.

**Picking** reuses the original's trick on the GPU: a second pass renders node IDs
into an RGBA8 framebuffer (id low byte in R, high byte in G, layer in B, alpha as
"something is here") and `readPixels` reads one pixel. It is only re-rendered when
the *camera* moves — node IDs are geometry, so a running chip does not invalidate
it.

## The CSP is part of the page, and nothing in development enforced it

The live site sends `style-src 'self'` with no `'unsafe-inline'`. That blocks
writing a **style attribute** (`setAttribute('style', …)`, or `style="…"` in
an `innerHTML` template) and allows the CSSOM (`el.style.setProperty`,
`el.style.width = …`). The two leave an identical DOM, because the CSSOM
reflects back into the attribute, so no assertion on rendered elements can
tell them apart, and the dev server sent no policy at all. The tracer shipped
with every container colour (`--bc` on regions, beads, halos, capsules, super
nodes) written through `sch-draw.js`'s `el()` as an attribute: on the live
site every container drew grey with one console error per element, while
`_tracer-test.html` was green. A reader's console dump is how it surfaced.

- **`el()` routes a `style` key through `style.setProperty`** and never the
  attribute, so every caller of the shared helper is fixed at once.
- **Run under the policy, the sweep found two pages that had shipped that way
  for the life of the site**: the explorer's layer-key swatches
  (`buildKeyPanel`) and the timing histogram's bars (`style="width:…"` in a
  template: every bar zero wide on the live site), plus the schematic's Ports
  pill swatch. All three set the value from the CSSOM after the template now.
- **`serve.py` sends the live policy** (see the Commands section), so every
  harness that frames a page now frames it under the conditions it ships
  under. The archive builders are not affected: `_*` is the only exemption.
- **`_csp-test.html` frames every page at its own URL, with its deep links,
  and reads the violation reports back from the server.** It proves the
  arrangement first (the header is on the page and not on the harness; a
  style attribute written into a framed page from the harness is reported; a
  CSSOM write is not), because a server that had quietly stopped sending the
  policy would otherwise pass every page forever. Each fix was verified by
  reverting it and watching its entry go red.
  - **A `srcdoc` frame was tried first and rejected.** It inherits the
    parent's policy, and a `<meta>` CSP on the harness did reach it; but
    `about:srcdoc` can carry no query and refuses `replaceState`, so the pages
    that only build something under `?block=` or `?step=` were passing
    vacuously. The check that caught it was the frame reporting its own
    `location.search` back, which came back empty. A harness that feeds a
    page a condition has to assert the condition took.
  - **Chrome deduplicates `report-uri` reports** by document, directive and
    source line, so the harness sees `x1` where the in-page
    `securitypolicyviolation` event fired 262 times. Count sites, not events.

## Renderer invariants — each of these was a real bug

- **Node levels must be uploaded as 255, not 1.** The R8 texture is normalised, so
  a byte of `1` arrives at the shader as 1/255 and is invisibly identical to
  "low". The chip renders perfectly and is simply never live. `nodeLevelsPtr()`
  emits 255 for exactly this reason.
- **vss and vcc are excluded from the state overlay and from highlighting**
  (`setRailNodes`). Their polygons blanket the die, so colouring them by state
  floods the image, and tracing any driven signal reaches a rail and would light
  up the whole chip. The original avoided this implicitly by never storing
  geometry for the rails; we keep the geometry (it is most of the visible
  structure) and mute it instead. Rails are also excluded from zoom-to-fit.
- **Grid tracks need `minmax(0, 1fr)`.** A bare `1fr` takes its automatic minimum
  from content, so the tall sidebar pushed the stage past the viewport and the
  canvas sized itself to the overflow (1280×1280 in a 913px window).
- **`[hidden]` needs `!important`** here: the UA rule is specificity (0,1,0) and
  the `#boot`/`#app` rules declare `display`, so hiding them silently did nothing.
- **A `var()` naming a token that does not exist drops the whole declaration,
  silently.** Three invented names — `--panel`, `--panel-2`, `--fg` — spread
  across the exploded and schematic styles before anyone noticed, because the
  usual symptom is "slightly wrong" rather than an error. The one that finally
  showed was the faux fullscreen: `background: var(--panel)` meant *no*
  background, so covering the viewport left the page visible underneath. The
  real tokens are `--surface`, `--subtle`, `--foreground`. Check with a
  `:root`-vs-`var()` diff, not by eye.
- **A bare `.btn` had no `background`,** so it inherited the user agent's button
  face — white, on a dark page. Every secondary button on every page wore it.
  Set `background`, `border-color` and `color` explicitly on the base class;
  variants override.
- **A variant that changes its background must restate its colour**, because the
  base class's *state* rules outrank the variant's resting one. `.btn:hover`
  declares `color: var(--accent)` at specificity (0,2,0) and `.btn-primary`
  declares its colour at (0,1,0), so hovering the primary call to action put
  cyan text on the gold background — two light blues at a contrast ratio of
  **1.08**, and nothing rendered at rest could show it. This is the same shape as
  the missing background above and was found the same way: by somebody pressing
  the button.
  - `_contrast-test.html` now checks every button in `:hover`, `:active` and
    `:focus`. A state cannot be forced from script, so it **re-implements the
    cascade**: collect the rules that would match, sort by specificity then
    source order, resolve `var()` against `:root`, and compute the winning pair.
    Verified by reintroducing the bug and watching it go from 11.31 to 1.08.
  - Two things it has to get right, both of which it got wrong first. A
    `background: var(--x)` shorthand does **not** expand in the CSSOM, so
    declarations are read out of `cssText` rather than from `rule.style`. And the
    page background is a *gradient*, so no ancestor has a background colour at
    all — a transparent button is read against the first opaque ancestor, and
    failing that against `--space`.
- **Anything decided before an `await` must be rechecked after it.** The
  fullscreen handler awaits `requestFullscreen` and then a 120ms verification
  before committing the fallback. Without a guard that commit lands whatever the
  reader has done in the meantime — press Escape during a slow refusal and the
  console drags you into a fullscreen you just cancelled. `setupFullscreen` now
  carries a `generation` counter that every committing path re-checks, and
  Escape bumps it. Pinned by "Escape cancels a fullscreen request still in
  flight", which fails without the guard.
- **Frame the camera only after the canvas is visible.** It is created inside a
  hidden panel and measures 1×1 until then. `userFramed` makes this
  self-correcting rather than boot-order dependent.
- **`screenToDie` inverts the *projection*, not the raw die coordinates — both
  axes add.** The negative sign in `uScale.y` already flips the die for display,
  so in the image that reaches the screen die Y runs downward, exactly like
  screen Y. Subtracting on Y — on the reasonable-sounding theory that "die Y
  grows upward" — inverted vertical panning and made zoom drift away from the
  cursor instead of anchoring to it. `panByPixels` subtracts on both axes for
  the same reason: the die follows the pointer, so the camera moves opposite it.
  `_camera-test.html` pins this by mirroring the vertex shader and asserting the
  round trip; a test written in terms of `screenToDie` alone would pass happily
  with both directions inverted, which is how this shipped.
- **The camera is bounded, and the bounds are derived rather than stored.**
  `minScale`/`maxScale` are getters over `fitScale()`, because a stored copy goes
  stale on resize — which is exactly when a wrong minimum lets the die escape.
  `_clampCamera()` states its rule in terms of the *view rectangle*, not the
  camera centre, so one expression works both zoomed in (viewport smaller than
  the die) and zoomed out (larger). Without it, panning is unbounded arithmetic
  and a hard drag leaves a black screen with no way back but the keyboard.
  Asserted in `_camera-test.html`.
- **Render targets are size-capped and checked for completeness.** A framebuffer
  whose storage could not be allocated does not throw and does not warn — it
  silently draws nothing, so the failure arrives as a black canvas with no error
  anywhere, and typically only on the machine with the big monitor. Everywhere
  except fullscreen the canvas is bounded by the page's `max-width`; fullscreen
  on a 4K display at `devicePixelRatio` 2 asks for **7680×4320**, past the 8192
  limit here, past the 4096 limit on many GPUs, and over half a gigabyte once
  multisampled. `resize()` scales both axes by one factor (preserving aspect),
  drops MSAA above `MSAA_PIXEL_LIMIT` — an aliased chip beats no chip — and
  retries smaller if allocation still fails. `_resize-test.html` forces
  `maxTarget` down to exercise that path on any machine.
- **A canvas measuring ≤1px is not a viewport**, it is an element that has not
  been laid out yet (hidden panel, mid-transition into fullscreen). `resize()`
  ignores it once real targets exist; acting on it rebuilt every target at 1×1
  and clamped the camera into a 1×1 zoom range, silently discarding where the
  user was looking.
- **Disassembly comes from `lastFetchAddr`/`lastFetchOpcode`, not from IR.** IR
  holds the opcode, but PC has already advanced past its operands, so operands
  read relative to PC belong to the *next* instruction. The simulator latches each
  fetch at `sync` so batched stepping cannot miss one.

## The page shell is a convention, and it is not written in the CSS

Every page carries the same head, header, footer and section classes, and none
of that is enforced by anything. Two of them went wrong on the block pages in
one sitting, and both looked like a stylesheet that had failed to load:

- **Prose sections are `class="wrap sec bp-prose"`, with the eyebrow and the
  heading inside a `<div class="sec-head">`.** `.wrap` carries *no vertical
  padding at all* -- it is max-width and side gutters only -- and `p` has
  `margin: 0`, so a section that is `wrap` alone has every heading butted
  straight against the content above it.
- **The footer is four elements, not one.** `<footer class="site-foot">` is the
  fixed bar; inside it a `.wrap` holds the wordmark, the `.foot-meta` line, and
  a `<span class="version-foot" data-version-footer>`. Putting
  `data-version-footer` on the `<footer>` itself renders the version in the
  page's body font at 16px instead of mono at 11.2px, and silently drops the
  wordmark and the project line.

**Diff the shell against a known-good page rather than reading it.** Blanking
out `<main>`, the title and the description leaves boilerplate that should be
byte-identical to `timing.html`; anything left in that diff is a divergence.
That found the remaining one (script order) in a single pass, after two rounds
of finding them one at a time by eye.

`.bp-prose` also puts a gap between adjacent paragraphs, which is right for a
column of prose and wrong inside a card or a table row, where two paragraphs in
a row are a value and its caption. Turn it off on the component, not on the
section: the section's own ledes still want it.

## Page shell, responsive layout and PWA

The app is a page, not a bare tool: sticky header, hero, the explorer in a
bordered "console" panel, then explanatory sections and a footer. The design
language is deliberately borrowed from `nominate.ai` — hard offset shadows (no
blur), 2px borders, mono eyebrows with a gradient rule, Inter 900 headings — in a
cyan/steel palette so it reads as a sibling rather than a copy. Tokens live at
the top of `style.css`; recolouring the whole app means editing `:root`.

Layout breakpoints:

| Width | Explorer layout |
|---|---|
| < 68rem | canvas above, panels behind a tab bar (`#panels[data-active]`) |
| ≥ 68rem | canvas beside a persistent sidebar; the tab bar is hidden and CSS ignores `data-active` |

The header has its own four, and they are independent of the explorer's:

| Width | Header |
|---|---|
| ≤ 34rem | picker and clock narrowed, menu button tightened. The "Menu" label stays |
| ≤ 52rem | the control group takes a row of its own; the source link and menu button reorder together |
| < 80rem | nav links behind the disclosure menu |
| ≥ 80rem | links inline beside the controls; ≥ 96rem gives both more room |

**The control group wraps as one thing, and the menu button is reordered with
it.** Program, transport and clock are three controls competing for a row that
already held a wordmark and a menu button; at 320px they want about 90px more
than the viewport has, and a header that overflows scrolls the whole page
sideways rather than clipping. Given a row of its own the group has the full
width to divide up. Source order puts the menu button *after* the group, so
without `order` it wraps to a third row and the header eats 144px of a phone
screen to show three things.

- **Filling the row is not the same as being usable.** With no cap the picker
  grew to 645px on a page whose slot has no transport beside it. It is capped at
  18rem in the wrapped row and floored at 6rem in the narrow one.
- `_navfit-test.html` measures the transport and the clock the same way it
  measures the picker, and for the same reason: a tap target squeezed to nothing
  still renders and still looks like a control.

**There are TWO source links, and the second carries its name.** The simulator
is this site; `halfphi` is the switch-level engine underneath it, published on
its own because it is about switch networks rather than about a 6502 and because
it embeds no die data, which is the only reason it can be MIT. Two identical
octocats side by side is a choice with no answer, so the second is `.gh-lib`:
the mark plus `halfphi` in mono, **hidden below 34rem** where row one is down to
the wordmark and two buttons. The menu's Developers group carries it at every
width, which is what makes hiding it honest. Measured at four widths: 44px +
100px above 34rem, 44px alone below, no header or page overflow anywhere. **The
`.gh-lib` rule is written twice** -- `style.css` and `shell.py` -- because the
archive calls the mono token `--mono` and the simulator calls it `--font-mono`,
the trap this file already documents; and **the archive needs a rebuild** to
pick the shared `site-nav.js` up, since it deploys separately.

**The source link is injected by `site-nav.js`, and is the one header element
that is not hand-copied.** Everything else in the header -- wordmark, control
slots, menu button -- exists in eleven documents plus `archive/tools/shell.py`,
which is the arrangement that had already let ten copies of the nav list drift
three ways before `site-menu.js` existed. A twelfth hand-copied element would be
repeating that knowingly, so `addSourceLink()` inserts one before `.menu-btn` on
every header it wires. The archive gets it without any markup of its own,
because `build-archive.py` copies that file verbatim.

- **Its style has to be restated in `shell.py`.** The archive carries its own
  stylesheet rather than the simulator's, emitted per builder as
  `own CSS + shell.CSS` into `archive.css`, `wiki.css` and `gallery.css`. The
  three tokens the rule needs (`--line`, `--muted`, `--gold`) happen to exist
  under the same names on both sides; `--font-mono` does not, and is `--mono`
  there. **Check the `.css` files, not the HTML**: the header markup is in the
  pages and the header CSS is not, so grepping a generated page for a new rule
  reports it missing when it is present.
- **The pair reorders together below 52rem.** A default `order: 0` strands the
  link beside the wordmark while the button moves right, and the auto margin has
  to sit on whichever of the two comes first or a gap opens between them.
- **The "Menu" label is shown at every width.** It was hidden below 34rem when
  the controls still shared row one with the wordmark and a 90px call to action.
  Since the group took a row of its own at 52rem, row one holds the brand and
  those two buttons and nothing else, so the word fits at 320px. Measured in a
  real iframe: a `--window-size` under ~500px crops the photograph without
  narrowing the layout, so a screenshot cannot answer this.

Touch-specific behaviour that is easy to break:

- **`touch-action: none` on the canvas is mandatory.** Without it a drag scrolls
  the page instead of panning and the app is unusable on a phone.
- Pointer Events unify mouse/pen/touch, but touch adds a *second* contact, so
  live pointers are tracked in a `Map`: one pointer pans, two pinch-zoom about
  the midpoint and pan by the midpoint's movement.
- **Pinch state has exactly one constructor (`pinchOf`), and that matters.** It
  had two, spelled differently: seeding spread `midpoint()` in as `{x, y}` while
  the move handler read `.cx`/`.cy`. So the first move after a second finger
  landed computed `mid.x - undefined`, and NaN went into the camera — where it
  *stuck*, because NaN survives every comparison (`Math.max(lo, NaN)` is NaN).
  The die vanished permanently on the first pinch. This survived the whole
  project because two-finger gestures are the one path headless cannot
  synthesise; it took real hardware. `_handler-test.html` now drives a synthetic
  pinch through the real handlers and also asserts the invariant statically.
- **`_clampCamera` rejects a non-finite camera** rather than propagating it. It
  is the choke point every camera change passes through, so it is the right
  place to refuse one, and it turns a class of permanent blank screen into a
  single dropped frame.
- Tap slop is larger for touch (12px vs 4px) — a finger always moves a little,
  and a tap that registers as a drag never selects anything.
- The hover card is suppressed under `(hover: none)`; otherwise it sticks where
  you last tapped.
- Text inputs are 16px because iOS zooms the viewport on focus below that.
- A tap that selects a node also switches the panel tab to Trace on small
  screens, since the result would otherwise be behind a tab.

Layout gotchas already paid for, in narrowing order of subtlety:

- **A long word in a hero `h1` overflows the page, and every existing heading
  avoided it by luck.** `.hero h1` is Inter 900 at `clamp()` sizes, so at 320px a
  word of about eleven characters is already wider than the column; the first
  heading written with "photographed" in it pushed the whole document sideways by
  4px. `.hero h1` now carries `overflow-wrap: break-word`, which acts only when a
  word cannot fit on a line of its own and therefore changes nothing elsewhere.
  **The bisect is the lesson, not the fix**: hiding any single section still
  overflowed, hiding *all* of them did not, and that looked like "every section
  is guilty". It was not. A shorter page loses its vertical scrollbar, which
  hands back exactly the 4px the iframe scrollbar was taking, so the only
  section-level result that meant anything was the all-hidden one. Two CSS
  changes were made on wrong theories before that was noticed. **When hiding
  things changes the scrollbar, it changes the width you are measuring.**
- **`_overflow-test.html`'s "elements past the viewport edge" list is
  informational, not causal.** A passing page prints a long list of them:
  `timing` at 320px reports its opcode grid at 544px wide and still says PAGE OK,
  because that grid is inside something that clips. Read `scrollWidth` against
  `viewport` for the verdict and treat the list as a starting point only. An
  earlier round here "fixed" a table that was never the problem.
- **A flex item defaults to `min-width: auto`,** so it refuses to shrink below
  its content — and `min-width: 0` on a *child* cannot rescue it. The program
  `<select>` overflowed the console at 320px until `min-width: 0` was set on the
  wrapping `.field`, not just the select. Suspect this for any "why won't this
  shrink" question.
- **Grid tracks need `minmax(0, 1fr)`**, not `1fr`, or the track takes its
  automatic minimum from content. This sized the canvas to 1280×1280 in a 913px
  window.
- **Count columns with `auto-fit` and a real minimum, not with a breakpoint.**
  The schematic's controls went to three columns at 46rem, and a field there is a
  label *and* a pair of buttons — so at tablet widths the label ran through the
  control beside it and the last button was clipped by the console's own
  `overflow: hidden`. `repeat(auto-fit, minmax(13.5rem, 1fr))` cannot make that
  mistake at any width. The label sits above its control at every size for the
  same reason: beside it, the two compete for a track that is already too narrow.
  Found on a tablet, not in a harness — `_overflow-test.html` reported the page
  as fine, because the overrun was *inside* an element that fits.
- **`[hidden]` needs `!important`** here, because the UA rule is specificity
  (0,1,0) and `#boot`/`#app` declare `display`.
- Test at **320px**, not just 390. Several things only break at the narrowest
  common phone width. Two did: the header's wordmark, CTA and menu together want
  ~330px against ~285px available, and the six transport buttons want 302px. The
  header's overflow *escapes* (nothing clips it) and scrolls the whole page; the
  transport's is clipped by `.console { overflow: hidden }`, so the last button
  is simply cut off and looks like a missing feature. Below 24rem the CTA is
  dropped and the transport tightened. `_overflow-test.html?w=320` names the
  culprit, which is otherwise very hard to attribute — the element that
  overflows is rarely the element at fault.
- **Fullscreen does not depend on the Fullscreen API.** iOS Safari implements it
  for video elements only, so `requestFullscreen` on a div is absent on iPhone;
  this used to be a bare try/catch, meaning the button did nothing and said
  nothing. It now tries the API, *verifies it actually took* (webkit's returns
  undefined, not a promise, so a resolved await proves nothing), and otherwise
  covers the viewport with `position: fixed`. Both paths set `.immersive`; only
  the fallback adds `.faux`.
  - **The CSS keys on a class, never `:fullscreen`.** An unknown pseudo-class
    invalidates the *whole* selector list, so `.console:fullscreen,
    .console.immersive { … }` would silently drop everything on a browser that
    does not know `:fullscreen`.
  - **`z-index` on the console cannot work, and this cost two rounds to see.**
    Every `.wrap` is `position: relative; z-index: 1`, so each section opens a
    stacking context and confines its descendants — the console's z-index only
    orders it *within* `#explorer`. Outside, what competes is `#explorer`'s own
    z-index of 1, which loses to the header (root, 30) and to every *later*
    `.wrap` sibling by document order. The symptom is page text appearing
    through the console, which reads exactly like a transparency bug and is not
    one. `body.no-scroll #explorer { z-index: 70 }` is the fix.
  - The fallback also needs an **opaque** background: the console is normally 92%
    and relies on a solid page behind it.
- **In fullscreen on a phone the panels are a drawer over the die**, collapsed to
  its handle by default (`[data-drawer]` on `.console`, `setDrawer()`). Sharing
  the height with a canvas is the wrong trade on a 390px screen — fullscreen
  there should mean the die. The stage is `position: absolute; inset: 0` in that
  layout, so opening, closing or changing tab cannot resize it.
  - This **replaced** a `--panel-lock` scheme that measured the tallest panel and
    pinned the container to it. That existed only because a tab change resized
    the stage and jumped the die; the drawer removes the cause, so the
    measurement was deleted rather than left to rot beside it.
  - Collapse hides `.panel` rather than translating by a measured offset, so the
    drawer shrinks to exactly its handle plus tab strip with no magic number to
    drift out of step.

PWA: `manifest.webmanifest` plus icons generated by `tools/make-icons.py` (kept
in the repo so they are reproducible, not mystery binaries). nginx has no
`webmanifest` MIME type, so the site config sets it with `default_type` in a
location that declares no `add_header` — see the header-inheritance trap above.

**It installs on the desktop, and already did.** Chrome's bar for that is a
manifest with a name, 192px and 512px icons, a `start_url` in scope,
`display: standalone`, and a service worker with a fetch handler — all of which
were in place. What was added is polish rather than the qualification:
`display_override` for a browser that prefers `minimal-ui`, `launch_handler`
with `focus-existing` so a second launch raises the open window instead of
opening a second one, `handle_links` so in-scope links open in the app, and two
more shortcuts.

- **The remaining gap is `screenshots`.** Without one carrying
  `form_factor: "wide"`, desktop Chrome shows its small install dialog rather
  than the rich one. Adding them means capturing the site headlessly at build
  time, and the deploy runs under systemd where a browser is neither installed
  nor wanted — so this is deliberately not done, rather than forgotten.
- The manifest's `name` is a fourth place shipped text lives, and it is not
  matched by `grep '—' web/*.js web/*.html`. One em dash survived there for a
  whole pass because of exactly that. Check `web/manifest.webmanifest` too.

## Hashed bundle and the service worker

`web/` stays directly servable for development — no build step, no worker.
Production goes through `python3 tools/build-web.py web dist`, which content-hashes
every asset and emits `sw.js`. The deploy runs it and publishes `dist/`.

Hashing is **dependency-first**, because a change to a leaf has to ripple upward:

```
layout.bin ─┐
*_bg.wasm ──┴─> v6502_wasm.js ─┐
renderer.js ────────────────── ┼─> app.js ─┐
disasm.js ──────────────────── ┘           ├─> index.html   (never hashed)
style.css, icons ──> manifest.webmanifest ─┘
```

Three references would not rewrite themselves and are handled explicitly:

- **`new URL('v6502_wasm_bg.wasm', import.meta.url)`** inside the wasm-bindgen
  glue is a runtime URL, not a module specifier, so no bundler-style import
  rewriting would catch it.
- `app.js`'s three relative imports.
- `fetch('layout.bin')`.

`replace_once()` fails the build if any of these does not match exactly once. A
silent no-op here yields a bundle that 404s at runtime, which is far harder to
diagnose than a build that refuses to finish.

The worker is only safe *because* of the hashing: cache-first on a mutable URL
eventually pairs a new `.wasm` with an old `app.js`. Two deliberate choices:

- **No `skipWaiting()`.** A running page holds references to the current build's
  hashed URLs. Taking over mid-session and then dropping the old cache in
  `activate` would pull them out from under it. The new worker waits for every
  tab on the old one to close; `clients.claim()` in `activate` is safe precisely
  because activation already waited.
- **Navigations are network-first**, hashed assets cache-first. A deploy is
  picked up as soon as the user is online, and the cached shell is the offline
  fallback.

`index.html` and `sw.js` are never hashed and served `no-cache` — they are what
point at everything else, and a cached `sw.js` would pin an old build. Hashed
assets get `max-age=31536000, immutable`, which is now honest.

**nginx gotcha:** a `map` key containing `{` must be quoted, or the config parser
reads the brace as the start of a block and rejects the file.

Verify offline for real rather than trusting registration: load once with
`--user-data-dir=<dir>`, stop the server, load again with the same profile. The
app should render fully with the server down.

A `#hash` deep link needs re-applying after boot: the target does not exist while
`#app` is hidden, so the browser's initial scroll goes nowhere.

## The version footer

`tools/build-info.py` stamps git metadata into `build-info.json`;
`web/version-footer.js` renders `v0.14 @7e02172 · deployed 3m ago` into any
`[data-version-footer]` element. Both the simulator and the archive carry it, and
both stamp separately since they deploy separately. A dirty working tree gets a
trailing `+`, so a deploy from uncommitted changes says so.

**The simulator's footer is fixed to the viewport, not to the end of the
document.** It is a status bar: which build this is and when it shipped,
readable without scrolling to the bottom of a long page. That costs a strip of
height on every screen, so it is a thin one, and `--foot-h` is *declared* rather
than measured with `body` reserving exactly that much — a last paragraph hidden
under a fixed bar reads as a page that was cut off. Everything in it is
left-aligned and reads in one order: what it is, then which build. The version
used to be pushed to the far edge with `margin-left: auto`, which on a wide
screen put the two halves of one sentence a metre apart. `body.no-scroll` hides
it, as it already hid the header: a footer floating over a fullscreen die is
worse than either. The archive keeps its own in-flow footer and is unaffected.

- **It also says what changed since the previous deploy**, as the same
  `changed` list the menu dots, so the two cannot disagree. Three states, and
  telling the last two apart is the point: pages named and linked to the GitHub
  compare between the two commits; `no page changed` when there is an anchor
  but an empty list, because a footer that goes quiet is ambiguous; and nothing
  at all when there was no previous deploy, since an empty list with no anchor
  is not "nothing changed", it is "nothing to compare against". The archive's
  stamp carries the pair too, measured over ITS pages against ITS previous
  deploy, so this file being shared costs nothing: the same renderer reads
  whichever stamp sits beside it.
  - **The archive's "pages" are its sections, and what changes them is the
    builder that emits them** plus the shared shell and the recovered content
    it is built from -- `ARCHIVE_FILES` in `build-info.py`. The 2.3 GB mirror is
    excluded on purpose: it is somebody else's site, preserved exactly, and
    "changed" is not something we should ever say about it.
  - **The archive is stamped at build time and only the deploy knows what is
    live**, so `archive-deploy.sh` re-stamps just before publishing, reading the
    anchor off the live copy's own `build-info.json` -- the same arrangement the
    simulator's deploy uses, for the same reason: it is the one fact about the
    previous deploy that cannot drift.
  - **The simulator index carries the same section**, and its labels come from
    the rendered menu rather than being written into the page: the slot says
    `data-changed-since="menu"` and the module reads `.navlinks a[data-page]`
    for label and href. Fifteen labels already live in `site-menu.js`, and a
    second copy in the HTML would be the one that drifts. The module cannot
    *import* the menu -- it is shared with the archive, which has no site menu
    -- so it reads the DOM and waits for it, both being module scripts.
    `_menu-test.html` asserts every label in the section is the menu's own by
    comparing the two DOMs, which is the check that a renamed page has to pass.
    - **Above six pages the list folds behind a `<details>` stating the count.**
      A deploy touching every page is a real event -- a shell change, a rename
      -- and should be said, but fifteen bullets is a wall that says less than
      one line. Asserted both ways: three flat, fifteen folded.
    - **Its `[hidden]` rule carries `!important`**, for the reason `#boot` and
      `#app` already taught: the UA's own is only (0,1,0).
  - **The archive index also carries the list as a section**, filled at
    runtime by the same shared `version-footer.js` into a `[data-changed-since]`
    slot. Runtime rather than baked by the builder, because the index is built
    *before* the deploy and only the deploy knows what was live -- the same
    timing gap the footer had. Reading the same stamp means the section and the
    footer can never disagree, and `_archive-changed-test.html` asserts they do
    not, in all three states. The hidden state (no previous deploy) is the one a
    broken fetch would fake perfectly, which is why it is asserted directly.
    - **That harness has to be served from the archive's own root.** From
      `web/` on another port the stamp fetch is cross-origin and blocked, which
      the first version found by failing on every state at once. It is copied
      into `archive/public/` to run and removed afterwards.
    - **The wiki's images contact sheet carries it too**, for the same reason
      the indexes do: it is a page this archive *built* (the backstop that keeps
      every recovered image reachable), not a rebuilt article. The rule is
      "ours, not theirs", and `images.html` is ours.
    - **The gallery chip pages carry it; the wiki articles do not.** The line
      is "is the *page* ours". A chip page is our page around somebody else's
      photographs, and the section only ever describes our deploys, so it is
      honest there. A wiki article is a *rebuilt third-party document*, and a
      note on it saying it "changed" reads as being about the article. The
      harness asserts a sampled article is slot-free and a sampled chip page is
      not, and drives the chip page at depth 2, where its hrefs are
      `../index.html` for the collection and `../../index.html` for the
      overview -- computed from `depth`, which is why they are right.
    - **The mirror under `full/` does NOT carry it, and now cannot quietly start
      to.** `full/` is a symlink into the byte-exact copy of visual6502.org: no
      builder writes those files, they are the original site's own HTML served
      exactly as captured, and this file already records that they keep no
      header for that reason. A changed-since note there would edit the
      preserved copy and would claim change on pages whose whole meaning is
      that they have not changed since 2010. It was asked for, considered, and
      declined with the reasoning stated; the honest alternatives (a wrapper
      page of ours in front of the mirror) were offered and not taken. The
      section already appears on every page this archive *built*, which is
      every page that can carry it truthfully. `_archive-changed-test.html`
      fetches a mirror page and asserts it is free of the section and of every
      other mark this archive adds, so a builder that started rewriting the
      mirror would fail the harness rather than break the preservation silently.
    - **JSSim in particular is untouched, and is now guarded by name.** It was
      asked for after the wrapper page and declined for a stronger reason than
      the landing page: `full/JSSim/` is the original 2010 simulator, and
      `segdefs.js` and `transdefs.js` beside it are **the die data every polygon
      on this site is built from**. Injecting a section means rewriting Greg
      James's HTML in the die data's own directory, and `expert.html` boots a
      running program on load that the injection could break. The honest place
      for our note is `mirror.html`'s JSSim card, which is ours. The harness
      now fetches `full/JSSim/expert.html` and `segdefs.js` specifically -- a
      check that only sampled the landing page could pass while JSSim had been
      edited -- and asserts the copyright notice, the array, and no chrome.
      - **The first draft asserted `var segdefs = [` at byte 0 and would have
        failed on the untouched file**, reading as an edit that never happened:
        the file opens with the authors' copyright notice. That notice is the
        better invariant regardless, being the attribution. Check what a file
        actually starts with before asserting it.
    - **`mirror.html` is the page in FRONT of the mirror**, built by
      `build-archive.py`, and it is where the entry points now go: the menu's
      "Original site" and the overview's "Open the mirror". It says what the
      mirror is, that it has **no way back** (its pages carry the original
      site's navigation and nothing else, because adding ours would mean
      editing them), and offers three counted doors in -- JSSim, the documents,
      the front door -- with the counts computed from the mirror rather than
      typed. It carries the changed-since note honestly, being ours. The mirror
      behind it is asserted byte-identical to its source.
      - **Deep links are NOT diverted through it.** A photograph's
        full-resolution original stays a direct `../full/images/…` link,
        because a reader who clicked a picture wants the picture, not a page
        about the archive. Asserted on a chip page's `class="dl"` links.
      - **The overview's inline chrome became a `page()` helper** the moment a
        second page of ours needed it. Two inline copies of a head and footer
        is the copy that drifts.
      - **Two harness assertions were wrong before the page was**, both in the
        same way. "No `mirror.html` anywhere on a chip page" failed on correct
        behaviour, because the header menu now points there from every page.
        And keying the photograph check on `class="orig"` would have failed
        vacuously on a chip with no description page beside its images; `dl`
        is the per-image link and is on every chip page. **A negative has to be
        aimed at the thing it means, and a positive has to be present on the
        sample it runs against.**
    - **The slot is placed by each page's BODY, after the h1 and lede, never by
      `shell()` before the body.** The first version had every builder's
      `shell()` emit it, and it landed above the title everywhere: a reader
      opening a chip page met a deploy notice before the name of the chip.
      Measured across the five pages by document order, then fixed in each
      builder. Asserted on the chip page: `h1 < lede < slot < banner`.
    - **It is an aside, not a panel, and that took two rounds because it has
      to work in two surrounds.** On the gallery it sits directly above the
      attribution banner, which *is* a panel (2px rule, hard shadow, the
      licence compliance); a second bordered box a hair beneath it read as two
      peers fighting. So: no box, no shadow, a left rule. But on the overview
      that same left rule sat directly under a callout ruled in the accent
      colour, and two left-ruled asides one above the other read as *one
      quotation* -- the note looked like the callout's last paragraph. The rule
      is solid gold, its own signal, with a top margin larger than the gap
      inside any of the archive's own blocks, so it breaks rather than
      continues. **Look at every surround a shared style lands in; fixing one
      collision made the other.**
    - **The harness re-ran itself forever, and it looked exactly like a
      headless hang.** The whole test lives inside `f.addEventListener('load',
      …)`. Checking the sub-indexes means navigating that same iframe, and
      each navigation fires `load` again -- which re-entered the entire handler
      from the top, which navigated again. No title, no output, `--dump-dom`
      never returning: indistinguishable from the Chrome hang this file already
      documents. **Two hypotheses were tested in isolation and "disproved"
      precisely because isolation removed the persistent handler.** The fix is
      `{ once: true }`, and the lesson generalises: a harness that navigates
      its own iframe must not be *triggered* by that iframe's load.
    - **`archive-deploy.sh` now excludes `_*`.** `rsync -a --delete
      archive/public/` copies *everything*, so a harness left in that directory
      would have shipped -- and the first draft of the harness's own comment
      claimed the opposite. `build-web.py` protects the simulator by naming
      what it copies; nothing had protected the archive. Proven with a dry run
      with the harness present: zero would publish.
  - **The `.vf-changed` rule lives in `shell.CSS`, once.** The three builders
    each carry their own copy of the other footer rules already, which is
    exactly the duplication that let ten nav lists drift; a fourth copy in
    three places was not the answer. All three emit `own CSS + shell.CSS`, so
    one rule reaches all three stylesheets, and the tokens it names (`--fg`,
    `--gold`, `--muted`) were checked to exist in each before relying on them --
    a `var()` naming a missing token drops the declaration silently.
  - `_menu-test.html` asserts the footer agrees with the dots, that the diff
    link names both commits, and that the separator's computed `::before`
    content is a real `·` -- the check that would have caught the `␀b7` escape
    below the first time.
- **The elapsed time is computed on the client, and that is the point.** This
  site is served from content-hashed, long-cached files precisely so pages are
  *not* regenerated; a relative time baked into HTML is wrong within the hour.
  Only ISO timestamps are stamped. It re-ticks every 30s so a tab left open does
  not keep claiming it shipped a minute ago.
- **`build-info.json` bypasses `emit()` in `build-web.py`**, so it never enters
  the service worker's precache. Everything else is immutable-by-hash and safe to
  cache forever; this is the one file whose whole job is to reflect the deploy
  that just happened, and a worker serving it cache-first would make the footer
  lie.
- **`import.meta.url` resolves `build-info.json`**, not a page-relative path. The
  archive nests pages two deep and ships its own stamp, so the script has to be
  self-locating.
- **No inline script.** The CSP is `script-src 'self'` with no `'unsafe-inline'`.
- Use a **literal `·`**, not `content:"\00b7"` — a short CSS escape is only
  unambiguous when what follows cannot be read as another hex digit, and the
  parser took the leading `\0` as NULL, rendering `␀b7`. The DOM check passed
  clean: the text was right and the escape lived in a `::before` rule, so only a
  screenshot could catch it.

## The transport (`chip-controls.js`, `chip-nav.js`)

Whether the chip is running, and how fast, live in **one store**, and the site
header is its primary view. Four pages ran the chip and each carried its own
copy: three different transports, two speed lists with different steps, and the
exploded view with no rate control at all — so "the same program at the same
speed on two pages", which is the reason several of those pages exist, was not
something the site could do.

**The rate is the simulated clock in Hz, paced against wall-clock time.** Every
one of those old numbers was *half-cycles per animation frame*, which is a fact
about the browser rather than about the chip: the same setting ran at a
different rate on a 60 Hz display, a 120 Hz display, and the software rasteriser
the headless checks use. Hz is what the readouts were already trying to report.
A cycle is two half-cycles, so 1 Hz is two half-cycles a second.

- **One setter per thing, every control a view.** `setRunning`, `setClock`,
  `step`, `reset`; controls repaint from `subscribe()`. Same arrangement as the
  program picker's `choose()`, for the same reason.
- **`?speed=` is now in Hz**, and still beats the saved value, which still beats
  the slowest step. Same precedence as `?program=`.
- **The header slot stays empty on a page with no chip.** Decode and Timing are
  tables of 768 recorded runs; a run button there would have nothing behind it.
  `.nav-chip:empty { display: none }` collapses it, and `_chipnav-test.html`
  asserts both directions — every chip page has one, no measurement page does.
- **The pacing clamp is 500ms, not something tighter.** It stops a backgrounded
  tab returning and running a million half-cycles in one frame, but a clamp
  shorter than a frame silently caps the rate — and the software rasteriser
  manages 2–5 fps, so the page would then be slower than the control says.
- **The study view keeps a clock select of its own**, because it is fullscreen
  and there is no header to reach. Same store, so they cannot disagree. Its
  4/s pacing is gone: that existed only because the page had no rate control.
- `demos.js`'s `createChip` registers *itself* as the driver, so the primer's
  five examples and the programs page's run panel are driven by the header too.
  `setupChipNav()` is then called with no argument.
- **The driver says what it can do, and one chip crosses the pages**
  (2026-08-26, for the strip on tinymachines.ai, which is the store's other
  view). `chip-machine.js` builds the driver for any page that runs a wasm
  Machine: `caps`, `sync`/`op` (the next fetch, `stepInstruction`), `earliest`
  and `seek` (the Machine's rewind window, forward by running), `power`.
  The store gained `driverCaps()`, `isPowered()`/`isBooting()`/`setPower()`,
  `stepOp()`, `seek()`, `chipEarliest()`/`chipLength()`, and honours
  `registerDriver(null)`. Off refuses to run or step and is written to
  `sessionStorage` (`v6502.power`) so the next page opens off. A store with
  no driver still runs, because halfshot paces its recording off it without
  registering one. `adopt(m, program)` restores the machine the previous
  page left (its own `exportMachine()` in `sessionStorage`, same program
  only) and arms `pagehide` to leave one; a deep link that names a
  half-cycle (`?steps=`) forgets it first, since the link is where you are
  being sent and the snapshot is where you were. Eight pages hand the store
  `chipDriver(m, { reset, after })` instead of four methods each. Not yet on
  the store: the Lab (its own player, its own `POWER`), halfshot (no driver),
  trace.js (a private `setRunning`). `_chipnav-test.html` section 1b holds
  all of it against a fake Machine, and the wiring half proves the count
  survives a page load.
- **The API engine, and the switch** (2026-08-26, one-engine step 3 on the
  roof). The store holds `engine` (`local` | `api`, `?engine=`, then
  `localStorage` `v6502.engine`; `setEngine` stops the chip first) and the
  API's measure (`noteEngine`, `engineLatency`, `engineError`). In API mode
  `halfCyclesFor(now)` gives the page's own loop nothing and the runner in
  `chip-machine.js` asks as `'api'`, so one caller takes the rate. The
  driver's `step`, `op` and the runner's `pump` export the Machine whole,
  POST `/v1/step` (`half_cycles`, or `until: instruction`), and import the
  answer into the same Machine, so every page draws unchanged; `caps` is a
  function now and refuses `back` and `seek` on the API, which keeps no
  history. A failure stops the chip and reports why. The API base is the
  page's `[data-chip-api]`, else this origin. The tracer's own step records
  fetches locally and defers to the base on the API. `_chipnav-test` 1c
  drives it against a fake `/v1/step`.
- **The rate control blinks on the chip's own phase.** `.tick` is held while
  the half-cycle count is even, so it goes on and off once per *cycle* — which
  is what a cycle is here, two half-cycles. It reads `halfCycle()` back off the
  driver rather than running from a timer: a timer would keep blinking after
  the chip stopped and would go on claiming a rate the machine was not
  delivering, which on the software rasteriser is routinely a different number
  from the one requested. Applied from the subscription *and* from a frame
  loop, for the same reason every other discrete action here is.
- **The buttons are sized with `width`/`height`, not `min-*`.** With `min-*` the
  glyph decides the shape and three buttons come out three different widths.
  36px square, over the 30px `_navfit-test.html` insists on for a tap target.
- **`programs.js` carries a `short` name, used only by the header picker.** The
  full name goes everywhere with room for it, and rides on the option's
  `title`. A name clipped mid-word is worse than a shortened one: the reader
  cannot tell which program is selected, which is the one thing the control is
  for. `_chipnav-test.html` measures the rendered text against the control's
  width rather than counting characters, because the font is not the harness's
  to know.

**A discrete step must apply immediately, and the explorer was not doing it.**
Its panels only repainted inside the frame loop, so a step landed on the next
animation frame. That is a real responsiveness bug on its own and it is
invisible until the page is driven somewhere frames are throttled — which is
what an iframe does, and how it was found. `syncToChip()` is now called from the
frame loop *and* after every discrete step. The schematic and the study view
already worked this way; this is the third time this exact bug has appeared here.

**Rate is measured, not read back off the control.** The explorer's readout
counts half-cycles over the window and divides. What the setting asks for and
what the machine delivered are two different claims, and on a slow GPU they are
two different numbers.

**Speed defaults to the slowest step everywhere.** At anything faster the die is
a flicker and the registers are a blur; the point of a transistor-level view is
watching one edge happen.

**`web/package.json` is not shipped.** It exists so node reads `web/*.js` as ES
modules, which is what lets `tools/check-programs.mjs` assemble every program
headlessly in the deploy — the only guard here that does not need a browser.
`build-web.py` copies only the files it names, so it cannot reach `dist/`.

### What putting a `<select>` in the header cost, and what it taught

Two layout bugs, both invisible to every harness that existed, and the shape of
each is worth more than the fix.

- **A flex item that shrinks to nothing does not overflow, and that is worse.**
  The picker is `flex: 0 0 auto` because without it the header *looked* correct
  at every width while the control had collapsed to **22px** — the layout
  absorbed the problem and handed the reader an unusable widget. Meanwhile the
  header really was overflowing by 88px at 1280 and 359px at 992. So
  `_navfit-test.html` asserts both halves: the header must fit, *and* the picker
  must stay wide enough to read a program name in. Either assertion alone passes
  while the other is broken.
- **`_overflow-test.html` could not have caught it.** It checks 320px, where the
  nav links are behind the disclosure menu — so the row that overflows is not on
  screen. Every desktop width had gone unchecked for the life of the project.
  The links now go inline at **80rem rather than 62rem**, because 62rem was set
  when the row was shorter and the header carried a 90px button.
- **Write the breakpoint for the devices, not for the round number.** The narrow
  rules were at `max-width: 24rem` — 384px — so a **390px phone**, the most
  common width there is, fell through all of them and overflowed its header by
  29px. It is 34rem now. The old rule had been there since before this work and
  was never wrong for the 320px case it was written and tested against.

## "Run it" runs it

**"Run it" runs it.** The hero button points at `#explorer`, so the browser does
the scrolling and `app.js` only has to start the chip on click — every
`a[href="#explorer"]` is wired to `setRunning(true)`. The header's copy of that
button is now the program picker (see the Programs section); the sub-pages'
`?run=1#explorer` link went with it, because on those pages choosing a program
*is* the way in. `_handler-test.html` asserts the hero click, and that the two
program controls on the Explorer cannot disagree.

