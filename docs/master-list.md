# Master list (built 2026-10-16)

Every idea and to-do the projects have collected, in one place, with the
finished ones ticked. Gathered from `docs/todo-next-session.md`, the
GitHub issues of every tinymachines repository, nes-bench's
`docs/open-items.md` and `docs/exercise.md`, and the session memory.
Where a source holds the detail, the line names it; this file is the
index, not the record. Tick a line here when its source closes.

## The NES bench (nes-bench)

### The regime (`docs/exercise.md`)

- [x] E0: the regression with both hands (rig-check, bench-check, the head's reset and power).
- [x] E2: a game's title reached by script and scored (2026-09-18, Duck Hunt's field 2026-09-19).
- [x] E3: a hand's play logged, replayed on the part and the model, no divergence (2026-09-19).
- [ ] E1: the closed cycle on the calibration cartridge, terminated (the cart now runs on the part; the scored bars capture is what is left).
- [ ] E4: a hundred scripted power-ons with the master clock on the scope's spare channel; reset hold; audio scored.
- [ ] E5: the steps from a list, nightly, one report.

### Programmes

- [x] Programme 1: the knobs file (2026-09-18).
- [ ] Programme 1: knobs set from measurement (waits on E4).
- [x] Programme 3: the x-ray diff, the encyclopedia (seven entries), the Mario dissection (2026-09-18).
- [ ] Programme 2: screens and the search over episodes (proposed only).
- [ ] More encyclopedia entries and more games dissected.
- [x] PLAN: Super Mario Bros. 1-1 cleared on the part by a schedule searched on the model (2026-10-17, nes-bench c9a8ddc, nes 11c242e).
- [x] PLAN on saved states, 1-2 cleared on the part to WORLD 1-3 with no life lost (2026-10-17, nes 46eeca2, nes-bench f92b780); death codes measured (0B, 06).
- [x] PLAN 1-3 cleared on the part, power-on to WORLD 1-4 with no life lost (2026-10-18, run 20261018-012133).
- [x] PLAN 1-4 cleared on the part, power-on to WORLD 2-1 with no life lost (2026-10-18, run 20261018-021108).
- [x] PLAN 2-1 cleared on the part, power-on to WORLD 2-2 with no life lost (2026-10-18, run 20261018-023103, 258 entries).
- [x] Streaming: the UNO's schedule a ring fed by the head during the run, no 600-entry wall (2026-10-18, nes-bench 8f35ed6; on the part, run 20261018-024952, 200 entries streamed, 11,623 polls gap-free and none wrong).
- [x] Swimming moves for 2-2, measured on the model (nes-bench 4d7dd9f).
- [x] PLAN 2-2 cleared on the part, power-on to WORLD 2-3 with no life lost (2026-10-18, run 20261018-031731, 370 entries).
- [x] PLAN 2-3 cleared on the part, power-on to WORLD 2-4 with no life lost (2026-10-18, run 20261018-034339, 404 entries).
- [x] PLAN 2-4 cleared on the part, power-on to WORLD 3-1 with no life lost (2026-10-18, run 20261018-040301, 435 entries).
- [x] PLAN 3-1 cleared on the part, power-on to WORLD 3-2 with no life lost, the first streamed run (2026-10-18, run 20261018-042415, 492 entries).
- [x] PLAN 3-2 cleared on the part, power-on to WORLD 3-3 with no life lost (2026-10-18, run 20261018-044744, 548 entries): ten levels in one schedule.
- [x] PLAN 3-3 cleared on the part with a beam search, power-on to WORLD 3-4 (2026-10-18, run 20261018-061315, 587 entries).
- [x] PLAN 3-4 cleared on the part, power-on to WORLD 4-1 with no life lost (2026-10-18, run 20261018-145621, 618 entries): twelve levels in one schedule. The first plan failed its straight replay: nes `branch` RUN stopped at a frame's end, so a two-poll frame made an AT late on the model; fixed (nes ecdb2d6), replanned.
- [x] PLAN 4-1 cleared on the part, power-on to WORLD 4-2 with no life lost (2026-10-18, run 20261018-162219, 662 entries): thirteen levels in one schedule.
- [x] PLAN 4-2 cleared on the part, power-on to WORLD 4-3 with no life lost (2026-10-18, run 20261018-234630, 730 entries): fourteen levels. Five plans failed; it taught the planner --no-ceiling, --beam-high, the A-held way on, --resume, and that a warp is a change to any but the next level. The last tall pipe was crossed by a route searched by hand on the model, from the beam's own state.
- [x] PLAN 4-3 cleared on the part, power-on to WORLD 4-4 with no life lost (2026-10-19, run 20261019-015500, 767 entries): fifteen levels. The beam crossed the mushroom tops and falling lifts on its own, nothing new needed.
- [x] PLAN 4-4 cleared on the part, power-on to WORLD 5-1 with no life lost (2026-10-19, run 20261019-065615, 796 entries): sixteen levels, the first maze. The planner reads the maze's checks out of the game and crossed the first on its own; the second's one-tile entry was searched by hand on the model and spliced on.
- [x] PLAN 5-1 cleared on the part, power-on to WORLD 5-2 with no life lost (2026-10-19, run 20261019-081032, 845 entries): seventeen levels. The beam crossed it on its own.
- [x] PLAN 5-2 cleared on the part, power-on to WORLD 5-3 with no life lost (2026-10-19, run 20261019-094241, 902 entries): eighteen levels. The beam crossed it on its own, above ground.
- [x] PLAN 5-3 cleared on the part, power-on to WORLD 5-4 with no life lost (2026-10-19, run 20261019-104805, 944 entries): nineteen levels. The beam crossed it on its own.
- [x] PLAN 5-4 cleared on the part, power-on to WORLD 6-1 with no life lost (2026-10-19, run 20261019-115112, 975 entries): twenty levels, five castles. The beam crossed it on its own.
- [x] PLAN 6-1 cleared on the part, power-on to WORLD 6-2 with no life lost (2026-10-19, run 20261019-130306, 1,015 entries): twenty-one levels. The beam crossed it on its own.
- [x] PLAN 6-2 cleared on the part, power-on to WORLD 6-3 with no life lost (2026-10-19, run 20261019-144503, 1,102 entries): twenty-two levels. The beam crossed it on its own, above ground.
- [x] PLAN 6-3 cleared on the part, power-on to WORLD 6-4 with no life lost (2026-10-19, run 20261019-160009, 1,138 entries): twenty-three levels. The beam crossed it on its own.
- [x] PLAN 6-4 cleared on the part, power-on to WORLD 7-1 with no life lost (2026-10-19, run 20261019-172628, 1,169 entries): twenty-four levels, six castles. The beam crossed it on its own.
- [x] PLAN 7-1 cleared on the part, power-on to WORLD 7-2 with no life lost (2026-10-19, run 20261019-191128, 1,214 entries): twenty-five levels. The beam crossed it on its own.
- [x] PLAN 7-2 cleared on the part, power-on to WORLD 7-3 with no life lost (2026-10-19, run 20261019-224836, 1,353 entries): twenty-six levels. The planner learned that a pipe passed stays passed (the water's exit pipe keeps its area number), resumed from its own state; nothing by hand.
- [x] PLAN 7-3 cleared on the part, power-on to WORLD 7-4 with no life lost (2026-10-20, run 20261020-002836, 1,393 entries): twenty-seven levels. The beam crossed it on its own.
- [x] PLAN 7-4 cleared on the part, power-on to WORLD 8-1 with no life lost (2026-10-20, run 20261020-015615, 1,423 entries): twenty-eight levels, seven castles. The six-check maze, passed by the beam on its own, never sent back.
- [x] PLAN 8-1 cleared on the part, power-on to WORLD 8-2 with no life lost (2026-10-20, run 20261020-042403, 1,519 entries): twenty-nine levels. The longest level in the game; the beam crossed it on its own in about two hours.
- [x] The plan log: PLAN's level sequence as a notebook page drawn from measurements (nes-bench docs/plan-log.md, tools/plan-log.py).
- [ ] Put the plan log on the roof's notebook (their pull list; asked in the roof notice).
- [ ] Tell the roof: bench-v1b-uno.md still describes the 600-entry limit (a pulled document; streaming changed it).

### Experiments on the part

- [x] The poll line, part against model (2026-09-18).
- [x] The vertical sync's first dot, the 0.6-line offset (2026-09-18).
- [x] The multicart menu ignoring Start after a cold boot (closed).
- [x] The split test with the warm-reset recipe, split-score's roundtrip (2026-09-19).
- [x] The triggered frame one picture late (2026-09-18).
- [x] Duck Hunt's field matching F-1 and F+1 (closed).
- [x] The luma miss on the lowest rows (2026-09-20).
- [ ] The part's picture a quarter dot right of the model's (a measurement).
- [ ] The colour phase is a neighbouring frame's: one frame left to explain.
- [ ] The model's hue against the part, 12 to 14 degrees on saturated colours.
- [ ] Where in a CPU cycle the console hands a cartridge its /IRQ (fitted, the fit is open).
- [ ] MMC3's A12 filter: dots against M2 falls (no ROM here can see it).
- [ ] A short reset pulse under the instrument's floor (needs the logic analyser).

### Hands and pads

- [x] Both hands under the head: power and reset (2026-09-18).
- [x] USB pad adapter on a host, a browser and an iPhone (2026-09-27/28).
- [x] BLE pad plays on an iPhone (2026-10-04).
- [x] One pad sketch for USB and BLE on the P4, the C6 updated in band (nes-bench#4, 2026-10-13).
- [ ] The pad through the bridge (bench items 4.2 and 5.2), and J2's lead order.
- [ ] The gamepad hand meets a gamepad (`head/pad.py` built, never fed a real pad).
- [ ] The hand's latency, press to key event.
- [ ] Buttons over BLE to the Pi, seen in a listener.
- [ ] Which change the iPhone needed: no report ID, or the clean pairing.
- [ ] nes-bench#6: the pad on a XIAO ESP32S3 with the 2000 mAh cell (drawings TM-NESB-004 rev A).
- [ ] A phone on legacy pairing (the P4's path).

### The calibration cartridge

- [x] C0 machine side (2026-09-13).
- [x] C1 machine side, `tools/cal.py` (self-test green, mutation red).
- [x] The cart runs on the part: second board, lockout defeated, strip read off the grabber (2026-10-03).
- [x] The gray screen, garbled tiles and wrong colours cured by reseating U3 (2026-10-09).
- [ ] C1 part side: scope records of the palette screen per variant.
- [ ] C0's mutation run, not just stated.

### Boards and drawings

- [ ] nes-bench#5: the NES bridge and the pad bridge exist only on breadboards (boards to have printed; discuss first).
- [x] v1c drawn and routed (2026-10-17, nes-bench 1904458..1ae7b27, pushed): v1b as an UNO shield with the hands on board, keyed KK-254 cables, a test point per probe; 0 unconnected, 0 clearance. `docs/bench-v1c.md`.
- [x] v1c ordered (2026-10-17): K1's NC metered on pin 4, five boards from JLCPCB, no enclosure; parts in `docs/bench-v1c-parts.md`.
- [ ] v1c built and bench-check green on it.
- [ ] The inverter's five spare inputs tied.
- [ ] The ribbon and breakout headers on the breadboard sheet.
- [ ] nes-bench#3: two documents still open with "Nothing here has been built".
- [ ] nes-bench#2: exercise.md prints two row ranges for $18.
- [ ] nes-bench#1: rig.md's reason for blurring the television.

### Instruments and the Pi

- [ ] Nothing on the sound card's input (an attenuator, then `EARS`).
- [ ] The Roxio module vanishes on a kernel update (re-run `loadmod` after any).
- [ ] Upstream the EM2980 id and the querystd fix.
- [ ] `tools/oscr-card.py` not written.
- [ ] The reader names a banked cart by 512 bytes; the Super Mario Bros. cart needs a re-read.
- [x] The reset hand stopped working (2026-10-16): OK1's output side rewired, OUT to orange, GND to yellow, VCC open; bench-check all green again (2026-10-17).
- [x] Injected bytes stopped reaching the console (2026-10-16): the 165 loaded and never shifted; R2 (CLK to its CP) sat one row off the blue lead. Walk 15 of 15 again (2026-10-17).
- [x] The scope was off the LAN (2026-10-16): DHCP off, AutoIP on; DHCP set over link-local from the Pi, back at its reserved address.
- [ ] The head stalls about three minutes with no log line when the scope is off (found 2026-10-16).
- [ ] The console misbehaves on its own: fails to start (2026-10-16 cold boot, run 20261018-020509) and restarted itself mid-run with a clean poll log (run 20261018-060411); retries run clean. Suspect the cartridge connector (the lockout chip resets on a poor contact).
- [x] Every feature exercised through the Pi (2026-10-17): E0 green; E2's title and Duck Hunt's field reached and scored (the September shape); E3's replay agrees with the model on 2301 latches; split, poll line, eyes and the x-ray as before.
- [ ] The warmth knob reads `runs/*/head.log` on the workstation, but the runs live on the Pi: a run not yet pulled reads as weeks warm (found 2026-10-17).
- [x] The Pi's nes-bench checkout brought level by git bundle (2026-10-17): head restarted, `pad` answers, a script played from the checkout.
- [ ] rig-check has no camera baseline on either machine (take one with `--baseline` once the rig is declared right).

### Pile (`docs/pile.md`)

- [ ] LITTLEGUY: which P4 board it is (`esp-reset LITTLEGUY --characterize`).
- [ ] HP-16C: cells in, then ADC/SBC carry and overflow at word size 8.

## The NES model (nes, 2a03, 2c02, ntsc-crt)

- [x] N0 to N8 built, the roof page live, gamepad (2026-09-06).
- [x] 8x16 sprites, DMC in DMA (2026-09-06).
- [x] All seven boards of the owner's twenty dumps built; nineteen of twenty draw.
- [x] The storyboard logs: VRAM, scroll, APU, mapper writes, the page's write log.
- [ ] nes#1: stream the screen off a server-run console (read RFC 4175 and VITA 49; prototype on palette indices).
- [ ] Re-board the console's record on the public site.
- [ ] The console's CPU on the fixed rung 3 once the pins move.
- [ ] Rerun the chip repositories' suites with their goldens required.
- [ ] A trace window instead of a whole run.
- [ ] The DMC address register disturbed by the collision on rung 0 (a logic-analyser item).
- [ ] ntsc-crt#1: close M4's real-recording gate.
- [ ] 2c02#1: leg_voltage's comment names the wrong leg.

## The 6502 site and engine (6502)

- [x] Engine ladder rungs 0 to 3, GPU, Swarm, all live (2026-09-01).
- [x] Windows of a record, console overlays on the Halfshot page (T0 to T3, 2026-09-13).
- [x] #9 and #12: the registry API and CORS for the roof (closed).
- [x] #14: games ?power=1 (closed).
- [ ] #1: a JS/WASM sandbox for halfphi.
- [ ] #2: eleven block pages have no written half.
- [ ] #3: depend on halfphi instead of keeping a second copy.
- [ ] #4: no CI.
- [ ] #5: tap slop never verified on a device.
- [ ] #6: mobile GPU performance unmeasured.
- [ ] #7: no screenshots in the manifest.
- [ ] #8: the trace's preamble is fixed.
- [ ] #10: CORS on the static assets, so the explorer can move under the apex.
- [ ] #13: two untracked drafts still say "halfscore".
- [ ] The wall live-check on a real-GPU browser; the node-to-micro crossing; keep or drop the rung 2 console.
- [ ] Perf: active adjacency on toggle (the next lever on the list).
- [ ] Halfshot UI ergonomics (parked); the yellow-button report (unreproduced).
- [ ] Find the "gh issues / 6502 project" (`gh auth refresh -s read:project`).

## The roof site (public, tinypeek)

- [x] Game lessons: static screens, backgrounds, physics and the rest, twenty-five live.
- [x] #5, #6, #7: the crawl faults, the tm deploy, the lessons' game keys (closed).
- [x] tinypeek ideas: transclusion, one time axis, sets, trails, hosts that are not machines (closed).
- [ ] public#1: tool pages claim Japanese while serving English.
- [ ] public#2: three pages just above the translation floor.
- [ ] public#3: /docs/6502/two-ways-in has no Japanese body.
- [ ] tinypeek#20: tinyhelper on the box, fronted on the site.
- [ ] tinypeek#21: ?at= on the entity mount.
- [ ] The MCP/URI tool for an addressable, multimedia NES knowledge pool (the owner's, more to come).
- [ ] A final UI and ergonomics sweep.

## Lessons to write (the owner's list, 2026-10-09)

- [x] Using an Oscilloscope for Software Developers (live).
- [ ] Read the schematic before the wire (the CAJOE's INT behind 470 k).
- [ ] A datasheet in ten minutes (the optocoupler's four numbers).
- [ ] Debugging from a picture (one wrong colour named A3).
- [ ] Devices that move (USB names, udev, a daemon active with a dead thread).
- [ ] The serial port that resets the chip (DTR and RTS on open).
- [ ] Isolation is a property of grounds, not of parts.

## The TRNG (geiger)

- [x] The CAJOE counts: the tap on Q3's collector, emitter-0.2 (2026-10-10).
- [x] Hotbits served again from the bench Pi as trng.local (2026-10-10).
- [x] Every monitoring unit back on the emitter's data (2026-10-11).
- [x] Rev E and rev F of TM-TRNG-001 (2026-10-13).
- [ ] A day of real counts against the 2026-06-21 report.
- [ ] Min-entropy by hand past a million bits.
- [ ] A dedicated Pi with a fixed address, or a name the firmware can use.
- [ ] Pull the retired Pi's SD card (the 44M-row record).
- [ ] The bench pages, step 2 ("The counter board, read from its schematic" first).
- [ ] geiger#5: one falling edge per count; why the capture counted more than the hardware tally.
- [ ] geiger#4: CORS on the refusals.
- [ ] geiger#1: report.md and stats.json over HTTP.
- [ ] Redesign the Geiger circuit around an ESP (TLP2361-class opto, no 555 in the timed path).
- [ ] Order: the fast opto (two), and an isolated 5 V module if the PSU feeds the CAJOE.
- [ ] Small: `explore.py` reads one column; one Pi test fails outside a repository; journald-persistent; a stray `pi_time.txt`.
