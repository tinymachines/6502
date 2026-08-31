// The measurement harness: one memory image shape, one boot, one vector
// encoding. Shared by include! between build.rs and the coverage test so a
// test could never pass by encoding the vector differently than the
// recorder did.

#[allow(dead_code)] // shared by include; not every consumer builds images
fn memory_image(base: u16, preamble: &[u8], op: u8, operands: &[u8]) -> Vec<u8> {
    let mut mem = vec![0xeau8; 0x10000];
    let b = base as usize;
    mem[b..b + preamble.len()].copy_from_slice(preamble);
    let at = b + preamble.len();
    mem[at] = op;
    mem[at + 1..at + 1 + operands.len()].copy_from_slice(operands);
    mem[0x0300..0x0303].copy_from_slice(&[0x4c, 0x00, 0x03]);
    // NMI and IRQ/BRK to the $0300 loop, reset to the context's base.
    mem[0xfffa..0x10000].copy_from_slice(&[0x00, 0x03, base as u8, (base >> 8) as u8, 0x00, 0x03]);
    mem
}

fn boot(image: &[u8]) -> Cpu<FlatMemory> {
    let mut m = FlatMemory::new();
    m.load(0, image);
    let mut cpu = Cpu::new(Arc::new(v6502_netlist::mos6502()), m).expect("signals resolve");
    cpu.power_cycle();
    cpu
}

/// The vector, bit i from `LINE_NAMES[i]`, plus rw, sync and alucin.
fn vector(cpu: &Cpu<FlatMemory>, ids: &[u16]) -> u64 {
    let mut v = 0u64;
    // Only the 49 line bits: ids[49] is the alucin node, whose level goes
    // into BIT_ALUCIN below and must never land on bit 49, which is rw.
    // It did, for one build: the recorder, its probe and the coverage test
    // all shared the bug and agreed with each other while every RMW's
    // dummy write replayed as a read against the pin golden.
    for (i, &id) in ids.iter().take(49).enumerate() {
        if cpu.engine().is_high(id) {
            v |= 1 << i;
        }
    }
    // rw and sync come from the SAME adapter the pin golden was recorded
    // through, not from bus_state(): the two disagree at an RMW's dummy
    // write (the rw node is low through the whole cycle; the service point
    // is later), and a table that says "read" where the pins say "write"
    // replays wrong by construction.
    let pf = v6502_pins::PinEngine::pins(cpu);
    if pf.rw {
        v |= 1 << BIT_RW;
    }
    if pf.sync {
        v |= 1 << BIT_SYNC;
    }
    // Only where an ALU operation consumes it, in phi2: elsewhere the node
    // rides the data (op 2e's recorder conflict found this) and recording
    // it would put data in the table.
    let alu_op = v >> 15 & 0x1f != 0; // ORS SRS ANDS EORS SUMS
    if alu_op && cpu.phase() == v6502_sim::Phase::Phi2 && cpu.engine().is_high(ids[49]) {
        v |= 1 << BIT_ALUCIN;
    }
    // The incrementer carries are the datapath's to compute, not the
    // table's to say; see lines.rs.
    v & !DATA_BITS
}
