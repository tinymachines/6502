; Die Runner -- cartridge one for games.tinymachines.ai
; ============================================================================
; You are a charge carrier falling down the die. The world scrolls up past
; you; you move left and right between the wires. Polysilicon gates bar the
; way, and some of them are PASS TRANSISTORS: they conduct on one clock phase
; and block on the other, so an opening that is shut now will be open in a
; moment. Ride the metal, collect the charge, do not be standing in a channel
; when its gate goes low.
;
; The gates are REAL. Each one is a switch that exists on this die, and it
; conducts exactly when its own control line is high on the chip running this
; game. The host watches eight of them -- dpc25_SBDB, dpc9_DBADD, dpc10_ADLADD,
; dpc21_ADDADL, dpc23_SBAC, dpc30_ADHPCH, dpc40_ADLPCL, dpc2_XSB -- and hands
; their levels over as a byte. Nothing here simulates a clock phase; the phase
; is whatever the 6502 executing this code happens to be doing.
;
; A gate has two channels and they are complementary, so there is ALWAYS a way
; through: channel A conducts while the line is high, channel B while it is
; low. That is not a kindness, it is what a pass transistor is.
;
; Assembled by this project's own assembler (web/asm.js), which inverts the
; disassembler's table -- so if it assembles, it disassembles to the same
; lines. The assembler has no constants, only labels, so every address here is
; written out and the map is the comment block below.
;
;   $00   LFSR state, an 8-bit maximal-length shifter with taps $1D
;   $02   controller, written by the host:  3 = left, 4 = right
;   $03   status: 0 running, 1 over
;   $0D   tick: the host clears it, this ROM raises it when a frame is done
;   $10   the runner's column, 0..15
;   $11   score, one per charge packet
;   $12   frame counter
;   $19   scratch: which gate a barrier being built belongs to
;   $1A   the column of the gap in the barrier just built
;   $1B   non-zero while a bond pad is owed to that column, one row later
;   $1C   the column a power rail is running down
;   $1D   rows of that rail still to come
;   $13   frames until the next barrier
;   $14   gate mask, written by the host: bit g is control line g's level
;   $17   scratch: the column a gap starts at
;   $18   the column the LAST gap started at, so the next one drifts from it
;
;   $0500 the screen: 16x16 cells, one tile index per cell. It sits a page
;         higher than it used to: the ROM grew past $0400 when the scenery
;         arrived and would have been overwritten by its own display.
;         row 2 ($0520) is the runner's row and never moves: the world
;         rises to meet him, so he must sit near the top to see it coming
;
; Tiles, from games/chr.js:
;   0 substrate   2 charge packet   4 polysilicon gate (solid)
;   9  poly bus     10 power rail   11 diff well
;   12 poly T       13 metal L      14 capacitor    15 bond pad
;         all of these are scenery and pass through, except the capacitor,
;         which is worth five. The die used to be empty between barriers.
;   16+g  channel A of gate g: conducts while line g is HIGH
;   24+g  channel B of gate g: conducts while line g is LOW
;         (the host draws both as tile 6 or 7 by the same rule)
;   8 the runner

        .org $0200

; ---------------------------------------------------------------------------
; Power on
; ---------------------------------------------------------------------------
        LDX #$FF
        TXS
        CLD

        LDA #$00                ; clear the screen, all 256 cells
        TAX
clear   STA $0500,X
        INX
        BNE clear

        LDA #$08                ; the runner starts mid-die
        STA $10
        LDA #$00
        STA $11                 ; score
        STA $12                 ; frame counter
        STA $03                 ; running
        STA $02                 ; no input pending
        LDA #$A5                ; any non-zero seed will do; zero is a fixed
        STA $00                 ; point of the shifter and would never move
        LDA #$0C
        STA $13                 ; a beat of clear die before the first gate
        LDA #$08
        STA $18                 ; the first gap opens where the runner stands
        LDA #$FF
        STA $14                 ; until the host says otherwise, A channels pass

        LDA #$08                ; draw the runner once before the first frame
        LDX $10
        STA $0520,X

        LDA #$01                ; raise the flag: the host clears it to start
        STA $0D

; ---------------------------------------------------------------------------
; The main loop is a busy-wait. There is no interrupt line in use and no timer
; on this chip, so the only way to be told "a frame has passed" is for someone
; outside to write to memory -- which, over a stateless API, is an edit between
; two steps.
; ---------------------------------------------------------------------------
main    LDA $0D
        BNE main
        JSR frame
        LDA #$01
        STA $0D
        JMP main

; ---------------------------------------------------------------------------
; One frame
; ---------------------------------------------------------------------------
frame   LDA $03                 ; once it is over, do nothing but keep ticking
        BEQ frame1
        RTS

frame1  INC $12

; -- the controller ---------------------------------------------------------
; The host writes a direction and this clears it, so a press is consumed
; exactly once however long the round trip took.
        LDA $02
        BEQ noinput
        CMP #$03
        BNE tryright
        DEC $10
        JMP wrapx
tryright
        CMP #$04
        BNE clrinput
        INC $10
wrapx   LDA $10                 ; the die wraps: walk off the left edge and
        AND #$0F                ; you come back on the right
        STA $10
clrinput
        LDA #$00
        STA $02
noinput

; -- scroll the world up one row -------------------------------------------
; 240 bytes, forwards, destination below source: the plain copy is safe.
        LDX #$00
scroll  LDA $0510,X
        STA $0500,X
        INX
        CPX #$F0
        BNE scroll

; -- the new bottom row ----------------------------------------------------
        LDX #$00
        LDA #$00
blank   STA $05F0,X
        INX
        CPX #$10
        BNE blank

        DEC $13
        BEQ barrier

; Not a barrier row. The die gets some furniture, then perhaps something to
; collect, then the signpost owed by the last barrier.
        JSR scenery
        JSR pickup

        LDA $1B                 ; a bond pad, pointing at the way through the
        BEQ nopad               ; barrier immediately above it
        LDX $1A
        LDA #$0F
        STA $05F0,X
        LDA #$00
        STA $1B
nopad
        JMP draw

; -- a barrier -------------------------------------------------------------
barrier LDA #$06                ; six frames until the next one
        STA $13

        LDX #$00                ; wall it off
        LDA #$04
wall    STA $05F0,X
        INX
        CPX #$10
        BNE wall

; Where the way through starts. It DRIFTS from the last gap rather than
; landing anywhere, because a gap placed at random can be further away than
; the runner can walk before the barrier arrives -- which is not difficulty,
; it is a death the player could not have avoided. Minus three to plus four,
; against six frames of travel, is always reachable.
        JSR rnd
        AND #$07
        SEC
        SBC #$03
        CLC
        ADC $18
        AND #$0F
        STA $17
        STA $18

        JSR rnd                 ; and which KIND of barrier this is
        AND #$01
        BNE switched

; A plain gate: three cells of nothing, and a bond pad owed to the row below
; so the opening is announced before it arrives. Only a plain gate is
; signposted: which channel of a SWITCHED gate is open depends on a control
; line that will have moved by the time the player gets there, so a signpost
; would be pointing at a guess.
        LDA $17
        STA $1A
        LDA #$01
        STA $1B
        LDA #$00
        JSR punch
        LDA #$00
        JSR punch
        LDA #$00
        JSR punch
        JMP draw

; A pass-transistor gate. Which of the eight real control lines governs it is
; chosen here and encoded in the tile, so the cell carries its own identity as
; it scrolls: 16+g is the channel that conducts while line g is high, 24+g the
; one that conducts while it is low.
switched
        JSR rnd
        AND #$07
        STA $19                 ; the gate index for this barrier
        CLC
        ADC #$10
        JSR punch2
        LDA $19
        CLC
        ADC #$10
        JSR punch2

        LDA $17                 ; the other channel, half a die away
        CLC
        ADC #$06
        AND #$0F
        STA $17
        LDA $19
        CLC
        ADC #$18
        JSR punch2
        LDA $19
        CLC
        ADC #$18
        JSR punch2

; There is no clock scan any more. A gate cell carries its own gate index, and
; whether that gate conducts is read from the mask at the moment it matters --
; so a phase change costs nothing and the board never has to be rewritten. It
; also means what the player sees and what kills them come from one byte.

; -- what the runner is standing in ----------------------------------------
draw    LDX $10
        LDA $0520,X
        CMP #$02
        BEQ eat
        CMP #$0E                ; a capacitor is worth five
        BEQ eatbig
        CMP #$04                ; solid polysilicon
        BEQ dead
        CMP #$10
        BCC alive               ; below 16 it is substrate or the runner

        SEC                     ; a gate channel: which gate, and which channel
        SBC #$10
        CMP #$08
        BCC chana
        SBC #$08                ; 24+g: conducts while the line is LOW
        TAY
        LDA $14
        AND bits,Y
        BEQ alive
        BNE dead

chana   TAY                     ; 16+g: conducts while the line is HIGH
        LDA $14
        AND bits,Y
        BNE alive
        BEQ dead

eatbig  LDA $11                 ; a capacitor
        CLC
        ADC #$05
        STA $11
        LDA #$00
        STA $0520,X
        JMP alive

eat     INC $11                 ; a charge packet: take it
        LDA #$00
        STA $0520,X
alive   LDA #$08
        STA $0520,X
        RTS

dead    LDA #$01
        STA $03
        LDA #$08                ; leave the runner where it stopped
        STA $0520,X
        RTS

; ---------------------------------------------------------------------------
; The furniture of a die. A power rail runs down a column for a few rows, so
; it is drawn one cell per row and comes out as a rail because the world
; scrolls: a poly T where it starts, metal rail down its length, a metal L
; where it turns away. None of it is in the way; it is here because a die is
; not empty between its gates.
; ---------------------------------------------------------------------------
scenery LDA $1D
        BEQ newrail
        DEC $1D
        LDX $1C
        LDA $1D
        BNE railon
        LDA #$0D                ; metal L: the rail turns and leaves
        STA $05F0,X
        RTS
railon  LDA #$0A                ; power rail
        STA $05F0,X
        RTS

newrail JSR rnd
        AND #$07
        BEQ startrail
        CMP #$01
        BEQ polybus
        CMP #$02
        BEQ diffwell
        RTS

startrail
        JSR rnd
        AND #$0F
        STA $1C
        JSR rnd
        AND #$03
        CLC
        ADC #$03                ; three to six rows of it
        STA $1D
        LDX $1C
        LDA #$0C                ; poly T where it comes in
        STA $05F0,X
        RTS

polybus JSR rnd                 ; a run of poly across the die
        AND #$0F
        STA $17
        LDA #$09
        JSR punch
        LDA #$09
        JSR punch
        LDA #$09
        JSR punch
        RTS

diffwell
        JSR rnd
        AND #$0F
        TAX
        LDA #$0B
        STA $05F0,X
        RTS

; ---------------------------------------------------------------------------
; Something to collect: usually a charge packet, occasionally a capacitor,
; which is worth five of them.
; ---------------------------------------------------------------------------
pickup  JSR rnd
        AND #$03
        BNE nopick
        JSR rnd
        AND #$0F
        TAX
        JSR rnd
        AND #$07
        BNE plain
        LDA #$0E                ; a capacitor
        STA $05F0,X
        RTS
plain   LDA #$02
        STA $05F0,X
nopick  RTS

; ---------------------------------------------------------------------------
; Open one cell of the row being built, at $17, and step $17 on with a wrap.
; The tile to write arrives in A.
; ---------------------------------------------------------------------------
punch2
punch   LDX $17
        STA $05F0,X
        INC $17
        LDA $17
        AND #$0F
        STA $17
        RTS

; ---------------------------------------------------------------------------
; An eight-bit maximal-length shift register: 255 values before it repeats,
; which is more than long enough for a die that scrolls past in seconds. The
; same shape the first cartridge used, because it is the cheapest randomness
; a 6502 has.
; ---------------------------------------------------------------------------
rnd     LDA $00
        ASL A
        BCC rndskip
        EOR #$1D
rndskip STA $00
        RTS

; One bit per gate, because the 6502 has no barrel shifter and a table is
; cheaper than eight rolls.
bits    .byte $01,$02,$04,$08,$10,$20,$40,$80
