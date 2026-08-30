//! How closely rung 2 tracks rung 0, node for node: measured, not asserted.
//!
//!     cargo run --release -p v6502-compiled --example agree [half-cycles]
//!
//! The kernel's account applies (docs/notes/engine.md, "The solver as a
//! kernel"): a lane-uniform sweep cannot stage the momentary configurations
//! the queue does, so trajectories differ where charge remembers one. This
//! prints how often, how much, and whether the program result agrees.

use v6502_compiled::Machines;
use v6502_pins::Load;
use v6502_sim::pins::rung0;

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3000);
    let nl = v6502_netlist::mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let loads = [Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }];
    let mut a = rung0(&loads, 0x200);
    a.power_cycle();
    let mut b = Machines::new(&pu);
    b.load_all(&loads, 0x200);
    b.power_cycle();
    let live: Vec<usize> = (0..nl.node_count()).filter(|&i| nl.exists(i as u16) && !nl.is_rail(i as u16)).collect();
    let (mut agree, mut worst, mut first) = (0usize, 0usize, None);
    let mut at_reset = 0usize;
    for &i in &live {
        if a.engine().is_high(i as u16) != b.state.is_high(0, i) {
            at_reset += 1;
        }
    }
    let mut per_node = vec![0usize; nl.node_count()];
    for hc in 0..n {
        a.half_step();
        b.half_step();
        let mut d = 0;
        for &i in &live {
            if a.engine().is_high(i as u16) != b.state.is_high(0, i) {
                d += 1;
                per_node[i] += 1;
            }
        }
        if d == 0 {
            agree += 1;
        } else {
            first.get_or_insert(hc);
            worst = worst.max(d);
        }
    }
    println!("after reset: {at_reset} of {} live nodes differ", live.len());
    println!("trajectory: {agree}/{n} half-cycles identical on all {} live nodes", live.len());
    match first {
        None => println!("  no divergence at all"),
        Some(h) => println!("  first divergence at half-cycle {h}; worst half-cycle differed on {worst} of {} nodes", live.len()),
    }
    println!("program: $20 is ${:02x} compiled, ${:02x} scalar -- {}", b.mem[0][0x20], a.bus.peek(0x20), if b.mem[0][0x20] == a.bus.peek(0x20) { "SAME" } else { "DIFFERENT" });
    let mut persistent: Vec<(usize, usize)> = per_node.iter().enumerate().filter(|(_, &c)| c * 2 > n).map(|(i, &c)| (i, c)).collect();
    persistent.sort_by_key(|&(_, c)| std::cmp::Reverse(c));
    println!("nodes differing in over half the half-cycles: {}", persistent.len());
    for (i, c) in persistent.iter().take(40) {
        let g = nl.gates_of(*i as u16).len();
        let t = nl.terminals_of(*i as u16).len();
        println!("  {i:5} {:<28} {c:5}/{n}  gates {g:2} terminals {t:2} pullup {}", nl.name_of(*i as u16).unwrap_or("-"), nl.pullups().get(*i));
    }
    println!("rounds/settle {:.2}, spreads/round {:.2}", b.stats.rounds as f64 / b.stats.settles as f64, b.stats.spreads as f64 / b.stats.rounds as f64);
}
