//! A diagnostic: lane 0 and lane 1 side by side, with the settle counters,
//! optionally with lane 1 given a different program.
//!
//!     cargo run --release -p v6502-compiled --example lanecheck [differ]

use v6502_compiled::{kernel, Machines};
use v6502_pins::Load;
fn main() {
    let nl = v6502_netlist::mos6502();
    let pu: Vec<bool> = (0..nl.node_count()).map(|i| nl.pullups().get(i)).collect();
    let differ = std::env::args().nth(1).is_some();
    let mut m = Machines::new(&pu);
    m.load_all(&[Load { org: 0x200, bytes: vec![0xe6, 0x20, 0x4c, 0x00, 0x02] }], 0x200);
    if differ {
        m.load_lane(1, &[Load { org: 0x200, bytes: vec![0xe6, 0x21, 0x4c, 0x00, 0x02] }], 0x200);
    }
    m.state.force_power_on_state();
    m.state.set_pull_all(kernel::sig::RES, false);
    m.state.set_pull_all(kernel::sig::CLK0, false);
    m.state.set_pull_all(kernel::sig::RDY, true);
    m.state.set_pull_all(kernel::sig::SO, false);
    m.state.set_pull_all(kernel::sig::IRQ, true);
    m.state.set_pull_all(kernel::sig::NMI, true);
    let r = m.state.settle_power_on(&mut m.stats);
    println!("power-on settle: {r} rounds, nonconvergent so far {}, frozen node-lanes {}", m.stats.nonconvergent_settles, m.stats.frozen);
    m.power_cycle();
    println!("after power_cycle: settles {} rounds {} nonconvergent {}", m.stats.settles, m.stats.rounds, m.stats.nonconvergent_settles);
    let before = m.stats;
    println!("differ={differ}");
    for step in 0..3000 {
        m.half_step();
        if step % 500 == 499 || step < 40 {
            let f0 = m.pins(0);
            let f1 = m.pins(1);
            if step < 40 {
                println!("h={:4} lane0 ab={:04x} db={:02x} rw={} sync={} | lane1 ab={:04x} db={:02x} rw={} sync={} | ir0={:02x} ir1={:02x}", f0.h, f0.ab, f0.db, f0.rw as u8, f0.sync as u8, f1.ab, f1.db, f1.rw as u8, f1.sync as u8, m.reg(0, &kernel::sig::IR), m.reg(1, &kernel::sig::IR));
            } else {
                let d = m.stats;
                println!("  settles {} rounds/settle {:.2} nonconvergent {}", d.settles - before.settles, (d.rounds - before.rounds) as f64 / (d.settles - before.settles) as f64, d.nonconvergent_settles - before.nonconvergent_settles);
                println!("h={:4} $20: lane0={} lane2={}  $21: lane1={}", f0.h, m.mem[0][0x20], m.mem[2][0x20], m.mem[1][0x21]);
            }
        }
    }
}
