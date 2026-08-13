// The programs both the explorer and the blueprint run.
//
// Shared rather than duplicated: two copies would drift, and "Fibonacci" on one
// page meaning something different from "Fibonacci" on the other is exactly the
// kind of difference nobody notices until a walkthrough stops matching.

export const LOAD_ADDR = 0x0200;

// Chosen to look different on the die: one exercises the stack and the ALU, one
// is pure ALU and zero-page traffic, one hammers the address bus with indexed
// writes.
export const PROGRAMS = [
  {
    name: 'Counter (visual6502 default)',
    bytes: [
      0xa9, 0x00,             // LDA #$00
      0x20, 0x10, 0x02,       // JSR $0210
      0x4c, 0x02, 0x02,       // JMP $0202
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0xe8,                   // $0210  INX
      0x88,                   //        DEY
      0xe6, 0x0f,             //        INC $0F
      0x38,                   //        SEC
      0x69, 0x02,             //        ADC #$02
      0x60,                   //        RTS
    ],
  },
  {
    name: 'Fibonacci (zero page $F0)',
    bytes: [
      0xa9, 0x00,       // LDA #$00
      0x85, 0xf0,       // STA $F0
      0xa9, 0x01,       // LDA #$01
      0x85, 0xf1,       // STA $F1
      0xa5, 0xf0,       // $0208 LDA $F0
      0x18,             //       CLC
      0x65, 0xf1,       //       ADC $F1
      0x85, 0xf2,       //       STA $F2
      0xa5, 0xf1,       //       LDA $F1
      0x85, 0xf0,       //       STA $F0
      0xa5, 0xf2,       //       LDA $F2
      0x85, 0xf1,       //       STA $F1
      0x4c, 0x08, 0x02, //       JMP $0208
    ],
  },
  {
    name: 'Fill page $0300',
    bytes: [
      0xa2, 0x00,       // LDX #$00
      0x8a,             // $0202 TXA
      0x9d, 0x00, 0x03, //       STA $0300,X
      0xe8,             //       INX
      0xd0, 0xf9,       //       BNE $0202
      0x4c, 0x00, 0x02, //       JMP $0200
    ],
  },
];
