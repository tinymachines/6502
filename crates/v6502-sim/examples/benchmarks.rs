//! How fast is the chip, on the programs people actually run?
//!
//!     cargo run --release -p v6502-sim --example benchmarks [half-cycles]
//!
//! `bench` measures one tight loop (`INC $20; JMP`). That is a fine smoke
//! test and a bad baseline: tuning against a single workload is how you end
//! up faster at something nobody runs. This runs all seven programs from
//! `web/programs.txt` (written by `tools/export-programs.mjs` from the one
//! program set and the one assembler) and reports the same numbers for each.
//!
//! **Two passes per program, and that is the point.** Counting how many nodes
//! changed means snapshotting 1725 levels every half-cycle and diffing them,
//! which costs more than the work being measured. Doing both in one loop
//! would make the throughput figure a measurement of the instrumentation. So
//! pass one is timed and untouched, pass two is instrumented and untimed.
//!
//! **Timed columns need repeats; counted columns do not.** `hc/s` is measured
//! best-of-N (`REPEAT`, default 3) because noise on a shared machine only ever
//! makes a run slower. Everything else here is a counter and is bit-identical
//! between runs, so one pass is enough. Measured on this box: the spread
//! between the seven programs is about 1.09x against a noise floor of about
//! 1.18x, which is to say **the workload does not matter for throughput** and
//! whichever program looks slowest is a fact about the machine that afternoon.
//! The first version of this reported one run each and confidently named a
//! winner; three repeats named three different ones.
//!
//! The column that matters is **ratio**: node recalcs divided by nodes that
//! actually changed level. The solver queues a node whenever a transistor it
//! terminates on toggles, then discovers by building the group that the level
//! did not move. Measured at about 5:1, and that is where the time goes:
//! at 393,000 instructions a half-cycle this is not memory-bound (IPC 2.04,
//! L1 miss 1.28%), it is doing five times the work it keeps.

use std::time::Instant;
use v6502_sim::boot;
use v6502_sim::bus::FlatMemory;
use v6502_sim::cpu::Cpu;

struct Program {
    short: String,
    org: u16,
    bytes: Vec<u8>,
}

/// Tab-separated, because the alternative is a JSON parser in a workspace
/// that has no dependencies and does not need one for seven lines.
fn load() -> Vec<Program> {
    let explicit = std::env::var("PROGRAMS").ok();
    let candidates = [
        explicit.as_deref().unwrap_or("web/programs.txt"),
        "web/programs.txt",
        "../web/programs.txt",
        "../../web/programs.txt",
    ];
    let text = candidates
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| {
            eprintln!(
                "benchmarks: no web/programs.txt. Run `node tools/export-programs.mjs` \
                 first, or set PROGRAMS=<path>."
            );
            std::process::exit(1);
        });

    let mut out = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        assert!(f.len() >= 3, "malformed line: {line}");
        let bytes: Vec<u8> = (0..f[2].len() / 2)
            .map(|i| u8::from_str_radix(&f[2][i * 2..i * 2 + 2], 16).expect("hex"))
            .collect();
        out.push(Program {
            short: f[0].to_string(),
            org: u16::from_str_radix(f[1], 16).expect("org"),
            bytes,
        });
    }
    out
}

struct Row {
    short: String,
    bytes: usize,
    hc_per_s: f64,
    recalcs: f64,
    changed: f64,
    rounds: f64,
    members: f64,
}

/// Pass one: no instrumentation at all, so what is timed is the solver.
///
/// Called several times per program and the BEST kept, because noise on a
/// shared machine only ever makes a run slower: a scheduler preemption or a
/// neighbouring process cannot make the solver faster than it is. The first
/// version of this reported a single run per program and duly announced that
/// "Copy is slowest", which three repeats showed to be a different program
/// each time. A spread smaller than the noise is not a spread.
fn timed(p: &Program, n: u64) -> (f64, f64, f64, f64) {
    let mut cpu = boot(p.org, &p.bytes);
    // Out of reset before the clock starts. The reset sequence is real work
    // but it is not the program, and at small n it would dominate.
    for _ in 0..64 {
        cpu.half_step();
    }
    let before = *cpu.engine().stats();
    let t = Instant::now();
    for _ in 0..n {
        cpu.half_step();
    }
    let secs = t.elapsed().as_secs_f64();
    let s = *cpu.engine().stats();
    let recalcs = (s.node_recalcs - before.node_recalcs) as f64;
    (
        n as f64 / secs,
        recalcs / n as f64,
        (s.rounds - before.rounds) as f64 / n as f64,
        (s.group_members - before.group_members) as f64 / recalcs.max(1.0),
    )
}

/// Pass two: snapshot and diff every half-cycle. Untimed on purpose.
fn changed_per_half_cycle(p: &Program, n: u64) -> f64 {
    let mut cpu = boot(p.org, &p.bytes);
    for _ in 0..64 {
        cpu.half_step();
    }
    let nl = cpu.engine().netlist().clone();
    let count = nl.node_count();
    let (vss, vcc) = (nl.vss(), nl.vcc());
    let snap = |cpu: &Cpu<FlatMemory>| {
        (0..count as u16).map(|i| cpu.engine().is_high(i)).collect::<Vec<bool>>()
    };
    let mut prev = snap(&cpu);
    let mut total = 0u64;
    for _ in 0..n {
        cpu.half_step();
        let now = snap(&cpu);
        // The rails are excluded for the reason the renderer excludes them:
        // they are not signals, and one of them dipping would be a bug rather
        // than activity. See "a rail is never written" in the model notes.
        total += (0..count as u16)
            .filter(|&i| i != vss && i != vcc && prev[i as usize] != now[i as usize])
            .count() as u64;
        prev = now;
    }
    total as f64 / n as f64
}

fn main() {
    let n: u64 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(20_000);
    // Fewer half-cycles for the diffing pass: it is 1725 reads per step and
    // it is measuring a ratio, which converges long before throughput does.
    let m = (n / 8).clamp(200, 4_000);

    let programs = load();
    println!(
        "{} programs, {n} half-cycles timed, {m} instrumented\n",
        programs.len()
    );
    println!(
        "{:<12} {:>5} {:>10} {:>8} {:>9} {:>9} {:>7} {:>8} {:>8}",
        "program", "bytes", "hc/s", "kHz", "recalc/hc", "chg/hc", "ratio", "rounds", "grp"
    );
    println!("{}", "-".repeat(86));

    let repeats: usize = std::env::var("REPEAT").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    // How much the SAME program varies between identical runs. Any spread
    // between programs has to beat this to mean anything.
    let mut noise: f64 = 1.0;
    let mut rows = Vec::new();
    for p in &programs {
        let mut best = timed(p, n);
        let mut worst_of_p = best.0;
        for _ in 1..repeats {
            let r = timed(p, n);
            worst_of_p = worst_of_p.min(r.0);
            if r.0 > best.0 {
                best = r;
            }
        }
        noise = noise.max(best.0 / worst_of_p);
        let (hc_per_s, recalcs, rounds, members) = best;
        let changed = changed_per_half_cycle(p, m);
        println!(
            "{:<12} {:>5} {:>10.0} {:>8.1} {:>9.0} {:>9.0} {:>6.1}:1 {:>8.1} {:>8.2}",
            p.short,
            p.bytes.len(),
            hc_per_s,
            hc_per_s / 2.0 / 1000.0,
            recalcs,
            changed,
            recalcs / changed.max(1.0),
            rounds,
            members
        );
        rows.push(Row {
            short: p.short.clone(),
            bytes: p.bytes.len(),
            hc_per_s,
            recalcs,
            changed,
            rounds,
            members,
        });
    }

    let mean = |f: &dyn Fn(&Row) -> f64| rows.iter().map(f).sum::<f64>() / rows.len() as f64;
    let slowest = rows.iter().min_by(|a, b| a.hc_per_s.total_cmp(&b.hc_per_s)).unwrap();
    let fastest = rows.iter().max_by(|a, b| a.hc_per_s.total_cmp(&b.hc_per_s)).unwrap();

    println!("{}", "-".repeat(86));
    println!(
        "{:<12} {:>5} {:>10.0} {:>8.1} {:>9.0} {:>9.0} {:>6.1}:1 {:>8.1} {:>8.2}",
        "mean",
        rows.iter().map(|r| r.bytes).sum::<usize>(),
        mean(&|r| r.hc_per_s),
        mean(&|r| r.hc_per_s) / 2.0 / 1000.0,
        mean(&|r| r.recalcs),
        mean(&|r| r.changed),
        mean(&|r| r.recalcs) / mean(&|r| r.changed),
        mean(&|r| r.rounds),
        mean(&|r| r.members),
    );

    let spread = fastest.hc_per_s / slowest.hc_per_s;
    if spread > noise {
        println!(
            "\nspread {spread:.2}x between programs, against a {noise:.2}x noise floor\n\
             measured by re-running one program: {} slowest at {:.0} hc/s, {} fastest at {:.0}",
            slowest.short, slowest.hc_per_s, fastest.short, fastest.hc_per_s
        );
    } else {
        println!(
            "\nall seven run at the same speed: a {spread:.2}x spread between programs\n\
             against a {noise:.2}x noise floor from re-running one of them. Which program\n\
             is 'slowest' changes between runs, so it is a fact about the machine and\n\
             not about the program. The chip does the same fetch, decode and settle\n\
             work whatever the opcode is."
        );
    }
    println!(
        "a real 6502 runs at 1-2 MHz, so this is {:.0}x to {:.0}x slower than the part",
        1_000_000.0 / (mean(&|r| r.hc_per_s) / 2.0),
        2_000_000.0 / (mean(&|r| r.hc_per_s) / 2.0),
    );
    println!(
        "ratio is recalcs per node that actually changed level: {:.0}% of recalcs\n\
         resolve to the value the node already held, and finding that out is what\n\
         building the group costs.",
        100.0 * (1.0 - mean(&|r| r.changed) / mean(&|r| r.recalcs))
    );
}
