//! An interrupt in the last cycle of a taken branch waits one instruction.
//!
//! The part polls its interrupt inputs before the last cycle of an
//! instruction, and a taken branch that stays on its page does not poll
//! at all in the cycle the branch is taken: an NMI or IRQ that arrives
//! there is seen at the end of the NEXT instruction instead. Rung 0 has
//! it because the transistors have it. Rung 3 took the interrupt at the
//! branch's target fetch, and the NES console's record of a commercial
//! cartridge, replayed on rung 0, parted exactly there (an NMI in the
//! last cycle of `BEQ` at $813F, the die finishing `LDA $20` first).
//!
//! This drives an edge at every half-cycle around a branch, taken and
//! not, on the page and across it, NMI and IRQ, on rung 0 beside rung 3,
//! and holds the whole pin trace equal. Measured here (PROBE=1 prints
//! the table): the branch not taken and the branch taken across a page
//! poll as every instruction does; the branch taken on its page does not
//! poll in the cycle it is taken, so an edge two or three half-cycles
//! after its fetch lands its vector read four half-cycles later than a
//! NOP's would. `MUTATE_BRANCH=1` polls a taken branch like any other
//! instruction and must go red.

use v6502_micro::machine::MicroCpu;
use v6502_pins::{compare, run, Load, Stim};
use v6502_sim::pins::rung0;

/// The program at $0200: the flag set up, a NOP lead, the branch, then a
/// NOP tail on both sides of a page edge when asked for, then a spin.
/// Handlers at $0300 (NMI) and $0340 (IRQ/BRK) are NOP; RTI.
fn loads(kind: Kind) -> (Vec<Load>, u16) {
    let mut prog: Vec<u8> = Vec::new();
    // Z=1 for BEQ (LDA #0), and I clear for the IRQ cases (CLI).
    prog.extend([0x58, 0xa9, 0x00]);
    match kind {
        Kind::Taken => {
            prog.extend([0xea; 4]);
            let at = 0x0200 + prog.len() as u16;
            prog.extend([0xf0, 0x02, 0xea, 0xea]); // BEQ +2 over two NOPs
            prog.extend([0xea; 6]);
            let here = 0x0200 + prog.len() as u16;
            prog.extend([0x4c, here as u8, (here >> 8) as u8]);
            {
                let mut l = vec![Load { org: 0x0200, bytes: prog }];
                l.extend(handlers());
                (l, at)
            }
        }
        Kind::NotTaken => {
            prog.extend([0xea; 4]);
            let at = 0x0200 + prog.len() as u16;
            prog.extend([0xd0, 0x02, 0xea, 0xea]); // BNE +2, not taken
            prog.extend([0xea; 6]);
            let here = 0x0200 + prog.len() as u16;
            prog.extend([0x4c, here as u8, (here >> 8) as u8]);
            {
                let mut l = vec![Load { org: 0x0200, bytes: prog }];
                l.extend(handlers());
                (l, at)
            }
        }
        Kind::TakenAcrossPage => {
            // The branch sits at $02FD so its target $0301 crosses the
            // page (the first try sat at $02FB, landed on $02FF and
            // measured the same as the on-page case, which is how a
            // "crossing" that does not cross is caught: the test asserts
            // the fetch after the branch is on the next page): a jump gets
            // there (a NOP lead would outrun the run), and the handlers
            // move to $0400/$0440 out of the way.
            prog.extend([0x4c, 0xf7, 0x02]);
            let mut tail: Vec<u8> = vec![0xea; 6];
            let at = 0x02fd;
            tail.extend([0xf0, 0x02, 0xea, 0xea]); // BEQ +2 from $02FF -> $0301
            tail.extend([0xea; 6]);
            let here = 0x02f7 + tail.len() as u16;
            tail.extend([0x4c, here as u8, (here >> 8) as u8]);
            (
                vec![
                    Load { org: 0x0200, bytes: prog },
                    Load { org: 0x02f7, bytes: tail },
                    Load { org: 0x0400, bytes: vec![0xea, 0x40] },
                    Load { org: 0x0440, bytes: vec![0xea, 0x40] },
                    Load { org: 0xfffa, bytes: vec![0x00, 0x04, 0x00, 0x02, 0x40, 0x04] },
                ],
                at,
            )
        }
    }
}

fn handlers() -> Vec<Load> {
    vec![
        Load { org: 0x0300, bytes: vec![0xea, 0x40] },
        Load { org: 0x0340, bytes: vec![0xea, 0x40] },
        Load { org: 0xfffa, bytes: vec![0x00, 0x03, 0x00, 0x02, 0x40, 0x03] },
    ]
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    Taken,
    NotTaken,
    TakenAcrossPage,
}

const STEPS: u64 = 160;

/// Both rungs from a power cycle, the edge at `h`, held low to the end;
/// every frame compared.
fn lockstep(kind: Kind, irq: bool, h: u64) -> Result<(), String> {
    let (loads, _) = loads(kind);
    let stim = [Stim { h, res: true, irq: !irq, nmi: irq, rdy: true, so: false }];
    let mut a = rung0(&loads, 0x0200);
    let expected = run(&mut a, STEPS, &stim);
    let mut b = MicroCpu::rung3(&loads, 0x0200);
    let got = run(&mut b, STEPS, &stim);
    compare(&expected, &got).map_err(|m| format!("{kind:?} {} edge at h={h}: {m}", if irq { "IRQ" } else { "NMI" }))
}

/// The half-cycle of the branch's opcode fetch on rung 0, so the window
/// of edges is placed around it and not guessed.
fn fetch_of(kind: Kind) -> u64 {
    let (loads, at) = loads(kind);
    let mut a = rung0(&loads, 0x0200);
    let plain = run(&mut a, STEPS, &[]);
    let k = plain.iter().position(|f| f.sync && !f.clk0 && f.ab == at).expect("the branch is fetched");
    let next = plain[k + 1..].iter().find(|f| f.sync && !f.clk0).expect("an instruction after the branch");
    let crosses = next.ab & 0xff00 != at & 0xff00;
    assert_eq!(crosses, matches!(kind, Kind::TakenAcrossPage), "{kind:?}: the fetch after the branch is at {:04x}", next.ab);
    k as u64
}

/// PROBE=1: for every edge, where the vector read lands on each rung, in
/// half-cycles after the branch's fetch; the measurement the rule is from.
#[test]
fn probe_where_the_vector_read_lands() {
    if std::env::var_os("PROBE").is_none() {
        return;
    }
    for kind in [Kind::Taken, Kind::NotTaken, Kind::TakenAcrossPage] {
        let (loads, _) = loads(kind);
        let k = fetch_of(kind);
        for irq in [false, true] {
            let vec = if irq { 0xfffe } else { 0xfffa };
            let mut row = String::new();
            for h in (k.saturating_sub(4))..(k + 12) {
                let stim = [Stim { h, res: true, irq: !irq, nmi: irq, rdy: true, so: false }];
                let mut a = rung0(&loads, 0x0200);
                let fa = run(&mut a, STEPS, &stim);
                let mut b = MicroCpu::rung3(&loads, 0x0200);
                let fb = run(&mut b, STEPS, &stim);
                let at = |f: &[v6502_pins::PinFrame]| f.iter().position(|x| x.rw && !x.clk0 && x.ab == vec).map(|p| p as i64 - k as i64).unwrap_or(-1);
                row.push_str(&format!(" {:+}:{}/{}", h as i64 - k as i64, at(&fa), at(&fb)));
            }
            eprintln!("{kind:?} {}: edge:rung0/rung3 vector read after the fetch{row}", if irq { "IRQ" } else { "NMI" });
        }
    }
}

#[test]
fn an_interrupt_around_a_branch_lands_where_the_die_lands_it() {
    let mut failures = Vec::new();
    let mut runs = 0;
    for kind in [Kind::Taken, Kind::NotTaken, Kind::TakenAcrossPage] {
        let k = fetch_of(kind);
        for irq in [false, true] {
            // From two cycles before the fetch to four after: every phase
            // the branch's own cycles could sample on, and the next
            // instruction's.
            for h in (k.saturating_sub(4))..(k + 12) {
                runs += 1;
                if let Err(e) = lockstep(kind, irq, h) {
                    failures.push(format!("{e} (edge {} half-cycles after the branch's fetch)", h as i64 - k as i64));
                }
            }
        }
    }
    assert!(failures.is_empty(), "rung 3 left rung 0 on {} of {runs} runs:\n{}", failures.len(), failures.join("\n"));
}
