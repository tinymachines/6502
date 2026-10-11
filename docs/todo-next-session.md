# To do next session (written 2026-10-06, updated 2026-10-10)

## Where it stopped, 2026-10-10: the CAJOE counts, hotbits has a bench page

Item 1 of the owner's list below is done in substance.

- **Real counts flow.** The tap is module INPUT + on P3 pin 2 (5V) and
  INPUT - on the collector end of R19 (metered 467 k). The build lives
  in a cigar box now, not the steel case. `emitter-0.2` on the C6,
  8.65 counts a second, `missed` 0. geiger is pushed at b5f361b.
- **Two finds, both in geiger `docs/HARDEN-PLAN.md` (2026-10-10
  section).** The emitter stalled with no reader on its USB port (fixed
  in 0.2). Each count makes about two falling edges; the extraction
  holds off emitter edges for 1 ms (`MUTATE_HOLDOFF=1` red), and the
  hardware cure is <https://github.com/tinymachines/geiger/issues/5>.
- **The bits file was reset** to real counts only; the old files sit in
  the emitter data directory under `reset-20261010/` and can go.
- **/hotbits/bench is live** (<https://tinymachines.ai/hotbits/bench>),
  shelved like /nes/bench. The plan for its 18 pages is geiger
  `docs/HOTBITS-BENCH-PAGES-PLAN.md`; the roof session did step 1 and
  waits for the first geiger page (step 2: the nine ready ones, house
  style and host names fixed in geiger's source). New pages may ship
  with the untranslated notice (owner's decision).

Next on this thread, in order:

1. A day of real counts; compare the rate and the health verdicts with
   the 2026-06-21 report.
2. Point the analysis and the API at the emitter's data.
3. Rev E of TM-TRNG-001 (sheet 3: the R19 tap, the cigar box, whether
   isolation still holds), then tell the roof session so the bench page
   drops its rev D note.
4. Step 2 of the bench pages. *The counter board, read from its
   schematic* is the one to write first.
5. Issue 5, and why the capture counted more edges than the hardware
   tally while `missed` read 0.

Do not open the C6's serial port casually: it resets the chip and
starts a new session on the receiver.

## The owner's list, 2026-10-09, in their order

1. **Finish the CAJOE.** Ready now: the tap on Q3's collector, below.
   Direct links: the CAJOE v1.1 schematic
   (<https://github.com/SensorsIot/Geiger-Counter-RadiationD-v1.1-CAJOE-/blob/master/Sch__Geiger%20Counter%20Kit-v1.1.pdf>),
   the TLP785 datasheet
   (<https://sy-dep-epc-lpc.web.cern.ch/components/datasheets/epc-lpc%20(converters)/TLP785-Optocoupler-Toshiba.pdf>),
   geiger `docs/HARDEN-PLAN.md` (the 2026-10-08 section), and the
   published drawing (<https://tinymachines.ai/hotbits/geiger-TM-TRNG-001-revD.pdf>,
   whose sheet 3 still wires INPUT - to VIN).
2. **Lessons.** More articles in the shape of "Using an Oscilloscope for
   Software Developers" (geiger `docs/articles/`, live at
   <https://tinymachines.ai/docs/nes/oscilloscope>). Candidates drawn from
   this week's bench, each with a real failure at its centre:
   - Read the schematic before the wire: the CAJOE's INT pin sat behind
     470 k, and two days of wiring could never have worked.
   - A datasheet in ten minutes: the four numbers that decide an
     optocoupler (forward voltage, CTR, saturated CTR, switching), and the
     indicator LED in series that the module never mentions.
   - Debugging from a picture: one wrong colour (white as green, red as
     black) named a single address line, A3, on the tile chip.
   - Devices that move: USB names that change on replug, udev symlinks,
     and a daemon still "active" with a dead thread inside.
   - The serial port that resets the chip: DTR and RTS on open.
   - Isolation is a property of grounds, not of parts: the probe's clip,
     the shared supply, what an opto actually separates.
3. **Board designs to have printed.** The NES bench / bridge (the UNO
   bridge, the pad shift registers, reset and power), and the USB/BLE
   gamepad (the XIAO ESP32S3 plan). Discuss first, then lay out.
   Alongside: **redesign and simplify the Geiger circuit** around an ESP,
   choosing the parts together (tube supply, detector transistor, a fast
   opto with a 3.3 V logic output such as the TLP2361, no 555 stretcher
   in the timed path).
4. **An MCP/URI tool for an addressable, multimedia NES knowledge pool.**
   The owner is working on it; more to come before anything is built.
5. **A final UI / ergonomics sweep.**

## The NES bench, 2026-10-09

- The bench head (`nes-bench-head` on the bench Pi) had lost the UNO when
  it was replugged (its pump thread died at 15:01 and the unit stayed
  "active"): restarted, bridge v1b answers in PASS. Restart it after any
  UNO replug.
- The cal cart: gray screen, then garbled tiles, then wrong colours, all
  three cured by reseating. The last was CHR A3 (U3 pin 9) not reaching
  the chip: white read as green, red as black. After the reseat the strip
  reader read 24 of 24 fields and the palette screen scores |dY| at most
  0.10, hue median -7.5 deg (the grabber's decode). U3's socket and the
  cart's seat are the first suspects for any new fault.


## The TRNG emitter (geiger, `docs/HARDEN-PLAN.md`)

**Where the bench stopped, 2026-10-08: the CAJOE gets a wire.** The
fault was never the opto. On the CAJOE v1.1 schematic, P3 pin 3 (INT,
the "VIN" of every earlier note) hangs off the detector transistor Q3
through a 470 k resistor (R19), so it can pass about 5 uA: no opto on P3
can ever light. P3 is pin 1 GND, pin 2 5V, pin 3 INT; the pink lead had
been on pin 1. The scope proved the detector good (INT drops from 2.3 V
to 0 V for about 210 us per count). Full account, with the opto's
datasheet numbers, in geiger `docs/HARDEN-PLAN.md`, "Where it stands,
2026-10-08". The owner is fine with modifying the CAJOE.

1. **Tap Q3's collector** (the lower end of R18, 47 k): module INPUT +
   to P3 pin 2 (5V), INPUT - to the collector; about 2 mA through the
   LED on a count, full rate, the tube's own 210 us pulse. The CAJOE
   unplugged and its high-voltage side discharged before soldering.
   The fallback is the module in place of the board's LED D23: it works,
   but its 555 holds each pulse 52 ms and drops about a third of the
   counts.
2. **Output side unchanged:** OUT to GPIO18, module GND to ESP GND,
   4.7 k to 3V3 (or the module's own 10 k: VCC to 3V3, 4.7 k out, for
   more margin). Scope CH1 on OUT against ESP GND: about 3.2 V at rest,
   under 0.5 V for each count. pin-watch: falls at the count rate.
3. **Reflash `firmware/emitter`** (the C6 still runs pin-watch), then
   the first real counts below. No firmware change: the falling edge is
   still the timed one.
4. The C6 dropped off the bench Pi's USB three times on 2026-10-08:
   check its cable before trusting a silence.
5. The drawing (sheet 3) still wires INPUT - to VIN: it changes when the
   tap is soldered, and the new revision goes to the roof session.

**Where the bench stopped, 2026-10-07.** The opto is wired but passes no
edge. The C6 runs `firmware/pin-watch` (GPIO18's level and falling edges,
once a second; read it with `tools/pin-watch.py` on the machine its USB
is plugged into), NOT the emitter: reflash `firmware/emitter` before bits
can flow.

- Proven: GPIO18 reaches the chip (a GND jumper on it reads level=0). The
  earlier "18" jumper never did; it was most likely on GPIO9, the BOOT
  strap, which is the header's end pin: a reset with it low sits in the
  ROM bootloader ("waiting for download"). Keep the end pin clear.
- On camera the output side looks right: OUT to GPIO18, module GND to ESP
  GND, 4.7 k to 3V3. No edge came from the CAJOE's blinks, nor from the
  CAJOE's P3 "GND" tapped to IN -.
- **First test:** pink and blue off the module's INPUT, then ESP 3V3 to
  IN + and ESP GND to IN -. Low: the opto is good and the fault is the
  CAJOE side (meter P3: which pin reads 5 V, which dips per click; the
  order is still only from photographs). High: swap the two jumpers;
  still high, the module is suspect and the HW-399 stands in.
- Shorting IN + to IN - turns the LED off, not on: not a test.

It runs end to end on self-test pulses: the ESP32-C6 board latches each
edge at 6.25 ns, streams it over Wi-Fi to the workstation, and bits come
out of the gap-aware extractor every minute. What is left needs the
bench.

1. **Meter two things before wiring.** The CAJOE's P3 5V pin (read off a
   photograph by elimination) and the opto module's R1 (its code reads
   1 k sideways). TM-TRNG-001 sheet 3 has both.
2. **Wire the opto** (sheet 3): CAJOE 5V to INPUT +, VIN to INPUT -,
   OUT to GPIO18, the 4.7 k pull-up at J3, the module's VCC left
   open. The CAJOE on its own adapter: if the enclosure's PSU feeds
   both the CAJOE and the ESP, the grounds join and the opto isolates
   nothing (an isolated 5 to 5 V module on the CAJOE side fixes that;
   if the grounds are shared anyway, the next drawing revision says
   so). From the PSU, 5 V goes to the board's 5V pin, never with USB-C
   plugged in, never 12 V; an ATX supply needs PS_ON to ground. The P2 lead's bare ends and the wires at the tube's clip get
   a look first (2026-10-05 camera frames).
3. **First real counts.** `missed` must stay 0 in the heartbeat; the
   rate should come back near the 2026-06-21 report's 9.8 Hz.
4. **Site the emitter.** Its Wi-Fi reads -82 to -84 dBm on the bench.
5. **Pull the retired Pi's SD card** before it goes to the donor pile:
   the 44M-row event record is on it and nowhere else.
6. **Order** the fast opto (TLP2361 or HCPL-060L class), two; two
   Seeed XIAO ESP32S3 (plain, not Sense: USB keyboard, BLE and Wi-Fi
   on one board, for both NES pads; fit its antenna before testing);
   and, if the PSU will feed the CAJOE, an isolated 5 V to 5 V 1 W
   module.

The emitter survived losing its screen (checked 2026-10-06: boots,
6.25 ns capture, PULSE 5 delivered, -69 dBm). What looked like a dead
board was the receiver stuck on a half-open socket; geiger 8831945 drops
a peer silent for 10 s. It was left connected that night with no edges
on GPIO18 (the opto not yet wired). The drawings are TM-TRNG-001 rev D,
published on the public site's hotbits notebook page. Every geiger
commit makes the package's built.json stale and the site's pull
refuses it, so a post-commit hook (tools/hooks/post-commit) rebuilds it;
a new revision letter is handed to the site's session, which deploys
on the owner's word.

## Boards on hand (nes-bench `docs/pile.md`)

7. **LITTLEGUY** (the Stamp P4, no buttons, running pad-usb): hold
   G35/BOOT to GND through a reset, then `esp-reset LITTLEGUY
   --characterize`. Its first second on USB already gave a MAC,
   30:ED:A0:EA:99:6E; which P4 board it is still waits on this.
8. **HP-16C:** three LR44 cells, power on; then, if wanted, an
   independent check of ADC/SBC carry and overflow at word size 8.

## Carried from 2026-10-05, still open

9. Find the "gh issues / 6502 project" (`gh auth refresh -s read:project`).
10. Which change the iPhone needed (no report ID, or the clean pairing).
11. Pad latency, press to key event.
12. One pad circuit (nes-bench#4): board, path selection, battery.
13. Screen streaming (nes#1): read RFC 4175 and VITA 49; prototype on
    palette indices.
14. Bench items 4.2/5.2 (the pad through the bridge), C1 part side, and
    re-boarding the console's record on the public site.

Items 1 to 6 need the bench and the detector; 7 and 8 need only the
boards.
