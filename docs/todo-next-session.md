# To do next session (written 2026-10-06)

## The TRNG emitter (geiger, `docs/HARDEN-PLAN.md`)

It runs end to end on self-test pulses: the ESP32-C6 board latches each
edge at 6.25 ns, streams it over Wi-Fi to the workstation, and bits come
out of the gap-aware extractor every minute. What is left needs the
bench.

1. **Meter two things before wiring.** The CAJOE's P3 5V pin (read off a
   photograph by elimination) and the opto module's R1 (its code reads
   1 k sideways). TM-TRNG-001 sheet 3 has both.
2. **Wire the opto** (sheet 3): CAJOE 5V to INPUT +, VIN to INPUT -,
   OUT to GPIO18, the 4.7 k pull-up at J3, the CAJOE on its own
   adapter. The P2 lead's bare ends and the wires at the tube's clip get
   a look first (2026-10-05 camera frames).
3. **First real counts.** `missed` must stay 0 in the heartbeat; the
   rate should come back near the 2026-06-21 report's 9.8 Hz.
4. **Site the emitter.** Its Wi-Fi reads -82 to -84 dBm on the bench.
5. **Pull the retired Pi's SD card** before it goes to the donor pile:
   the 44M-row event record is on it and nowhere else.
6. **Order the fast opto** (TLP2361 or HCPL-060L class), two.

## Boards on hand (nes-bench `docs/pile.md`)

7. **LITTLEGUY** (the Stamp P4, no buttons, running pad-usb): hold
   G35/BOOT to GND through a reset, then `esp-reset LITTLEGUY
   --characterize`.
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
