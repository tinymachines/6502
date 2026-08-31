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

// Two of the 46 are not control at all: `dpc34_PCLC` and `dpc35_PCHC` are
// the PC incrementer's carries, data signals wearing control-line names
// (experiment 3's finding, reproduced by the recorder's gate on JSR). The
// datapath computes them; the table records their bits as zero.
pub const BIT_PCLC: usize = 36;
pub const BIT_PCHC: usize = 37;
pub const DATA_BITS: u64 = (1 << BIT_PCLC) | (1 << BIT_PCHC);

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
