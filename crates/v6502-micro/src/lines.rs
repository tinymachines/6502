// The control vector's columns, in the one authored order.
//
// The 46 datapath control lines carry the names Hanson and Balazs gave
// them (the name table is MIT; the VECTOR VALUES in the generated table
// are measured from the die and are not). Bits 46..48 are the three
// vector-address constants the interrupt sequence drives, and 49/50 are
// the bus pins the table also has to say: `rw` (high is read) and `sync`.
//
// Order is load-bearing: the recorder writes bit `i` of every span word
// from `LINE_NAMES[i]`, and every consumer reads it back by this constant.

pub const LINE_NAMES: [&str; 51] = [
    "dpc-2_ADH/ABH", "dpc-1_ADL/ABL", "dpc0_YSB", "dpc1_SBY", "dpc2_XSB",
    "dpc3_SBX", "dpc4_SSB", "dpc5_SADL", "dpc6_SBS", "dpc7_SS",
    "dpc8_nDBADD", "dpc9_DBADD", "dpc10_ADLADD", "dpc11_SBADD", "dpc12_0ADD",
    "dpc13_ORS", "dpc14_SRS", "dpc15_ANDS", "dpc16_EORS", "dpc17_SUMS",
    "dpc18_#DAA", "dpc19_ADDSB7", "dpc20_ADDSB06", "dpc21_ADDADL", "dpc22_#DSA",
    "dpc23_SBAC", "dpc24_ACSB", "dpc25_SBDB", "dpc26_ACDB", "dpc27_SBADH",
    "dpc28_0ADH0", "dpc29_0ADH17", "dpc30_ADHPCH", "dpc31_PCHPCH", "dpc32_PCHADH",
    "dpc33_PCHDB", "dpc34_PCLC", "dpc35_PCHC", "dpc36_#IPC", "dpc37_PCLDB",
    "dpc38_PCLADL", "dpc39_PCLPCL", "dpc40_ADLPCL", "dpc41_DL/ADL", "dpc42_DL/ADH",
    "dpc43_DL/DB",
    "0/ADL0", "0/ADL1", "0/ADL2",
    "rw", "sync",
];

pub const BIT_RW: usize = 49;
pub const BIT_SYNC: usize = 50;
// The ALU carry-in, recorded beside the controls: a data signal, but a
// single-valued one under the selector key, because the carry flag is a
// key bit wherever it feeds the ALU.
pub const BIT_ALUCIN: usize = 51;

// Two of the 46 are not control at all: `dpc34_PCLC` and `dpc35_PCHC` are
// the PC incrementer's carries, data signals wearing control-line names
// (experiment 3's finding, reproduced by the recorder's gate on JSR). The
// datapath computes them; the table records their bits as zero.
pub const BIT_PCLC: usize = 36;
pub const BIT_PCHC: usize = 37;
pub const DATA_BITS: u64 = (1 << BIT_PCLC) | (1 << BIT_PCHC);

// The ADD-path write-backs land one half-cycle into the NEXT instruction's
// execution (the famous overlap: a result is not in the accumulator when
// sync rises). Measured at the seam: SBX after INX, SBAC after ADC, nothing
// after CLC; direct loads (LDA/LDY) complete inside their own span. Each
// recorded variant carries its seam word, and the sequencer ORs the
// finished instruction's word into the next span's first half-cycle.
pub const WB_MASK: u64 = (1 << bit::SBY) | (1 << bit::SBX) | (1 << bit::SBS) | (1 << bit::SBAC);

/// The selector key's bits: which way each measured mechanism went for one
/// execution. The RECORDER computes these from full knowledge (registers,
/// flags and memory at the opcode's fetch); the sequencer reproduces each
/// bit from its own datapath at the half-cycle where the variant spans
/// diverge. Documented here so the two sides cannot drift in meaning.
///
///   bit 0  branch taken
///   bit 1  taken branch crosses a page
///   bit 2  the X index add crosses a page (abs,X and zp-pointer forms)
///   bit 3  the Y index add crosses a page (abs,Y and (zp),Y)
///   bit 4  the carry flag (into ADDSB7 for the ROR family)
pub const SEL_TAKEN: u8 = 1 << 0;
pub const SEL_BCROSS: u8 = 1 << 1;
pub const SEL_XCROSS: u8 = 1 << 2;
pub const SEL_YCROSS: u8 = 1 << 3;
pub const SEL_CARRY: u8 = 1 << 4;
//   bit 5  a taken branch's offset is negative (nDBADD against DBADD)
pub const SEL_NEG: u8 = 1 << 5;
//   bit 6  the decimal flag (into #DAA/#DSA for the ADC and SBC families)
pub const SEL_D: u8 = 1 << 6;

/// Whether the OVERLAP's ALU carry-in lands anywhere: the ops whose flag
/// update reads the overlap captures (`flags.rs`: the ADC/SBC family and
/// its composites, the compares, SBX, the accumulator shifts, the
/// register increments). For everything else the overlap sum is the fetch
/// cycle's incidental add, and its carry-in is data the selector key
/// cannot determine (the decimal fresh context proved it on ROL abs,X:
/// same key, different memory, different level). The recorder masks the
/// bit where this is false AND the variant has no seam write-back, and
/// the coverage test masks its reading the same way; the pin replay is
/// what proves the masking harmless.
pub fn overlap_alucin_consumed(op: u8) -> bool {
    matches!(op,
        // ADC / SBC and the RRA/ISC composites.
        0x69 | 0x65 | 0x75 | 0x6d | 0x7d | 0x79 | 0x61 | 0x71
        | 0xe9 | 0xe5 | 0xf5 | 0xed | 0xfd | 0xf9 | 0xe1 | 0xf1 | 0xeb
        | 0x67 | 0x77 | 0x6f | 0x7f | 0x7b | 0x63 | 0x73
        | 0xe7 | 0xf7 | 0xef | 0xff | 0xfb | 0xe3 | 0xf3
        // Compares and SBX.
        | 0xc9 | 0xc5 | 0xd5 | 0xcd | 0xdd | 0xd9 | 0xc1 | 0xd1
        | 0xe0 | 0xe4 | 0xec | 0xc0 | 0xc4 | 0xcc
        | 0xc7 | 0xd7 | 0xcf | 0xdf | 0xdb | 0xc3 | 0xd3 | 0xcb
        // Accumulator shifts, ANC's kin, and the register increments.
        | 0x0a | 0x2a | 0x4a | 0x6a | 0x4b
        | 0xe8 | 0xc8 | 0xca | 0x88)
}

/// The RRA family: ROR memory, then ADC, whose overlap carry-in is the
/// ROR's own carry OUT: the famous fresh-carry case, data from the
/// operand byte that no selector key can determine. The recorder masks
/// the bit and the sequencer computes it from its own mid-span shift
/// capture (`srs_pre`), which is also what the ADC's flags consume.
pub fn overlap_cin_from_shift(op: u8) -> bool {
    matches!(op, 0x67 | 0x77 | 0x6f | 0x7f | 0x7b | 0x63 | 0x73)
}

/// Every column by name, so the datapath and the sequencer index the vector
/// without a string in sight. `tests/datapath.rs` holds each one against
/// `LINE_NAMES`, so a reorder cannot drift past it.
pub mod bit {
    pub const ADH_ABH: usize = 0;
    pub const ADL_ABL: usize = 1;
    pub const YSB: usize = 2;
    pub const SBY: usize = 3;
    pub const XSB: usize = 4;
    pub const SBX: usize = 5;
    pub const SSB: usize = 6;
    pub const SADL: usize = 7;
    pub const SBS: usize = 8;
    pub const SS: usize = 9;
    pub const NDBADD: usize = 10;
    pub const DBADD: usize = 11;
    pub const ADLADD: usize = 12;
    pub const SBADD: usize = 13;
    pub const ZADD: usize = 14;
    pub const ORS: usize = 15;
    pub const SRS: usize = 16;
    pub const ANDS: usize = 17;
    pub const EORS: usize = 18;
    pub const SUMS: usize = 19;
    pub const DAA_N: usize = 20;
    pub const ADDSB7: usize = 21;
    pub const ADDSB06: usize = 22;
    pub const ADDADL: usize = 23;
    pub const DSA_N: usize = 24;
    pub const SBAC: usize = 25;
    pub const ACSB: usize = 26;
    pub const SBDB: usize = 27;
    pub const ACDB: usize = 28;
    pub const SBADH: usize = 29;
    pub const ZADH0: usize = 30;
    pub const ZADH17: usize = 31;
    pub const ADHPCH: usize = 32;
    pub const PCHPCH: usize = 33;
    pub const PCHADH: usize = 34;
    pub const PCHDB: usize = 35;
    pub const IPC_N: usize = 38;
    pub const PCLDB: usize = 39;
    pub const PCLADL: usize = 40;
    pub const PCLPCL: usize = 41;
    pub const ADLPCL: usize = 42;
    pub const DL_ADL: usize = 43;
    pub const DL_ADH: usize = 44;
    pub const DL_DB: usize = 45;
    pub const VADL0: usize = 46;
    pub const VADL1: usize = 47;
    pub const VADL2: usize = 48;
}
