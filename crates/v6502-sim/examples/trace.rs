use v6502_sim::boot;
fn main() {
    // LDA #$50 ; CLC ; ADC #$50
    let mut cpu = boot(0x0200, &[0xa9, 0x50, 0x18, 0x69, 0x50, 0xea, 0xea, 0xea]);
    println!("{:>4} {:>5} {:>4} {:>4} {:>4} {:>2} {:>8}  T-states",
             "hcyc", "cycle", "AB", "DB", "sync", "A", "flags");
    for _ in 0..30 {
        let s = cpu.observe();
        println!("{:>4} {:>5} {:04x} {:02x}   {:>4} {:02x} {:>8}  {}",
                 s.half_cycle, s.cycle, s.bus.addr, s.bus.data,
                 s.bus.sync as u8, s.regs.a, s.regs.flags_string(), s.timing.fixed_width());
        cpu.half_step();
    }
}
