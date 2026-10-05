# To do next session (written 2026-10-05)

## Loose ends from the BLE pad day

1. **Find the "gh issues / 6502 project".** It is not in any tinymachines
   repository's issues. If it is a GitHub Project board,
   `gh auth refresh -s read:project` first.
2. **Which change the iPhone needed.** No report ID, or the clean re-pairing
   on both ends. Flash the report-ID-1 build, pair it cleanly, and see whether
   the phone still plays. Settles the open line in nes-bench
   `docs/pad-ble-build.md`.
3. **Pad latency.** Press to the Pi's key event, and press to the phone
   (nes-bench open-items: "The hand's latency is unmeasured", 2026-09-21).

## One pad circuit (nes-bench#4)

4. **Pick the board.** Suggested: an ESP32-S3 or C6 (native USB and BLE).
   Prove the no-report-ID BLE build on it (C6 and P4 builds are untested).
5. **How the pad picks its path.** Start with automatic (USB present means
   USB, otherwise BLE), with a boot strap to force either.
6. **Battery and charger.** Bring the modules to the bench and lay out power:
   charger output, regulator, the pad's 3.3 V.

## Screen streaming (nes#1)

7. **Read first.** RFC 4175 (uncompressed video over RTP) and VITA 49 (raw
   sampled signal).
8. **Pick the seam.** Prototype on PPU palette indices (a few MB/s over UDP,
   the receiver runs `ntsc-crt`); the composite-signal seam later if a real TV
   wants it.

## Bench items still open (nes-bench `docs/open-items.md`)

9. The pad through the bridge (4.2, 5.2).
10. C1, part side: scope records of the palette screen with the cart in the
    console, then grabber frames.
11. Re-board the console's record on the public site (the site session
    deploys).

Items 1 to 3 need the bench and no new parts. Items 4 to 6 need the owner's
parts on hand.
