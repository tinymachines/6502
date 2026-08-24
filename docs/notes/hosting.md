# Hosting, deploy and the repository

How the site is published and what fails silently when it is not. Split out of `CLAUDE.md`. Operator-specific detail (addresses, zone paths, the runbook) lives in `deploy/HOSTING.local.md`, which is deliberately not in version control.

## Hosting — https://6502.tinymachines.ai

Live on this box. Entirely static; there is no application process.

| Piece | Where |
|---|---|
| Deploy script | `deploy/deploy.sh` |
| systemd unit | `deploy/6502-deploy.service` → `/etc/systemd/system/` |
| API service | `deploy/6502-api.service` → `/etc/systemd/system/`, enabled: uvicorn on 127.0.0.1:6502 behind the `/api/` proxy location |
| Halfwave Lab | <https://halfwave.tinymachines.ai> — `deploy/halfwave.tinymachines.ai.nginx` + `deploy/halfwave-deploy.sh`: the reviewer's package at `docs/halfwave-lab/` (template + `build.sh`, reproducible byte for byte), its built `halfwave-lab.html` served as index.html, with its own `/api/` proxy to the same engine so `location.origin + "/api"` just works. DNS in both split-horizon views; cert via the same webroot flow. Engine-side answers live in `docs/findings-answers.md`, NOT in the package's findings.md, which the reviewer's export tool overwrites wholesale |
| nginx site | `deploy/6502.tinymachines.ai.nginx` → `sites-available/` (symlinked) |
| Served from | `/var/www/6502.tinymachines.ai/current` (symlink into `releases/`) |

**`scripts/deploy.sh` is the orchestrator, and it orchestrates rather than
rebuilds.** The build is `deploy/deploy.sh` run through its own unit, so it
gets that unit's environment and its 1800s timeout instead of the invoking
shell's; anything this script knew about building would be the second copy that
drifts. What it adds is the ORDER and the AFTERWARDS: preflight (uncommitted
changes, unpushed commits, and which of the three SKIP-able checks will
actually run), the unit, the API restart, then a verify against the live site.

- **The verify reads the numbers from the build, never from itself.** The
  container count comes out of `web/groups.json`, so the script cannot become a
  second place that knows how many containers there are. It compares live
  commit against HEAD, `no-cache` on `/`, the CSP, the manifest MIME and
  `immutable` on a hashed asset.
- **The manifest and the hashed asset are found by reading `/`, not by
  guessing a path.** `build-web.py` content-hashes both, so there is no bare
  `/manifest.webmanifest` to ask for: the first version asked anyway, got a 404
  and reported it as a wrong MIME type. A checker that is wrong about where a
  file lives reads exactly like a site that is broken.
- `--verify` alone is read-only and is the fastest way to answer "is what is
  live what I think is live".

```bash
sudo systemctl start 6502-deploy      # rebuild + publish
journalctl -u 6502-deploy -n 40       # what it did
```

The deploy builds the wasm and geometry, sanity-checks the artefacts (including
`layout.bin`'s magic — a truncated blob still "loads" and then renders nothing),
publishes into `releases/<timestamp>/`, precompresses with `gzip -9`, and swaps
the `current` symlink atomically. Keeps 3 releases; roll back by repointing the
symlink. The unit is installed but **not enabled** — it is a deploy action, not
a boot service.

After editing anything in `deploy/`, copy it to the system location; the repo
copy is the source of truth but is not read live. **The nginx site installs as
`/etc/nginx/sites-available/6502.tinymachines.ai.nginx` — with the `.nginx`
suffix**, which is what `sites-enabled` symlinks to. Copying to the name without
it creates a second, unreferenced file: `nginx -t` passes, the reload succeeds,
and nothing changes. Check the symlink target rather than the directory
listing.

## Load-bearing details

- **Precompression is required, not an optimisation.** `gzip_types` is commented
  out in this deployment's `nginx.conf`, so runtime gzip covers only `text/html` — the
  1.5 MB `layout.bin` would ship raw. `gzip_static on` serves the `.gz` files the
  deploy writes. Result: 1.5 MB → 449 KB, wasm 107 KB → 50 KB.
- **CSP needs `'wasm-unsafe-eval'`** in `script-src`, or the browser refuses to
  instantiate the module and the page boots to a blank canvas. Everything else is
  `'self'`; there are no external resources.
- **No `add_header` inside any `location`.** nginx does not merge `add_header`
  across levels: a location containing *any* `add_header` discards every
  inherited one. Setting Cache-Control per-location silently dropped the CSP and
  HSTS from the HTML document. Cache-Control now comes from a `map` into a
  variable so every header is declared once at server level.
- Assets are not content-hashed, so everything revalidates (`max-age=60,
  must-revalidate`; HTML `no-cache`). Deploys take effect immediately.
- **The `immutable` map keys on the hash segment, not the extension.** It reads
  `\.[0-9a-f]{8}\.(?:js|css|wasm|bin|png|svg|json|webmanifest)$`. `json` is in
  that list for the derived blueprint and is safe *only* because the hash
  segment is required: `build-info.json` has none and keeps the short cache,
  which is the entire point of it. Matching on extension alone would make the
  version footer report whatever it said an hour ago.
- **Every page answers to its bare path** (`/schematic`, `/blueprint`, ...) via
  `try_files $uri $uri.html $uri/`. `$uri` first so a real file always wins;
  `$uri.html` before `$uri/` so a page beats a same-named directory, which is
  the ordering that already bit the archive. The `.html` form keeps working, so
  nothing that links to it breaks.
  - **Two other things must change with it, and both fail silently.** The
    Cache-Control map keys on `\.html$`, so a bare path would fall to the
    60-second default and a deploy would take a minute to appear on exactly the
    URLs the site advertises — hence the `~^/[^.]*$` rule, which matches "no dot
    in the path" rather than listing pages, so a new page cannot be forgotten.
  - **And the service worker caches by file, not by route.** `/schematic` is not
    in the precache list (`/schematic.html` is), so offline the first lookup
    misses and the navigation fallback would serve `SHELL` — the *explorer*,
    under the schematic's URL. The fallback now tries `<path>.html` before the
    shell. Verified by loading with a warm profile against a dead IP: the
    schematic and the blueprint each come back as themselves.
- **`/archive/` is an `alias` beside `releases/`, not inside a release.** It is
  ~2.5 GB that changes only when something new is recovered, so copying it on
  every front-end deploy would be absurd. That location declares no `add_header`
  either, for the reason above; its Cache-Control comes from the same `map`, with
  a week for `/archive/(full|gallery/(thumb|view))/`. `autoindex` stays off: the
  collection is meant to be browsed through pages that carry attribution, not a
  bare directory listing. nginx follows the `full` symlink out of the alias root.

## DNS and TLS

The site is served from a self-hosted box. Point an A record at it, then issue a
certificate with `certbot certonly --webroot -w /var/www/html -d <host>`. If the
nameserver uses split-horizon views, the record has to be added to *every* view,
and `rndc reload <zone>` fails with "found in multiple views" — reload the whole
server instead.

Operator-specific details (addresses, zone paths, the local runbook) live in
`deploy/HOSTING.local.md`, which is deliberately not in version control.

## After any nginx or deploy change

Load the **live** URL headlessly, not a local server — see "Verifying in a
browser, headlessly" above for the invocation. That is the only thing that
exercises the real TLS, CSP, MIME types and cache headers together, and a CSP
mistake produces a blank canvas rather than an error.

Then confirm the headers directly, because a wrong one is invisible in a
screenshot:

```bash
curl -sS -D- -o /dev/null --resolve 6502.tinymachines.ai:443:<addr> \
  https://6502.tinymachines.ai/<path>
```

Expect `no-cache` on `/`, `index.html` and `sw.js`; `max-age=31536000, immutable`
on hashed assets; `application/manifest+json` on the manifest; and the CSP
present on *every* response, including assets.

## Repository

Public at <https://github.com/tinymachines/6502>, pushed as `isenbek`. `main` is
the simulator; `legacy-rag-agent` preserves the unrelated Python project that
previously occupied the repo (also still in `../6502-prev`).

```bash
git clone --recurse-submodules https://github.com/tinymachines/6502
git submodule update --init      # if cloned without --recurse-submodules
```

Before pushing anything, two things worth keeping true:

- **Do not commit host-specific detail.** Addresses, zone paths and the local
  runbook live in `deploy/HOSTING.local.md`, which is gitignored. The public docs
  keep the transferable engineering lessons only. This split exists because
  CLAUDE.md previously documented an internal LAN address and a security
  weakness on the host.
- **Nothing generated is committed** — `target/`, `dist/`, `web/pkg/`,
  `web/layout.bin`, the golden trace. A fresh clone must build; verify with a
  real `git clone` into a temp directory and `cargo test --workspace`, which is
  how the "test fails out of the box" bug was found.
