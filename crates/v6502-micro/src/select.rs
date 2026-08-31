// The recorder-side selectors: the authored mapping from full knowledge of
// a machine (registers, flags, memory) to the selector key of lines.rs.
// Shared by include! between build.rs and the coverage test so the two
// cannot drift; the SEQUENCER does not use these (it reproduces each bit
// from its own datapath at the half-cycle where the variants diverge).

/// The addressing shape the X/Y cross bits need. Authored (it is the
/// manual's mode table, folded to the one question the selector asks);
/// everything else about the opcode is measured.
fn index_reg(op: u8) -> Option<char> {
    // aaabbbcc: bbb is the addressing mode row, cc the block.
    let (a, b, c) = (op >> 5, op >> 2 & 7, op & 3);
    match (b, c) {
        (4, 1) | (4, 3) => Some('Y'),           // (zp),Y, incl. the cc=3 column
        (6, 1) | (6, 3) => Some('Y'),           // abs,Y
        (7, 0) | (7, 1) => Some('X'),           // abs,X (SHY 9c included)
        (7, 2) | (7, 3) => {
            // abs,X except the a=4/a=5 rows (SHX/SHA/LDX/LAX), which are abs,Y.
            if a == 4 || a == 5 { Some('Y') } else { Some('X') }
        }
        _ => None,
    }
}

/// The selector key for one context, from full knowledge at the fetch:
/// the flags, the index registers, the operand bytes and (for the
/// zp-pointer forms) the pointer bytes in memory. Bit meanings in lines.rs.
fn selector(op: u8, p: u8, x: u8, y: u8, fetch_pc: u16, image: &[u8]) -> u8 {
    let mut key = 0u8;
    let op0 = image[fetch_pc.wrapping_add(1) as usize];
    if p & 1 != 0 {
        key |= SEL_CARRY;
    }
    if op & 0x1f == 0x10 {
        // Branch: opcode bits 7..6 pick the flag, bit 5 the level it takes on.
        let flag = match op >> 6 {
            0 => p >> 7 & 1,
            1 => p >> 6 & 1,
            2 => p & 1,
            _ => p >> 1 & 1,
        };
        if flag == (op >> 5 & 1) {
            key |= SEL_TAKEN;
            if op0 & 0x80 != 0 {
                key |= SEL_NEG;
            }
            let base = fetch_pc.wrapping_add(2);
            let target = base.wrapping_add(op0 as i8 as u16);
            if base & 0xff00 != target & 0xff00 {
                key |= SEL_BCROSS;
            }
        }
    }
    if let Some(reg) = index_reg(op) {
        let (idx, low) = match (op >> 2 & 7, op & 3) {
            // (zp),Y: the pointer's low byte from zero page.
            (4, 1) | (4, 3) => (y, image[op0 as usize]),
            _ => (if reg == 'X' { x } else { y }, op0),
        };
        if (low as u16 + idx as u16) > 0xff {
            key |= if reg == 'X' { SEL_XCROSS } else { SEL_YCROSS };
        }
    }
    key
}
