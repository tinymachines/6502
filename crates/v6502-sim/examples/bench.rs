use std::time::Instant;
use v6502_sim::boot;
fn main() {
    // Tight loop: INC $20 ; JMP -- continuous ALU, memory and bus activity.
    let mut cpu = boot(0x0200, &[0xe6, 0x20, 0x4c, 0x00, 0x02]);
    let n: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(200_000);
    let t = Instant::now();
    for _ in 0..n { cpu.half_step(); }
    let secs = t.elapsed().as_secs_f64();
    let s = cpu.engine().stats();
    println!("{n} half-cycles in {secs:.3}s");
    println!("  {:.0} half-cycles/s  = {:.2} MHz simulated 6502", n as f64 / secs, (n as f64 / 2.0 / secs) / 1e6);
    println!("  {:.1} node recalcs / half-cycle, {:.1} group members / recalc",
             s.node_recalcs as f64 / n as f64, s.group_members as f64 / s.node_recalcs as f64);
    println!("  {:.2} settle rounds / settle", s.rounds as f64 / s.settles as f64);
    println!("  settles/halfcycle {:.2}, rounds/halfcycle {:.1}", s.settles as f64/n as f64, s.rounds as f64/n as f64);
}
