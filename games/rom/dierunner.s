; Die Runner -- cartridge one for games.tinymachines.ai
; ============================================================================
; You are a charge carrier falling down the die. The world scrolls up past
; you; you move left and right between the wires. Polysilicon gates bar the
; way, and some of them are PASS TRANSISTORS: they conduct on one clock phase
; and block on the other, so an opening that is shut now will be open in a
; moment. Ride the metal, collect the charge, do not be standing in a channel
; when its gate goes low.
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
;   $12   frame counter; bit 3 of it is the clock phase
;   $13   frames until the next barrier
;   $17   scratch: the column a gap starts at
;   $18   the column the LAST gap started at, so the next one drifts from it
;
;   $0400 the screen: 16x16 cells, one tile index per cell
;         row 2 ($0420) is the runner's row and never moves: the world
;         rises to meet him, so he must sit near the top to see it coming
;
; Tiles, from games/chr.js:
;   0 substrate   2 charge packet   4 polysilicon gate (solid)
;   6 pass transistor, conducting   7 pass transistor, blocking
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
clear   STA $0400,X
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

        LDA #$08                ; draw the runner once before the first frame
        LDX $10
        STA $0420,X

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
scroll  LDA $0410,X
        STA $0400,X
        INX
        CPX #$F0
        BNE scroll

; -- the new bottom row ----------------------------------------------------
        LDX #$00
        LDA #$00
blank   STA $04F0,X
        INX
        CPX #$10
        BNE blank

        DEC $13
        BEQ barrier

; not a barrier row: sometimes a charge packet
        JSR rnd
        AND #$03
        BNE nopacket
        JSR rnd
        AND #$0F
        TAX
        LDA #$02
        STA $04F0,X
nopacket
        JMP phase

; -- a barrier -------------------------------------------------------------
barrier LDA #$06                ; six frames until the next one
        STA $13

        LDX #$00                ; wall it off
        LDA #$04
wall    STA $04F0,X
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

; a plain gate: three cells of nothing
        LDA #$00
        JSR punch
        LDA #$00
        JSR punch
        LDA #$00
        JSR punch
        JMP phase

; a pass-transistor gate: two channels, and only one of them conducts. The
; other opens when the phase flips, which is what makes the timing the game.
switched
        LDA #$06
        JSR punch
        LDA #$06
        JSR punch
        LDA $17                 ; the second channel, half a die away
        CLC
        ADC #$06
        AND #$0F
        STA $17
        LDA #$07
        JSR punch
        LDA #$07
        JSR punch

; -- the clock ------------------------------------------------------------
; Every eighth frame the phase flips and every pass transistor on screen
; changes state: what conducted now blocks, and what blocked now conducts.
phase   LDA $12
        AND #$07
        BNE draw

        LDX #$00
flip    LDA $0400,X
        CMP #$06
        BNE flipshut
        LDA #$07
        STA $0400,X
        JMP flipnext
flipshut
        CMP #$07
        BNE flipnext
        LDA #$06
        STA $0400,X
flipnext
        INX
        BNE flip

; -- what the runner is standing in ----------------------------------------
draw    LDX $10
        LDA $0420,X
        CMP #$02
        BNE notfood
        INC $11                 ; a charge packet: take it
        LDA #$00
        STA $0420,X
        JMP alive
notfood CMP #$04                ; solid polysilicon
        BEQ dead
        CMP #$07                ; a channel that is not conducting
        BEQ dead
alive   LDA #$08
        STA $0420,X
        RTS

dead    LDA #$01
        STA $03
        LDA #$08                ; leave the runner where it stopped
        STA $0420,X
        RTS

; ---------------------------------------------------------------------------
; Open one cell of the row being built, at $17, and step $17 on with a wrap.
; The tile to write arrives in A.
; ---------------------------------------------------------------------------
punch   LDX $17
        STA $04F0,X
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
