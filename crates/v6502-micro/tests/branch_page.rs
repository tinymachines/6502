//! A taken branch across a page goes the way the offset's sign says.
//!
//! The part fixes the program counter's high byte in the branch's fourth
//! cycle, and the direction is a control difference: `DBADD` for a
//! positive offset, `nDBADD` for a negative one. Rung 3 picks the span
//! for that cycle by a selector key, and the key's relevance mask is
//! searched at build time for the SMALLEST set of bits that keeps the
//! recordings single-valued. That search can only see what was recorded:
//! all three `bnegcross` contexts ended on an `LDX` or an `LDY`, which
//! write N and Z, so BMI and BEQ were never taken in any of them and
//! their only crossing recording was a FORWARD one. `taken + crosses`
//! was single-valued for those two without the sign, the mask dropped
//! it, and a backward branch across a page selected the forward span:
//! rung 3 added a page where the part subtracts one.
//!
//! It cost a game. Super Mario Bros. 2 clears a byte, branches back over
//! a page edge at $ED10 to $ECE3, and on rung 3 went to $EEE3 instead,
//! into the bank's $FF padding, through it to a BRK, and spun on the IRQ
//! vector for as long as it was left running. The screen stayed one
//! colour. `bnegcross_n` and `bnegcross_z` (and `cneg_n`/`cneg_z` for
//! the same branches on their page) are the recordings that were
//! missing; all eight branches now carry the sign in their mask.
//!
//! This holds every branch to rung 0 across a page in both directions
//! and on its page, with the carry set and clear, since the carry is
//! what the mask search reached for as a stand-in for the sign the first
//! time this went wrong. `MUTATE_BSIGN=1` drops the sign from the key
//! again and must go red.

use v6502_micro::machine::MicroCpu;
use v6502_pins::{compare, run, Load};
use v6502_sim::pins::rung0;

const BRANCHES: [(&str, u8, &[u8]); 8] = [
    // (name, opcode, the bytes that leave the flag in the state that
    // takes the branch; each ends on the instruction that writes it, so
    // nothing after can clobber it)
    ("BPL", 0x10, &[0xa9, 0x01]),
    ("BMI", 0x30, &[0xa9, 0x80]),
    ("BVC", 0x50, &[0xb8]),
    ("BVS", 0x70, &[0xa9, 0x40, 0x85, 0x10, 0x24, 0x10]),
    ("BCC", 0x90, &[0x18]),
    ("BCS", 0xb0, &[0x38]),
    ("BNE", 0xd0, &[0xa9, 0x01]),
    ("BEQ", 0xf0, &[0xa9, 0x00]),
];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Way {
    /// Back over the page edge below: the case that was wrong.
    BackAcross,
    /// Forward over the page edge above.
    ForwardAcross,
    /// Back, staying on the page: the ordinary loop.
    BackOnPage,
    /// Forward, staying on the page: the commonest branch there is, and
    /// the one whose absence from the recordings let the mask search
    /// drop the TAKEN bit for BMI. `LDA #$80 / BMI` then played the
    /// not-taken span.
    ForwardOnPage,
}

const SPIN: u16 = 0x0280;
const STEPS: u64 = 160;

/// The program, and the address its branch is fetched at. The branch is
/// placed so its target is where `way` says, and every path ends in a
/// spin at $0280 so the run is quiet after it.
fn loads(op: u8, setup: &[u8], carry: bool, way: Way) -> (Vec<Load>, u16, u16, u16) {
    // The carry first, where the branch is not about the carry: the
    // decorrelator, since C agreeing with the sign is what taught the
    // mask search the wrong bit.
    let mut pre: Vec<u8> = Vec::new();
    if !matches!(op, 0x90 | 0xb0) {
        pre.push(if carry { 0x38 } else { 0x18 });
    }
    pre.extend_from_slice(setup);
    // The branch sits just past a page start, so a short negative offset
    // reaches the page below and a short positive one does not leave the
    // page above.
    let org: u16 = match way {
        Way::ForwardAcross => 0x02f0,
        _ => 0x0310,
    };

    let at = org + pre.len() as u16;
    // Each landing is clear of the program that branches to it, so a
    // case cannot pass by overwriting its own setup.
    let target = match way {
        Way::BackAcross => 0x02e0,
        Way::ForwardAcross => 0x0310,
        Way::BackOnPage => 0x0300,
        Way::ForwardOnPage => 0x0340,
    };
    let off = (target as i32 - (at as i32 + 2)) as i8;
    let mut prog = pre;
    prog.extend([op, off as u8]);
    // Past the branch, in case it is not taken: straight to the spin, so
    // a branch that fails to be taken is a difference in the pins and not
    // a run into whatever follows.
    prog.extend([0x4c, SPIN as u8, (SPIN >> 8) as u8]);
    let landing = vec![0xe8, 0x4c, SPIN as u8, (SPIN >> 8) as u8]; // INX; JMP spin
    let mut l = vec![
        Load { org, bytes: prog },
        Load { org: target, bytes: landing },
        Load { org: SPIN, bytes: vec![0x4c, SPIN as u8, (SPIN >> 8) as u8] },
    ];
    // BVS's setup reads $10 through BIT.
    l.push(Load { org: 0x0010, bytes: vec![0x40] });
    (l, org, at, target)
}

/// Rung 0's own account of where the branch went, so the test cannot
/// pass on a program whose branch did not do what the case says.
fn measured(op: u8, setup: &[u8], carry: bool, way: Way) -> (u16, u16) {
    let (l, org, at, _) = loads(op, setup, carry, way);
    let mut a = rung0(&l, org);
    let f = run(&mut a, STEPS, &[]);
    let k = f.iter().position(|x| x.sync && !x.clk0 && x.ab == at).expect("the branch is fetched");
    let next = f[k + 1..].iter().find(|x| x.sync && !x.clk0).expect("an instruction after the branch");
    (at, next.ab)
}

#[test]
fn a_branch_across_a_page_goes_the_way_the_sign_says() {
    let mut failures = Vec::new();
    let mut runs = 0;
    for (name, op, setup) in BRANCHES {
        for carry in [false, true] {
            // BCC and BCS are about the carry: one value each takes.
            if (op == 0x90 && carry) || (op == 0xb0 && !carry) {
                continue;
            }
            for way in [Way::BackAcross, Way::ForwardAcross, Way::BackOnPage, Way::ForwardOnPage] {
                runs += 1;
                let (l, entry, at, target) = loads(op, setup, carry, way);
                // What the part did, before either rung is believed: the
                // branch was taken, and it landed where this case says.
                let (_, landed) = measured(op, setup, carry, way);
                assert_eq!(landed, target, "{name} C={} {way:?}: rung 0's branch at {at:04x} landed at {landed:04x}, not {target:04x}", carry as u8);
                let crosses = (at & 0xff00) != (target & 0xff00);
                let should_cross = matches!(way, Way::BackAcross | Way::ForwardAcross);
                assert_eq!(crosses, should_cross, "{name} C={} {way:?}: {at:04x} -> {target:04x} does not cross as the case says", carry as u8);

                let mut a = rung0(&l, entry);
                let expected = run(&mut a, STEPS, &[]);
                let mut b = MicroCpu::rung3(&l, entry);
                let got = run(&mut b, STEPS, &[]);
                if let Err(m) = compare(&expected, &got) {
                    failures.push(format!("{name} C={} {way:?} ({at:04x} -> {target:04x}): {m}", carry as u8));
                }
                // And the registers, which a pin comparison can miss
                // while the program counter is inside an instruction.
                let (ra, rb) = (a.registers(), b.registers());
                let (pa, pb) = (ra.pc, rb.5);
                if pa != pb {
                    failures.push(format!("{name} C={} {way:?}: rung 0 ended at pc {:04x}, rung 3 at {:04x}", carry as u8, pa, pb));
                }
            }
        }
    }
    assert!(failures.is_empty(), "rung 3 left rung 0 on {} of {runs} runs:\n{}", failures.len(), failures.join("\n"));
}

/// Every selector key a branch can actually present has a recording.
///
/// The lockstep above finds a missing variant one panic at a time, in
/// whatever order the cases run; this names all of them at once. A
/// branch's key is the taken bit, and when it is taken the crossing bit
/// and the offset's sign, times the carry and the decimal flag, which
/// the mask keeps or drops per opcode. Nothing here consults the mask:
/// the point is to ask for what a program can ask for.
///
/// It asks whether a variant ANSWERS, which is weaker than asking
/// whether the right one does: a key the mask folds onto another case's
/// span answers, and answers wrongly. This test stayed green through
/// the whole of the TAKEN hole below. It is kept for what it does see,
/// a key with nothing at all behind it, and the mask invariant and the
/// lockstep are what see the rest.
#[test]
fn every_key_a_branch_can_present_has_a_variant() {
    use v6502_micro::lines::{SEL_BCROSS, SEL_CARRY, SEL_D, SEL_NEG, SEL_TAKEN};
    let mut missing = Vec::new();
    for (name, op, _) in BRANCHES {
        for carry in [0, SEL_CARRY] {
            for d in [0, SEL_D] {
                // Not taken: the selector leaves the branch bits clear.
                let mut keys = vec![carry | d];
                for cross in [0, SEL_BCROSS] {
                    for neg in [0, SEL_NEG] {
                        // A forward branch cannot be negative and a
                        // backward one cannot be positive only in the
                        // sense that the offset's sign IS the direction;
                        // both combinations of cross and sign happen.
                        keys.push(SEL_TAKEN | cross | neg | carry | d);
                    }
                }
                for k in keys {
                    if v6502_micro::table::span(op, k).is_none() {
                        missing.push(format!("{name} ({op:02x}) key {k:#04x} (mask {:#04x})", v6502_micro::table::MASKS[op as usize]));
                    }
                }
            }
        }
    }
    assert!(missing.is_empty(), "{} branch keys have no recorded variant:\n{}", missing.len(), missing.join("\n"));
}

/// Every branch's selector mask keeps the three bits that change what
/// the instruction DOES.
///
/// The relevance mask is the smallest set of selector bits that keeps
/// the recordings single-valued, and it can only see what was recorded.
/// A bit it drops is one no pair of recordings needed, which is not the
/// same as one no program needs: the key of a case nobody recorded is
/// then masked onto some other case's span, silently, with no panic to
/// find. It has happened twice. The sign went first (BMI and BEQ took a
/// backward branch across a page forwards, and Super Mario Bros. 2 died
/// on it); adding the contexts for that left BMI with no plain
/// taken-forward-on-page recording at all, so TAKEN went next and
/// `LDA #$80 / BMI` played the not-taken span.
///
/// These three bits are not a judgement call. Taken and not taken are
/// different lengths; crossing a page is a cycle longer than not; and
/// the offset's sign is the direction of the high byte's fixup. No
/// recording can ever make one of them redundant, so a mask without one
/// is a hole whatever the search concluded, and this says so directly
/// rather than waiting for a program to fall into it.
#[test]
fn no_branchs_mask_drops_taken_crossing_or_the_sign() {
    use v6502_micro::lines::{SEL_BCROSS, SEL_NEG, SEL_TAKEN};
    let need = SEL_TAKEN | SEL_BCROSS | SEL_NEG;
    let mut missing = Vec::new();
    for (name, op, _) in BRANCHES {
        let mask = v6502_micro::table::MASKS[op as usize];
        if mask & need != need {
            let lost: Vec<&str> = [(SEL_TAKEN, "taken"), (SEL_BCROSS, "crosses"), (SEL_NEG, "sign")]
                .iter()
                .filter(|(b, _)| mask & b == 0)
                .map(|&(_, n)| n)
                .collect();
            missing.push(format!("{name} ({op:02x}): mask {mask:#04x} drops {}", lost.join(", ")));
        }
    }
    assert!(missing.is_empty(), "{} branch masks have a hole:\n{}", missing.len(), missing.join("\n"));
}
