# To do next session (written 2026-10-06, updated 2026-10-07 midday)

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
