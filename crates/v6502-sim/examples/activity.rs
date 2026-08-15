//! How much of the chip moves in one half-cycle?
//!
//! This exists to size a feature rather than to ship one. A per-half-cycle
//! trace that lists "every node that changed" is only worth building if that
//! list is readable; if 800 nodes move at every edge it is a wall of text and
//! the design has to be something else. So: measure first.
//!
//!     cargo run --release -p v6502-sim --example activity

use v6502_sim::boot;

fn main() {
    // LDA #$50 ; CLC ; ADC #$50 ; STA $10 ; LDX #$07 ; INX
    let prog = [0xa9, 0x50, 0x18, 0x69, 0x50, 0x85, 0x10, 0xa2, 0x07, 0xe8, 0xea, 0xea];
    let mut cpu = boot(0x0200, &prog);
    // Cloned out of the borrow so the loop below can still step the machine.
    let nl = cpu.engine().netlist().clone();
    let n = nl.node_count();
    let vss = nl.vss();
    let vcc = nl.vcc();

    let snapshot = |cpu: &v6502_sim::cpu::Cpu<v6502_sim::bus::FlatMemory>| {
        (0..n as u16).map(|i| cpu.engine().is_high(i)).collect::<Vec<bool>>()
    };

    let mut prev = snapshot(&cpu);
    let mut changed_hist: Vec<usize> = Vec::new();
    let mut named_hist: Vec<usize> = Vec::new();
    let mut conducting_hist: Vec<usize> = Vec::new();

    println!("{:>5} {:>4} {:>8} {:>7} {:>7} {:>11}  T-states",
             "hcyc", "sync", "changed", "named", "sw on", "A/X");

    for _ in 0..90 {
        cpu.half_step();
        let now = snapshot(&cpu);

        let changed: Vec<u16> = (0..n as u16)
            .filter(|&i| i != vss && i != vcc && prev[i as usize] != now[i as usize])
            .collect();
        let named = changed.iter().filter(|&&i| nl.name_of(i).is_some()).count();

        // A pass transistor conducts exactly when its gate is high. That is the
        // whole of the "which edges are live right now" question, and it needs
        // nothing the front end does not already have.
        let conducting = (0..nl.transistor_count())
            .filter(|&t| now[nl.transistor_gate(t as u16) as usize])
            .count();

        let s = cpu.observe();
        println!("{:>5} {:>4} {:>8} {:>7} {:>7} {:02x}/{:02x}       {}",
                 s.half_cycle, s.bus.sync as u8, changed.len(), named, conducting,
                 s.regs.a, s.regs.x, s.timing.fixed_width());

        changed_hist.push(changed.len());
        named_hist.push(named);
        conducting_hist.push(conducting);
        prev = now;
    }

    // The second question, and the one that decides the shape of the feature:
    // if "everything conducting" is half the chip, is a *path* narrow enough?
    // Re-run and ask, at every half-cycle, how far the accumulator's bit 0 is
    // from the internal data bus through switches that are actually on.
    //
    // It starts at `idb0` rather than at the pin, and that is a finding rather
    // than a convenience. `db0` is a *pad*: all eleven of its terminals go to a
    // rail, because it is an output driver. Nothing reaches the chip from the
    // pin through a switch at all -- the way in is through the input receiver,
    // which is a gate. So a trace that follows only switches can never leave
    // the pins, and any honest one has to walk gates too.
    let mut cpu = boot(0x0200, &prog);
    let idb0 = nl.node("idb0").expect("idb0");
    let a0 = nl.node("a0").expect("a0");
    let mut hops: Vec<i32> = Vec::new();
    let mut reach: Vec<usize> = Vec::new();

    for _ in 0..90 {
        cpu.half_step();
        let hot: Vec<bool> = (0..n as u16).map(|i| cpu.engine().is_high(i)).collect();

        // Breadth-first over switches whose gate is high. Rails are not crossed,
        // for the same reason the group traversal does not cross them: vss
        // touches hundreds of transistors and would merge most of the chip.
        let mut dist = vec![-1i32; n];
        dist[idb0 as usize] = 0;
        let mut queue = std::collections::VecDeque::from([idb0]);
        while let Some(node) = queue.pop_front() {
            for t in nl.terminals_of(node) {
                let far = t.other;
                if far == vss || far == vcc || dist[far as usize] >= 0 { continue; }
                if !hot[nl.transistor_gate(t.transistor) as usize] { continue; }
                dist[far as usize] = dist[node as usize] + 1;
                queue.push_back(far);
            }
        }
        hops.push(dist[a0 as usize]);
        reach.push(dist.iter().filter(|&&d| d >= 0).count());
    }

    let stat = |v: &[usize], what: &str| {
        let mut s = v.to_vec();
        s.sort_unstable();
        println!("{what:>14}: min {} median {} p90 {} max {}",
                 s[0], s[s.len() / 2], s[s.len() * 9 / 10], s[s.len() - 1]);
    };
    println!();
    stat(&changed_hist, "nodes changed");
    stat(&named_hist, "of them named");
    stat(&conducting_hist, "switches on");
    stat(&reach, "reached fr idb0");
    println!("{:>14}: {} nodes, {} transistors", "chip", n, nl.transistor_count());

    let connected = hops.iter().filter(|&&h| h >= 0).count();
    let mut lens: Vec<i32> = hops.iter().copied().filter(|&h| h >= 0).collect();
    lens.sort_unstable();
    println!("\n  idb0 -> a0 through conducting switches:");
    println!("    connected in {connected} of {} half-cycles", hops.len());
    if !lens.is_empty() {
        println!("    hops when connected: min {} median {} max {}",
                 lens[0], lens[lens.len() / 2], lens[lens.len() - 1]);
    }
}
