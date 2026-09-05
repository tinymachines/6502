//! Record the pin golden from rung 0.
//!
//!     cargo run --release -p v6502-pins --example pin-golden [out-dir]
//!
//! Writes one `.pins` file per run into `tools/pin-golden/` (the default),
//! and a `.stim` file beside each scripted one:
//!
//!   - the seven shipped programs, from `web/programs.txt` (so run
//!     `node tools/export-programs.mjs` first), 3000 half-cycles each;
//!   - the program the JS reference is compared on, read from the header of
//!     `tools/golden-trace/golden.txt` when that file is there, so the bytes
//!     come from the thing that made the claim rather than a copy;
//!   - the interrupt fixture from `v6502-sim/tests/interrupts.rs`, scripted
//!     seven ways so every input pin is exercised: IRQ in the window where
//!     the BRK is lost, IRQ early enough to be ordinary, reset in mid-run,
//!     RDY held low, an NMI edge, an SO pulse, and the free run; an eighth
//!     script on a store, RDY falling inside the write cycle; and a ninth
//!     with RDY released on a phi1 frame rather than a phi2;
//!   - all 256 opcodes, one each after a fixed preamble, 96 half-cycles, so
//!     the twelve that never finish are recorded not finishing.
//!
//! The scripted half-cycles are MEASURED from rung 0 in this run (the fetch
//! of the BRK is found by watching `sync` and the address bus), then written
//! into the `.stim` file as numbers. A replay reads the numbers; it does not
//! measure again, because the engine under test is the thing that might get
//! the fetch wrong.
//!
//! Everything written here is derived from the CC BY-NC-SA die data and is
//! gitignored, like the golden trace.

use std::fs;
use std::path::{Path, PathBuf};
use v6502_pins::{run, write_stim, write_trace, Header, Load, Stim, Trace, IDLE_INPUTS};
use v6502_sim::pins::{rung0, stamp};

const PROGRAM_STEPS: u64 = 3000;
const FIXTURE_STEPS: u64 = 400;
const OPCODE_STEPS: u64 = 96;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex")).collect()
}

struct Case {
    name: String,
    loads: Vec<Load>,
    reset_vector: u16,
    steps: u64,
    stim: Vec<Stim>,
}

fn record(c: &Case, out: &Path) -> usize {
    let mut cpu = rung0(&c.loads, c.reset_vector);
    let frames = run(&mut cpu, c.steps, &c.stim);
    let stim_name = if c.stim.is_empty() { String::new() } else { format!("{}.stim", c.name) };
    if !c.stim.is_empty() {
        fs::write(out.join(&stim_name), write_stim(&c.name, &c.stim)).expect("write .stim");
    }
    let t = Trace {
        header: Header {
            name: c.name.clone(),
            loads: c.loads.clone(),
            reset_vector: c.reset_vector,
            stim: stim_name,
            stamp: stamp(&cpu),
            half_cycles: c.steps,
        },
        frames,
    };
    fs::write(out.join(format!("{}.pins", c.name)), write_trace(&t)).expect("write .pins");
    t.frames.len()
}

/// The seven programs, as `web/programs.txt` has them.
fn programs() -> Vec<Case> {
    let path = root().join("web/programs.txt");
    let text = fs::read_to_string(&path).unwrap_or_else(|_| {
        eprintln!("pin-golden: no {}; run `node tools/export-programs.mjs`", path.display());
        std::process::exit(1);
    });
    let mut out = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        let org = u16::from_str_radix(f[1], 16).expect("org");
        out.push(Case {
            name: format!("program-{}", f[0].to_lowercase().replace(' ', "-")),
            loads: vec![Load { org, bytes: hex_bytes(f[2]) }],
            reset_vector: org,
            steps: PROGRAM_STEPS,
            stim: vec![],
        });
    }
    out
}

/// The reference's program, from the golden trace's own header.
fn golden() -> Option<Case> {
    let text = fs::read_to_string(root().join("tools/golden-trace/golden.txt")).ok()?;
    let (mut addr, mut bytes, mut vector) = (None, None, None);
    for line in text.lines().take_while(|l| l.starts_with('#')) {
        let mut it = line.trim_start_matches("# ").split_whitespace();
        match (it.next(), it.next()) {
            (Some("program_addr"), Some(v)) => addr = v.parse::<u16>().ok(),
            (Some("program"), Some(v)) => bytes = Some(hex_bytes(v)),
            (Some("reset_vector"), Some(v)) => vector = v.parse::<u16>().ok(),
            _ => {}
        }
    }
    Some(Case {
        name: "golden".into(),
        loads: vec![Load { org: addr?, bytes: bytes? }],
        reset_vector: vector?,
        steps: PROGRAM_STEPS,
        stim: vec![],
    })
}

/// The fixture `tests/interrupts.rs` uses: `CLI`, two `NOP`s, `BRK` at $0203,
/// padding, a handler at $0300 that jumps to itself, and the BRK/IRQ vector
/// pointing at it. Mirrored here rather than shared because the test's copy
/// is a test, and the header of every file written from this one carries the
/// bytes, so a replay never consults either.
const BRK_AT: u16 = 0x0203;

fn fixture_loads() -> Vec<Load> {
    let mut prog = vec![0x58, 0xea, 0xea, 0x00];
    prog.extend([0xea; 8]);
    vec![
        Load { org: 0x0200, bytes: prog },
        Load { org: 0x0300, bytes: vec![0x4c, 0x00, 0x03] },
        Load { org: 0xfffa, bytes: vec![0x00, 0x03] }, // NMI vector: the same handler
        Load { org: 0xfffe, bytes: vec![0x00, 0x03] },
    ]
}

/// The half-cycle at which rung 0 announces the opcode fetch at `addr`
/// (`sync` high with that address on the bus), on a free run.
fn fetch_h(loads: &[Load], reset_vector: u16, addr: u16) -> u64 {
    let mut cpu = rung0(loads, reset_vector);
    let frames = run(&mut cpu, FIXTURE_STEPS, &[]);
    frames
        .iter()
        .find(|f| f.sync && f.ab == addr)
        .map(|f| f.h)
        .unwrap_or_else(|| panic!("rung 0 never fetched at ${addr:04x}"))
}

fn stim(h: u64, res: bool, irq: bool, nmi: bool, rdy: bool, so: bool) -> Stim {
    Stim { h, res, irq, nmi, rdy, so }
}

fn idle(h: u64) -> Stim {
    let (res, irq, nmi, rdy, so) = IDLE_INPUTS;
    stim(h, res, irq, nmi, rdy, so)
}

fn fixture_cases() -> Vec<Case> {
    let loads = fixture_loads();
    let vector = 0x0200;
    let brk = fetch_h(&loads, vector, BRK_AT);
    let first = fetch_h(&loads, vector, 0x0200);
    let case = |name: &str, stim: Vec<Stim>| Case {
        name: format!("fixture-{name}"),
        loads: loads.clone(),
        reset_vector: vector,
        steps: FIXTURE_STEPS,
        stim,
    };
    vec![
        case("brk-alone", vec![]),
        // Asserted four half-cycles before the BRK's fetch: inside the window
        // (3 to 6) in which tests/interrupts.rs measures the BRK being lost.
        case("irq-lost-brk", vec![stim(brk - 4, true, false, true, true, false)]),
        // Eight before: early enough to be an ordinary interrupt of the
        // instruction before the BRK.
        case("irq-ordinary", vec![stim(brk - 8, true, false, true, true, false)]),
        // Reset asserted after the first fetch, held eight half-cycles (the
        // reference's reset runs eight clock pulses), then released.
        case("reset-mid-run", vec![stim(first + 20, false, true, true, true, false), idle(first + 28)]),
        // RDY low for ten half-cycles across the NOPs: the chip must stall on
        // read cycles and resume where it was.
        case("rdy-stall", vec![stim(first + 6, true, true, true, false, false), idle(first + 16)]),
        // The same stall released one half-cycle earlier, so RDY rises on a
        // phi1 frame: the chip samples RDY at phi2, and the held cycle must
        // run once more before the next begins (the 2A03's DMA units
        // release RDY on phi1 frames; tinymachines/2a03, N3 step 5).
        case("rdy-release-phi1", vec![stim(first + 6, true, true, true, false, false), idle(first + 15)]),
        // NMI is edge triggered: one falling edge, released six later.
        case("nmi-edge", vec![stim(brk - 8, true, true, false, true, false), idle(brk - 2)]),
        // SO sets the overflow flag on its own edge; a four-half-cycle pulse.
        case("so-pulse", vec![stim(first + 8, true, true, true, true, true), idle(first + 12)]),
        // RDY falling DURING A WRITE cycle: the write completes (NMOS
        // ignores RDY on writes) and the read cycle after it is the one
        // held. The program is `LDA #$5A / STA $0210` then NOPs (A is
        // loaded first: a store of the power-on A would test the rungs'
        // undefined power-on state, which is not this script's claim, and
        // rung 2's differs). The store's write cycle is the sixth, so its
        // phi2 is first + 11 and the script drives RDY low there, releasing
        // eight half-cycles on. The 2A03's DMA units assert RDY on exactly
        // this shape (a $4014 write), which is where the case came from
        // (tinymachines/2a03, N3 step 5).
        {
            let mut prog = vec![0xa9, 0x5a, 0x8d, 0x10, 0x02];
            prog.extend([0xea; 8]);
            let mut loads = loads.clone();
            loads[0] = Load { org: 0x0200, bytes: prog };
            let first_w = fetch_h(&loads, vector, 0x0200);
            Case {
                name: "fixture-rdy-in-write".into(),
                loads,
                reset_vector: vector,
                steps: FIXTURE_STEPS,
                stim: vec![stim(first_w + 10, true, true, true, false, false), idle(first_w + 18)],
            }
        },
    ]
}

/// Decimal mode, exposed at the pins: every case runs a chain of BCD
/// operations under `SED` and lands each result in a `STA` (the byte on
/// the write cycle) and each flag set in a `PHP` (the byte on the push),
/// so an engine that adds in binary where the chip adjusts in decimal
/// fails by address and value rather than by register. The values cover
/// the low-nibble adjust, the high-nibble adjust, the wrap with carry,
/// borrow cases, and one invalid-BCD input each way, whose answer is
/// whatever the silicon does (the recording is the claim).
fn decimal_cases() -> Vec<Case> {
    let case = |name: &str, body: &[u8]| {
        let mut prog = body.to_vec();
        prog.extend([0x4c, 0x00, 0x03]); // JMP the fixture's handler loop
        let mut loads = fixture_loads();
        loads[0] = Load { org: 0x0200, bytes: prog };
        Case {
            name: format!("decimal-{name}"),
            loads,
            reset_vector: 0x0200,
            steps: FIXTURE_STEPS,
            stim: vec![],
        }
    };
    vec![
        // 19+28=47, 09+01=10 (low adjust), 99+99+1=99 C=1 (wrap), 50+50=00 C=1.
        case("adc", &[
            0xf8, 0x18, 0xa9, 0x19, 0x69, 0x28, 0x85, 0x80, 0x08,
            0xa9, 0x09, 0x69, 0x01, 0x85, 0x81, 0x08,
            0x38, 0xa9, 0x99, 0x69, 0x99, 0x85, 0x82, 0x08,
            0x18, 0xa9, 0x50, 0x69, 0x50, 0x85, 0x83, 0x08,
        ]),
        // 42-13=29, 10-05=05 (borrow into the low nibble), 00-01=99 C=0.
        case("sbc", &[
            0xf8, 0x38, 0xa9, 0x42, 0xe9, 0x13, 0x85, 0x80, 0x08,
            0xa9, 0x10, 0xe9, 0x05, 0x85, 0x81, 0x08,
            0xa9, 0x00, 0xe9, 0x01, 0x85, 0x82, 0x08,
        ]),
        // Invalid BCD in ($1f+$01, $9a-$00), a compare under D (unaffected),
        // and CLD mid-stream so the next add is binary again.
        case("mixed", &[
            0xf8, 0x18, 0xa9, 0x1f, 0x69, 0x01, 0x85, 0x80, 0x08,
            0x38, 0xa9, 0x9a, 0xe9, 0x00, 0x85, 0x81, 0x08,
            0xa9, 0x19, 0xc9, 0x11, 0x08,
            0xd8, 0x18, 0xa9, 0x19, 0x69, 0x28, 0x85, 0x82, 0x08,
        ]),
    ]
}

/// Flags through zero and through bit 7 on the transfers, the register
/// increments and decrements, and the stack pulls: every result lands
/// in a `PHP`, so an engine whose N or Z came from the wrong capture
/// fails by the pushed byte. The opcode traces run every one of these
/// once, but with the preamble's A=$41, X=$02, Y=$03, so a zero never
/// flows through a transfer there (tinymachines/nes found TYA of a
/// zero Y leaving Z clear on rung 3, N5 step 1).
fn flags_cases() -> Vec<Case> {
    let body: &[u8] = &[
        0xa0, 0x00, 0x98, 0x08, // LDY #0; TYA; PHP
        0xa2, 0x00, 0x8a, 0x08, // LDX #0; TXA; PHP
        0xa9, 0x00, 0xaa, 0x08, 0xa8, 0x08, // LDA #0; TAX; PHP; TAY; PHP
        0xa2, 0x80, 0x8a, 0x08, // LDX #$80; TXA; PHP
        0xa0, 0xff, 0x98, 0x08, // LDY #$FF; TYA; PHP
        0xba, 0x08, // TSX; PHP
        0xa2, 0x01, 0xca, 0x08, // LDX #1; DEX; PHP
        0xa0, 0x01, 0x88, 0x08, // LDY #1; DEY; PHP
        0xa2, 0xff, 0xe8, 0x08, // LDX #$FF; INX; PHP
        0xa0, 0x7f, 0xc8, 0x08, // LDY #$7F; INY; PHP
        0xa9, 0x00, 0x48, 0xa9, 0x55, 0x68, 0x08, // LDA #0; PHA; LDA #$55; PLA; PHP
        0xa9, 0x01, 0x4a, 0x08, // LDA #1; LSR; PHP
        0xa9, 0x00, 0xa2, 0x00, 0x9a, 0xba, 0x08, // LDA #0; LDX #0; TXS; TSX; PHP
    ];
    let mut prog = body.to_vec();
    prog.extend([0x4c, 0x00, 0x03]);
    let mut loads = fixture_loads();
    loads[0] = Load { org: 0x0200, bytes: prog };
    // The shape a font-copy loop has: Y wraps to zero by INY, other
    // instructions run, then TYA decides a branch. Each step's flags
    // land in a PHP.
    let wrap: &[u8] = &[
        0xa0, 0xff, 0xc8, 0x08, // LDY #$FF; INY; PHP
        0x98, 0x08, // TYA; PHP
        0xa0, 0xff, 0xc8, 0xa2, 0x01, 0xca, 0x98, 0x08, // LDY #$FF; INY; LDX #1; DEX; TYA; PHP
        0xa0, 0xff, 0xa2, 0x01, 0xc8, 0x8d, 0x00, 0x03, 0xca, 0xd0, 0x00, 0x98, 0xd0, 0x02, 0xe6, 0xf1, 0x08, // LDY #$FF; LDX #1; INY; STA $0300; DEX; BNE +0; TYA; BNE +2; INC $F1; PHP
        0xa2, 0xff, 0xe8, 0xa0, 0x01, 0x88, 0x8a, 0x08, // LDX #$FF; INX; LDY #1; DEY; TXA; PHP
    ];
    let mut prog2 = wrap.to_vec();
    prog2.extend([0x4c, 0x00, 0x03]);
    let mut loads2 = fixture_loads();
    loads2[0] = Load { org: 0x0200, bytes: prog2 };
    // A font-copy loop as a real program has it (blargg's, transcribed:
    // eight zeros then eight bytes through a zero-page pointer per
    // character, the pointer's page bumped when Y wraps), with Y set to
    // wrap inside the first character. The source is a page of data at
    // $0400; the sink is $0700.
    let mut copy: Vec<u8> = vec![
        0xa9, 0x00, 0x85, 0xf0, // LDA #0; STA $F0
        0xa9, 0x04, 0x85, 0xf1, // LDA #4; STA $F1
        0xa9, 0x02, 0x85, 0xf2, // LDA #2; STA $F2
        0xa0, 0xf8, // LDY #$F8
    ];
    let top = copy.len();
    copy.extend([0xa2, 0x08, 0xa9, 0x00]); // LDX #8; LDA #0
    copy.extend([0x8d, 0x00, 0x07, 0xca, 0xd0, 0xfa]); // z: STA $0700; DEX; BNE z
    copy.extend([0xa2, 0x08]); // LDX #8
    copy.extend([0xb1, 0xf0, 0xc8, 0x8d, 0x00, 0x07, 0xca, 0xd0, 0xf7]); // f: LDA (F0),Y; INY; STA $0700; DEX; BNE f
    copy.extend([0x98, 0xd0, 0x02, 0xe6, 0xf1]); // TYA; BNE +2; INC $F1
    copy.extend([0xc6, 0xf2]); // DEC $F2
    let here = copy.len() + 2;
    copy.extend([0xd0, (top as i32 - here as i32) as i8 as u8]); // BNE top
    copy.extend([0x08, 0x4c, 0x00, 0x03]); // PHP; JMP $0300
    let mut loads3 = fixture_loads();
    loads3[0] = Load { org: 0x0200, bytes: copy };
    loads3.push(Load { org: 0x0400, bytes: (0..=255u8).map(|i| i.wrapping_mul(0x5b) ^ 0x3c).collect() });
    loads3.push(Load { org: 0x0500, bytes: (0..=255u8).map(|i| i.wrapping_mul(0x2f) ^ 0xa5).collect() });
    // PLP and PHP round trips of chosen bytes, and BRK's pushed status:
    // each pull lands in a PHP and a store, so what P holds after a PLP
    // and what the stack receives from PHP and BRK show at the pins
    // (blargg's instr_test 01-basics #4 and 16-special #5 test these).
    let mut plp: Vec<u8> = Vec::new();
    for v in [0xffu8, 0x00, 0x5a, 0xa5, 0x30, 0xcf] {
        plp.extend([0xa9, v, 0x48, 0x28, 0x08, 0x68, 0x8d, 0x00, 0x04]); // LDA #v; PHA; PLP; PHP; PLA; STA $0400
    }
    plp.extend([0x00, 0xea]); // BRK (the handler pulls and stores the pushed status), NOP
    plp.extend([0x4c, 0x00, 0x03]);
    let mut loads4 = fixture_loads();
    loads4[0] = Load { org: 0x0200, bytes: plp };
    // The BRK/IRQ handler: PLA (the pushed status) ; STA $0401 ; PHA ; RTI... simpler: store and loop.
    loads4[1] = Load { org: 0x0300, bytes: vec![0x68, 0x8d, 0x01, 0x04, 0x4c, 0x04, 0x03] };
    vec![
        Case { name: "flags-plp".into(), loads: loads4, reset_vector: 0x0200, steps: FIXTURE_STEPS, stim: vec![] },
        Case { name: "flags-zero".into(), loads, reset_vector: 0x0200, steps: FIXTURE_STEPS, stim: vec![] },
        Case { name: "flags-wrap".into(), loads: loads2, reset_vector: 0x0200, steps: FIXTURE_STEPS, stim: vec![] },
        Case { name: "flags-fontloop".into(), loads: loads3, reset_vector: 0x0200, steps: 700, stim: vec![] },
    ]
}

/// One case per opcode: the trace page's preamble (`LDA #$41 / LDX #$02 /
/// LDY #$03 / CLC`), the opcode with `$34 $12` as its operand bytes, then
/// NOPs. The handler and vectors are the fixture's, so a BRK or a jam has
/// somewhere to go.
fn opcode_cases() -> Vec<Case> {
    (0..=255u8)
        .map(|op| {
            let mut prog = vec![0xa9, 0x41, 0xa2, 0x02, 0xa0, 0x03, 0x18, op, 0x34, 0x12];
            prog.extend([0xea; 8]);
            let mut loads = fixture_loads();
            loads[0] = Load { org: 0x0200, bytes: prog };
            Case { name: format!("op-{op:02x}"), loads, reset_vector: 0x0200, steps: OPCODE_STEPS, stim: vec![] }
        })
        .collect()
}

fn main() {
    let out = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| root().join("tools/pin-golden"));
    fs::create_dir_all(&out).expect("create out dir");

    let mut cases = programs();
    match golden() {
        Some(g) => cases.push(g),
        None => eprintln!("pin-golden: no tools/golden-trace/golden.txt, so no golden.pins (node tools/golden-trace/gen.js --steps 3000)"),
    }
    cases.extend(fixture_cases());
    cases.extend(decimal_cases());
    cases.extend(flags_cases());
    cases.extend(opcode_cases());

    let mut frames = 0usize;
    for c in &cases {
        frames += record(c, &out);
    }
    let probe = rung0(&[], 0);
    println!(
        "pin-golden: {} files, {} frames, into {}\n  stamp: {}",
        cases.len(),
        frames,
        out.display(),
        stamp(&probe)
    );
}
